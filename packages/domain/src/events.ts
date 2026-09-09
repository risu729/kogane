// Economic events, legs, obligations and settlements (addendum 07). An event
// is an interpretation supported by evidence and a decision, never "a
// transaction row with a category". Nothing here overwrites Layer B: an event
// revision is appended and superseded, so a wrong merge is undone by a new
// revision while the old one stays readable for the reports that cite it
// (addendum 07 section 7, INV01/INV08).
//
// Conservation is checked per unit. Cross-unit legs are reported as such and
// are never forced to sum to zero (SC05), and an unresolved difference is
// always shown rather than absorbed into a fee (INV05).
import {
  checkFillAllocations,
  checkObligationAllocations,
  checkSourceAllocations,
  type Allocation,
  type ConservationError,
  type ConservationResult,
} from "./decisions.ts";
import { hasExactKeys, isOneOf, isRecord, isRefList, isSafeInt, isText } from "./guards.ts";
import { validTemporalValue, type TemporalValue } from "./time.ts";
import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  exactQuantity,
  integerDecimal,
  multiplyDecimals,
  subtractDecimals,
  sumDecimals,
  validQuantity,
  type ExactDecimal,
  type Quantity,
  type Rounding,
  type ValueError,
} from "./values.ts";

/** Immutable reference into Layer B: what was claimed, and in which parse revision. */
export const SOURCE_FACT_KINDS = [
  "transaction",
  "balance",
  "position",
  "valuation",
  "typed-claim",
] as const;
export type SourceFactKind = (typeof SOURCE_FACT_KINDS)[number];
export interface SourceFactRef {
  kind: SourceFactKind;
  id: string;
  /** Immutable parse or claim version; a bare id would not pin what was read. */
  revision: string;
}

export const ECONOMIC_EVENT_KINDS = [
  "purchase",
  "charge",
  "refund",
  "transfer",
  "card_settlement",
  "fee",
  "platform_payout",
  "unknown",
] as const;
export type EconomicEventKind = (typeof ECONOMIC_EVENT_KINDS)[number];

/**
 * State families are per business kind (addendum 07 section 5); there is no
 * single enum for every provider. `unknown` belongs to every family and always
 * carries the reason it is unknown.
 */
export const EVENT_STATE_FAMILIES = {
  purchase: ["proposed", "authorized", "captured", "canceled", "unknown"],
  refund: ["proposed", "authorized", "captured", "canceled", "unknown"],
  charge: ["observed", "issued", "revised", "canceled", "unknown"],
  transfer: ["requested", "debited", "in-transit", "credited", "returned", "unknown"],
  card_settlement: ["requested", "debited", "credited", "returned", "unknown"],
  platform_payout: ["requested", "debited", "in-transit", "credited", "returned", "unknown"],
  fee: ["proposed", "confirmed", "canceled", "unknown"],
  unknown: ["unknown"],
} as const satisfies Record<EconomicEventKind, readonly string[]>;

export const EVENT_STATES = [
  "proposed",
  "authorized",
  "captured",
  "canceled",
  "observed",
  "issued",
  "revised",
  "requested",
  "debited",
  "in-transit",
  "credited",
  "returned",
  "confirmed",
  "unknown",
] as const;
export type EventState = (typeof EVENT_STATES)[number];

/** Allowed successor states per kind. An absent key is a terminal state. */
const EVENT_TRANSITIONS: Record<EconomicEventKind, Partial<Record<EventState, EventState[]>>> = {
  purchase: {
    proposed: ["authorized", "captured", "canceled", "unknown"],
    authorized: ["captured", "canceled", "unknown"],
    captured: ["unknown"],
    unknown: ["proposed", "authorized", "captured", "canceled"],
  },
  refund: {
    proposed: ["authorized", "captured", "canceled", "unknown"],
    authorized: ["captured", "canceled", "unknown"],
    captured: ["unknown"],
    unknown: ["proposed", "authorized", "captured", "canceled"],
  },
  charge: {
    observed: ["issued", "revised", "canceled", "unknown"],
    issued: ["revised", "canceled", "unknown"],
    revised: ["revised", "canceled", "unknown"],
    unknown: ["observed", "issued", "revised", "canceled"],
  },
  transfer: {
    requested: ["debited", "returned", "unknown"],
    debited: ["in-transit", "credited", "returned", "unknown"],
    "in-transit": ["credited", "returned", "unknown"],
    credited: ["unknown"],
    unknown: ["requested", "debited", "in-transit", "credited", "returned"],
  },
  card_settlement: {
    requested: ["debited", "returned", "unknown"],
    debited: ["credited", "returned", "unknown"],
    credited: ["unknown"],
    unknown: ["requested", "debited", "credited", "returned"],
  },
  platform_payout: {
    requested: ["debited", "in-transit", "returned", "unknown"],
    debited: ["in-transit", "credited", "returned", "unknown"],
    "in-transit": ["credited", "returned", "unknown"],
    credited: ["unknown"],
    unknown: ["requested", "debited", "in-transit", "credited", "returned"],
  },
  fee: {
    proposed: ["confirmed", "canceled", "unknown"],
    confirmed: ["unknown"],
    unknown: ["proposed", "confirmed", "canceled"],
  },
  unknown: { unknown: [] },
};

/** Why a state could not be decided; an unknown state without a reason is invalid. */
export const UNKNOWN_STATE_REASONS = [
  "provider_status_absent",
  "provider_status_unmapped",
  "conflicting_evidence",
  "evidence_out_of_scope",
  "kind_undecided",
] as const;
export type UnknownStateReason = (typeof UNKNOWN_STATE_REASONS)[number];

export type StateTransitionResult =
  | { ok: true }
  | { ok: false; reasonCode: "state_not_in_family" | "transition_not_defined" | "terminal_state" };

/**
 * Whether one event revision may follow another for the same event id. A
 * provider status that maps to nothing becomes `unknown` with a reason rather
 * than being squeezed into a neighbouring state.
 */
export function eventTransition(
  kind: EconomicEventKind,
  from: EventState,
  to: EventState,
): StateTransitionResult {
  const family: readonly string[] = EVENT_STATE_FAMILIES[kind];
  if (!family.includes(from) || !family.includes(to))
    return { ok: false, reasonCode: "state_not_in_family" };
  const successors = EVENT_TRANSITIONS[kind][from];
  if (successors === undefined || successors.length === 0)
    return { ok: false, reasonCode: "terminal_state" };
  return successors.includes(to)
    ? { ok: true }
    : { ok: false, reasonCode: "transition_not_defined" };
}

/**
 * Which reading a value belongs to. A purchase cost and the cash that leaves an
 * account are different figures for the same purchase (SC02, SC04), so the
 * basis is stored with the leg and returned with every read model.
 */
export const RECOGNITION_BASES = [
  "cash-movement",
  "purchase-recognition",
  "obligation-change",
  "trade-date",
  "settlement-date",
  "unknown",
] as const;
export type RecognitionBasis = (typeof RECOGNITION_BASES)[number];

export const LEG_ROLES = ["increase", "decrease", "fee", "unresolved"] as const;
export type LegRole = (typeof LEG_ROLES)[number];

/** One economic movement or claim of an event: who, which unit, how much, in which role. */
export interface EconomicLeg {
  eventId: string;
  revision: number;
  legIndex: number;
  /** `account:…` or `claim:…`; a payment instrument is not an account (addendum 05 section 2). */
  subjectRef: string;
  quantity: Quantity;
  role: LegRole;
  basis: RecognitionBasis;
}

export interface EconomicEventRevision {
  eventId: string;
  revision: number;
  kind: EconomicEventKind;
  state: EventState;
  /** Required exactly when `state` is `unknown`. */
  unknownReason: UnknownStateReason | null;
  effectiveTime: TemporalValue;
  basis: RecognitionBasis;
  evidenceSupport: SourceFactRef[];
  decisionRevisionRef: string;
  /** `eventId@revision` of the revision that replaced this one; null while current. */
  supersededBy: string | null;
  legs: EconomicLeg[];
}

export const OBLIGATION_STATES = [
  "open",
  "partially-settled",
  "settled",
  "disputed",
  "unknown",
] as const;
export type ObligationState = (typeof OBLIGATION_STATES)[number];

/** A named amount beside the principal; `confirmed` separates an incurred fee from a planned one (SC04). */
export interface ObligationComponent {
  code: string;
  quantity: Quantity;
  confirmed: boolean;
}

export interface ObligationScheduleEntry {
  sequence: number;
  due: TemporalValue;
  principal: Quantity;
  fee: Quantity | null;
  status: "confirmed" | "projected";
}

export interface ObligationRevision {
  obligationId: string;
  revision: number;
  creditorRef: string;
  debtorRef: string;
  principal: Quantity;
  feeComponents: ObligationComponent[];
  schedule: ObligationScheduleEntry[];
  state: ObligationState;
  unknownReason: UnknownStateReason | null;
  /** Why the state is what it is; an obligation is never inferred from a statement total. */
  stateEvidenceRefs: string[];
  decisionRevisionRef: string;
  supersededBy: string | null;
}

/** N-to-M settlement: one payment component may settle several obligations and vice versa. */
export interface SettlementRelation {
  settlementId: string;
  obligationId: string;
  /** The paying component: an event leg (`leg:…`) or a source fact (`obs:…`). */
  settlementComponentRef: string;
  allocated: Quantity;
  occurred: TemporalValue;
  /** Kept visible; never folded into the principal or into a fee. */
  unresolvedDifference: Quantity | null;
  decisionRevisionRef: string;
}

const REF = (value: unknown, max = 512): value is string => isText(value, max);

export function validSourceFactRef(value: unknown): value is SourceFactRef {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "id", "revision"]) &&
    isOneOf(SOURCE_FACT_KINDS)(value.kind) &&
    REF(value.id) &&
    isText(value.revision, 256)
  );
}

export function validEconomicLeg(value: unknown): value is EconomicLeg {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "eventId",
      "revision",
      "legIndex",
      "subjectRef",
      "quantity",
      "role",
      "basis",
    ]) &&
    isText(value.eventId, 256) &&
    isSafeInt(value.revision, 1) &&
    isSafeInt(value.legIndex, 0) &&
    REF(value.subjectRef) &&
    validQuantity(value.quantity) &&
    isOneOf(LEG_ROLES)(value.role) &&
    isOneOf(RECOGNITION_BASES)(value.basis)
  );
}

/** A state must belong to its own family, and `unknown` must say why (addendum 07 section 5). */
function validStatePair(family: readonly string[], state: unknown, reason: unknown): boolean {
  if (typeof state !== "string" || !family.includes(state)) return false;
  return state === "unknown" ? isOneOf(UNKNOWN_STATE_REASONS)(reason) : reason === null;
}

export function validEconomicEventRevision(value: unknown): value is EconomicEventRevision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "eventId",
      "revision",
      "kind",
      "state",
      "unknownReason",
      "effectiveTime",
      "basis",
      "evidenceSupport",
      "decisionRevisionRef",
      "supersededBy",
      "legs",
    ]) ||
    !isText(value.eventId, 256) ||
    !isSafeInt(value.revision, 1) ||
    !isOneOf(ECONOMIC_EVENT_KINDS)(value.kind) ||
    !validStatePair(EVENT_STATE_FAMILIES[value.kind], value.state, value.unknownReason) ||
    !validTemporalValue(value.effectiveTime) ||
    !isOneOf(RECOGNITION_BASES)(value.basis) ||
    !Array.isArray(value.evidenceSupport) ||
    !value.evidenceSupport.every(validSourceFactRef) ||
    !isText(value.decisionRevisionRef, 256) ||
    !(value.supersededBy === null || isText(value.supersededBy, 512)) ||
    !Array.isArray(value.legs) ||
    !value.legs.every(validEconomicLeg)
  )
    return false;
  // An event with no supporting evidence is an assertion, not an interpretation.
  return (
    value.evidenceSupport.length > 0 &&
    value.legs.every((leg) => leg.eventId === value.eventId && leg.revision === value.revision) &&
    new Set(value.legs.map((leg) => leg.legIndex)).size === value.legs.length
  );
}

export function validObligationComponent(value: unknown): value is ObligationComponent {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "quantity", "confirmed"]) &&
    isText(value.code, 128) &&
    validQuantity(value.quantity) &&
    typeof value.confirmed === "boolean"
  );
}

export function validObligationScheduleEntry(value: unknown): value is ObligationScheduleEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sequence", "due", "principal", "fee", "status"]) &&
    isSafeInt(value.sequence, 1) &&
    validTemporalValue(value.due) &&
    validQuantity(value.principal) &&
    (value.fee === null || validQuantity(value.fee)) &&
    (value.status === "confirmed" || value.status === "projected")
  );
}

export function validObligationRevision(value: unknown): value is ObligationRevision {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "obligationId",
      "revision",
      "creditorRef",
      "debtorRef",
      "principal",
      "feeComponents",
      "schedule",
      "state",
      "unknownReason",
      "stateEvidenceRefs",
      "decisionRevisionRef",
      "supersededBy",
    ]) &&
    isText(value.obligationId, 256) &&
    isSafeInt(value.revision, 1) &&
    REF(value.creditorRef) &&
    REF(value.debtorRef) &&
    value.creditorRef !== value.debtorRef &&
    validQuantity(value.principal) &&
    Array.isArray(value.feeComponents) &&
    value.feeComponents.every(validObligationComponent) &&
    Array.isArray(value.schedule) &&
    value.schedule.every(validObligationScheduleEntry) &&
    validStatePair(OBLIGATION_STATES, value.state, value.unknownReason) &&
    isRefList(value.stateEvidenceRefs) &&
    isText(value.decisionRevisionRef, 256) &&
    (value.supersededBy === null || isText(value.supersededBy, 512))
  );
}

export function validSettlementRelation(value: unknown): value is SettlementRelation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "settlementId",
      "obligationId",
      "settlementComponentRef",
      "allocated",
      "occurred",
      "unresolvedDifference",
      "decisionRevisionRef",
    ]) &&
    isText(value.settlementId, 256) &&
    isText(value.obligationId, 256) &&
    REF(value.settlementComponentRef) &&
    validQuantity(value.allocated) &&
    validTemporalValue(value.occurred) &&
    (value.unresolvedDifference === null || validQuantity(value.unresolvedDifference)) &&
    isText(value.decisionRevisionRef, 256)
  );
}

// ---------------------------------------------------------------------------
// Conservation
// ---------------------------------------------------------------------------

export interface UnitConservation {
  unitRef: string;
  decrease: Quantity;
  increase: Quantity;
  fees: Quantity;
  /** `decrease − increase − fees` in this unit. Reported, never absorbed. */
  difference: Quantity;
}

export const CONSERVATION_REASON_CODES = [
  "cross_unit_requires_fx_model",
  "unresolved_legs_present",
  "single_unit_balanced",
] as const;
export type ConservationReasonCode = (typeof CONSERVATION_REASON_CODES)[number];

export type ConservationCheckResult =
  | {
      ok: true;
      crossUnit: boolean;
      units: UnitConservation[];
      /** The declared or computed gap of a single-unit event; null for a cross-unit one. */
      unresolvedDifference: Quantity | null;
      reasonCodes: ConservationReasonCode[];
    }
  | { ok: false; error: ValueError | ConservationError };

function exactOf(quantity: Quantity): ExactDecimal | null {
  return quantity.value.status === "exact" ? quantity.value.value : null;
}

/**
 * `source decrease = destination increase + explicit fee + unresolved difference`
 * for the legs of one event, checked **per unit**. When the legs span more than
 * one unit the sums are returned side by side with
 * `cross_unit_requires_fx_model`: signed amounts in different units are never
 * added and never forced to zero (SC05: 1,005 AUD against 95,000 JPY).
 */
export function conservationCheck(input: {
  legs: readonly EconomicLeg[];
  /** Declared gap for a single-unit event; the computed gap must equal it. */
  unresolvedDifference?: Quantity | null;
}): ConservationCheckResult {
  const absent = input.legs
    .filter((leg) => leg.quantity.value.status !== "exact")
    .map((leg) =>
      leg.quantity.value.status === "exact"
        ? ""
        : `${leg.role}:${leg.quantity.value.status}:${leg.quantity.value.reasonCode}`,
    );
  if (absent.length > 0)
    return {
      ok: false,
      error: {
        code: "value_not_exact",
        message: "a leg without an exact amount is never treated as zero",
        refs: absent,
      },
    };
  const units = new Map<string, UnitConservation>();
  const zero = integerDecimal(0);
  const sums = new Map<
    string,
    { decrease: ExactDecimal; increase: ExactDecimal; fees: ExactDecimal }
  >();
  for (const leg of input.legs) {
    const amount = exactOf(leg.quantity)!;
    const entry = sums.get(leg.quantity.unitRef) ?? { decrease: zero, increase: zero, fees: zero };
    if (leg.role === "decrease") entry.decrease = addDecimals(entry.decrease, amount);
    else if (leg.role === "increase") entry.increase = addDecimals(entry.increase, amount);
    else if (leg.role === "fee") entry.fees = addDecimals(entry.fees, amount);
    sums.set(leg.quantity.unitRef, entry);
  }
  for (const [unitRef, entry] of [...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const difference = subtractDecimals(
      subtractDecimals(entry.decrease, entry.increase),
      entry.fees,
    );
    units.set(unitRef, {
      unitRef,
      decrease: exactQuantity(unitRef, entry.decrease),
      increase: exactQuantity(unitRef, entry.increase),
      fees: exactQuantity(unitRef, entry.fees),
      difference: exactQuantity(unitRef, difference),
    });
  }
  const reasonCodes: ConservationReasonCode[] = [];
  if (input.legs.some((leg) => leg.role === "unresolved"))
    reasonCodes.push("unresolved_legs_present");
  const rows = [...units.values()];
  if (rows.length > 1)
    return {
      ok: true,
      crossUnit: true,
      units: rows,
      unresolvedDifference: null,
      reasonCodes: ["cross_unit_requires_fx_model", ...reasonCodes],
    };
  const only = rows[0];
  if (!only)
    return {
      ok: false,
      error: {
        code: "conservation_violated",
        message: "an event with no legs conserves nothing",
        refs: [],
        difference: null,
      },
    };
  const declared = input.unresolvedDifference ?? null;
  if (declared !== null && declared.unitRef !== only.unitRef)
    return {
      ok: false,
      error: {
        code: "unit_mismatch",
        message: "the declared unresolved difference is in another unit",
        refs: [only.unitRef, declared.unitRef],
      },
    };
  const declaredValue = declared === null ? zero : exactOf(declared);
  if (declaredValue === null)
    return {
      ok: false,
      error: {
        code: "value_not_exact",
        message: "the declared unresolved difference must be exact",
        refs: [only.unitRef],
      },
    };
  const gap = exactOf(only.difference)!;
  if (compareDecimals(gap, declaredValue) !== 0)
    return {
      ok: false,
      error: {
        code: "conservation_violated",
        message: "legs do not balance; declare the unresolved difference explicitly",
        refs: [only.unitRef],
        difference: only.difference,
      },
    };
  return {
    ok: true,
    crossUnit: false,
    units: rows,
    unresolvedDifference: only.difference,
    reasonCodes: [...reasonCodes, "single_unit_balanced"],
  };
}

/** `sum(fill quantities) ≤ executed quantity` for one order revision. */
export function splitFillCheck(input: {
  executedQuantity: Quantity;
  fills: readonly Allocation[];
}): ConservationResult<{ allocated: Quantity; remaining: Quantity }> {
  return checkFillAllocations(input);
}

export interface SettlementCheckOutcome {
  allocated: Quantity;
  remaining: Quantity;
  state: ObligationState;
  /** Differences the settlements themselves declared; never netted into `remaining`. */
  unresolvedDifferences: Quantity[];
}

/**
 * `sum(allocations to an obligation) ≤ eligible outstanding`. The resulting
 * state comes from what was actually allocated; a successful payment alone
 * never decides the remaining principal (SC04).
 */
export function settlementCheck(input: {
  outstanding: Quantity;
  settlements: readonly SettlementRelation[];
}): ConservationResult<SettlementCheckOutcome> {
  const allocations: Allocation[] = input.settlements.map((settlement) => ({
    allocationId: settlement.settlementId,
    sourceRef: settlement.settlementComponentRef,
    targetRef: `obligation:${settlement.obligationId}`,
    role: "settlement",
    quantity: settlement.allocated,
  }));
  const checked = checkObligationAllocations({ outstanding: input.outstanding, allocations });
  if (!checked.ok) return checked;
  const remaining = exactOf(checked.remaining)!;
  const allocated = exactOf(checked.allocated)!;
  const state: ObligationState =
    remaining.coefficient === "0"
      ? "settled"
      : allocated.coefficient === "0"
        ? "open"
        : "partially-settled";
  return {
    ok: true,
    allocated: checked.allocated,
    remaining: checked.remaining,
    state,
    unresolvedDifferences: input.settlements.flatMap((settlement) =>
      settlement.unresolvedDifference === null ? [] : [settlement.unresolvedDifference],
    ),
  };
}

export const REFUND_EXCEPTION_CODES = ["over_refund", "refund_target_unknown"] as const;
export type RefundExceptionCode = (typeof REFUND_EXCEPTION_CODES)[number];
export interface RefundException {
  code: RefundExceptionCode;
  /** The provider fact kept out of the normal allocation, never discarded. */
  quantity: Quantity;
  refs: string[];
}

export interface RefundAllocationOutcome {
  allocated: Quantity;
  /** `purchase − allocated`; never negative, because an over-refund is an exception. */
  net: Quantity;
  exceptions: RefundException[];
}

/**
 * Refunds allocated against one purchase. Refunds whose counterpart is unknown
 * stay unallocated and visible; an over-refund is reported as its own exception
 * with the excess amount instead of being absorbed into the purchase (SC03,
 * UC17). A vanished pending row never becomes a refund: it is simply not an
 * input here.
 */
export function refundAllocation(input: {
  purchase: Quantity;
  refunds: readonly Allocation[];
  /** Observed refunds with no accepted target; reported, not allocated. */
  unallocatedRefunds?: readonly Quantity[];
}): ConservationResult<RefundAllocationOutcome> {
  const wrongRole = input.refunds.filter((refund) => refund.role !== "refund");
  if (wrongRole.length > 0)
    return {
      ok: false,
      error: {
        code: "conservation_violated",
        message: "only refund allocations are netted against a purchase",
        refs: wrongRole.map((refund) => refund.allocationId),
        difference: null,
      },
    };
  const total = checkSourceAllocations({
    sourceAmount: input.purchase,
    allocations: input.refunds,
  });
  const exceptions: RefundException[] = (input.unallocatedRefunds ?? []).map((quantity) => ({
    code: "refund_target_unknown",
    quantity,
    refs: [],
  }));
  if (total.ok)
    return {
      ok: true,
      allocated: total.allocated,
      net: total.remaining,
      exceptions,
    };
  // `allocation_exceeds_limit` is the over-refund case: keep the fact, cap the
  // normal allocation at the purchase, and report the excess separately.
  if (total.error.code !== "allocation_exceeds_limit") return total;
  const excess = total.error.difference;
  if (excess === null) return total;
  const excessValue = exactOf(excess);
  if (excessValue === null) return total;
  return {
    ok: true,
    allocated: input.purchase,
    net: exactQuantity(input.purchase.unitRef, integerDecimal(0)),
    exceptions: [
      ...exceptions,
      {
        code: "over_refund",
        quantity: exactQuantity(excess.unitRef, subtractDecimals(integerDecimal(0), excessValue)),
        refs: input.refunds.map((refund) => refund.allocationId),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Cross-currency comparison (SC05 / UC20 / UC21)
// ---------------------------------------------------------------------------

export interface EffectiveRate {
  /** `received per unit of principal`, written as `<received>/<principal>`. */
  unitRef: string;
  value: ExactDecimal;
}

/**
 * Effective rate of an exchange: received ÷ the principal that was exchanged.
 * The explicit fee is not part of the principal, so a fee never disappears into
 * the rate (SC05: 95,000 JPY ÷ 1,000 AUD = 95, with 5 AUD fee kept separate).
 */
export function effectiveRate(input: {
  principal: Quantity;
  received: Quantity;
  rounding?: Rounding;
}): { ok: true; rate: EffectiveRate } | { ok: false; error: ValueError } {
  const principal = exactOf(input.principal);
  const received = exactOf(input.received);
  if (principal === null || received === null)
    return {
      ok: false,
      error: {
        code: "value_not_exact",
        message: "an effective rate needs two exact amounts",
        refs: [input.principal.unitRef, input.received.unitRef],
      },
    };
  const divided = input.rounding
    ? divideDecimals(received, principal, input.rounding)
    : divideDecimals(received, principal);
  if (!divided.ok) return divided;
  return {
    ok: true,
    rate: { unitRef: `${input.received.unitRef}/${input.principal.unitRef}`, value: divided.value },
  };
}

export interface ReferenceDifference {
  /** Deliberately not `fee`: this is a comparison against a stored quote. */
  kind: "estimate";
  method: string;
  quantity: Quantity;
  referenceRef: string;
}

/**
 * Difference between what a stored reference quote would have produced and what
 * was received. It is an estimate of the chosen comparison method, never a fee
 * the provider charged and never an obligation (UC21, SC05: 2,000 JPY).
 */
export function referenceQuoteDifference(input: {
  principal: Quantity;
  referenceRate: ExactDecimal;
  received: Quantity;
  referenceRef: string;
  method?: string;
}): { ok: true; difference: ReferenceDifference } | { ok: false; error: ValueError } {
  const principal = exactOf(input.principal);
  const received = exactOf(input.received);
  if (principal === null || received === null)
    return {
      ok: false,
      error: {
        code: "value_not_exact",
        message: "a reference difference needs two exact amounts",
        refs: [input.principal.unitRef, input.received.unitRef],
      },
    };
  const expected = multiplyDecimals(principal, input.referenceRate);
  return {
    ok: true,
    difference: {
      kind: "estimate",
      method: input.method ?? "reference-quote-difference",
      quantity: exactQuantity(input.received.unitRef, subtractDecimals(expected, received)),
      referenceRef: input.referenceRef,
    },
  };
}

/**
 * Sum of the legs of one event that belong to one basis and unit. Used by the
 * read models so a cash-out figure and a purchase-recognition figure are never
 * produced by the same sum (SC02, SC04).
 */
export function legTotal(
  legs: readonly EconomicLeg[],
  filter: { unitRef: string; basis?: RecognitionBasis; role?: LegRole },
): { ok: true; quantity: Quantity } | { ok: false; error: ValueError } {
  const selected = legs.filter(
    (leg) =>
      leg.quantity.unitRef === filter.unitRef &&
      (filter.basis === undefined || leg.basis === filter.basis) &&
      (filter.role === undefined || leg.role === filter.role),
  );
  const values: ExactDecimal[] = [];
  for (const leg of selected) {
    const value = exactOf(leg.quantity);
    if (value === null)
      return {
        ok: false,
        error: {
          code: "value_not_exact",
          message: "a leg without an exact amount is never treated as zero",
          refs: [`${leg.eventId}#${leg.legIndex}`],
        },
      };
    values.push(value);
  }
  return { ok: true, quantity: exactQuantity(filter.unitRef, sumDecimals(values)) };
}
