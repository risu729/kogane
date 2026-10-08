// Lots, acquisition history and disposal allocation over a provisional input
// contract (issue #556, ADR 0051). Pure, synchronous and deterministic: no
// I/O, no clock, and the same inputs in any order give the same result.
//
// What this module is not, stated so nobody reads more into it:
//
//   - It is not the mapping from economic events or observations to lots.
//     That hand-off contract is not decided, so every input carries the
//     provisional tag `provisional-lot-input-v0` and an adapter that produces
//     it does not exist yet.
//   - It does not move lots between holders. A `transfer` input refuses its
//     book with `transfer_contract_pending`.
//   - It never computes a realized gain and never concludes anything about
//     tax. A `tax` purpose is refused through the unchanged `costBasis()` gate.
//   - It never seeds a lot cost from a provider-stated acquisition cost. A
//     snapshot with no history behind it becomes a lot of unknown cost.
//
// Every amount is an exact decimal. A missing or inexact value is a typed
// reason, never zero (INV05); amounts in different units are never added
// (INV03); a unit price is never stored, rounded or not.
import {
  costBasis,
  INSTRUMENT_CLASSES,
  validRoundingPolicy,
  type InstrumentClass,
  type ResultPartition,
  type RoundingInputs,
  type RoundingPolicy,
} from "./calculation.ts";
import { hasExactKeys, isArrayOf, isOneOf, isRecord, isSafeInt, isText } from "./guards.ts";
import {
  compareTemporal,
  daysFromCivil,
  parseInstant,
  parseLocalDate,
  periodBounds,
  validTemporalValue,
  type TemporalValue,
} from "./time.ts";
import {
  addDecimals,
  alignScales,
  compareDecimals,
  decimalEquals,
  exactQuantity,
  integerDecimal,
  isZeroDecimal,
  multiplyByRatio,
  multiplyDecimals,
  negateDecimal,
  subtractDecimals,
  validExactDecimal,
  validExactRatio,
  validQuantity,
  type ExactDecimal,
  type ExactRatio,
  type Quantity,
} from "./values.ts";

/** The provisional input contract. A later, decided contract gets a new tag. */
export const LOT_INPUT_CONTRACT = "provisional-lot-input-v0";
/** Version of the allocation rules in this module; part of every manifest. */
export const LOT_ENGINE_VERSION = "lot-engine-v0";

export const LOT_INPUT_KINDS = [
  "acquisition",
  "disposal",
  "split",
  "snapshot",
  "transfer",
] as const;
export type LotInputKind = (typeof LOT_INPUT_KINDS)[number];

export const LOT_OBSERVATION_FACT_KINDS = ["position", "transaction", "valuation"] as const;
export type LotObservationFactKind = (typeof LOT_OBSERVATION_FACT_KINDS)[number];

/**
 * A pinned reference: an event at one revision, or an observation in one parse
 * run (optionally one JSON path inside it). A bare id would not say what was
 * read. Text forms: `event:<id>@<revision>` and
 * `<factKind>:<observation id>@parse_run:<parse run id>[#<jsonPath>]`.
 */
export type LotInputRef =
  | { source: "event"; eventId: string; revision: number }
  | {
      source: "observation";
      factKind: LotObservationFactKind;
      observationId: number;
      parseRunId: number;
      jsonPath: string | null;
    };

/** `rate` units of `toUnit` per one unit of `fromUnit`, as the input states it, with where it came from. */
export interface LotFxRate {
  rate: ExactDecimal;
  fromUnit: string;
  toUnit: string;
  rateRef: string;
}

/**
 * The time of an input on both bases. The policy's `timeBasis` picks one; an
 * input whose time on that basis is not stated carries `{ kind: "unknown" }`
 * and its book is indeterminate. For a snapshot it is the inclusion boundary:
 * the holding includes every trade (or settlement) up to that time.
 */
export interface LotInputTimes {
  trade: TemporalValue;
  settlement: TemporalValue;
}

/** Specific identification: which lot a disposal takes, and how much of it. */
export interface LotSelection {
  lotId: string;
  quantity: Quantity;
}

/**
 * One input, one book (`holderRef` × `instrumentRef` × `wrapperKey`). The
 * wrapper key is opaque to this module: the caller says which holdings of one
 * instrument in one account form separate books (a tax wrapper, a pocket), and
 * the engine only compares it for equality. Field meaning by kind:
 *
 *   acquisition — `quantity` acquired (> 0); `consideration` paid (≥ 0) or
 *                 null when not known; `fees` the complete list of
 *                 acquisition fees (empty = the evidence states none).
 *   disposal    — `quantity` disposed (> 0); `consideration` received or
 *                 null; `fees` the disposal fees; `lotSelections` read only
 *                 under specific identification.
 *   split       — `split` the exact ratio new/old (> 0); `quantity` the
 *                 holding the evidence states after it, checked against the
 *                 scaled lots.
 *   snapshot    — `quantity` the holding the evidence states. A snapshot never
 *                 carries a cost: `consideration` is null.
 *   transfer    — held: the book is refused with `transfer_contract_pending`.
 *
 * `quantity.unitRef` is the instrument; `fx` converts the input's own amounts
 * under `convert-at-input-rate` and is not read under `lot-currency`.
 */
export interface LotInput {
  contract: typeof LOT_INPUT_CONTRACT;
  ref: LotInputRef;
  kind: LotInputKind;
  holderRef: string;
  instrumentRef: string;
  wrapperKey: string;
  instrumentClass: InstrumentClass;
  time: LotInputTimes;
  quantity: Quantity;
  consideration: Quantity | null;
  fees: Quantity[];
  fx: LotFxRate | null;
  split: ExactRatio | null;
  lotSelections: LotSelection[] | null;
}

export const LOT_PURPOSES = ["investment-analysis", "tax"] as const;
export type LotPurpose = (typeof LOT_PURPOSES)[number];
export const LOT_METHODS = ["fifo", "moving-average", "specific-identification"] as const;
export type LotMethod = (typeof LOT_METHODS)[number];
export const LOT_ACQUISITION_FEE_MODES = ["capitalize", "exclude"] as const;
export type LotAcquisitionFeeMode = (typeof LOT_ACQUISITION_FEE_MODES)[number];
export const LOT_DISPOSAL_FEE_MODES = ["reduce-proceeds", "separate"] as const;
export type LotDisposalFeeMode = (typeof LOT_DISPOSAL_FEE_MODES)[number];
export const LOT_FX_MODES = ["lot-currency", "convert-at-input-rate"] as const;
export type LotFxMode = (typeof LOT_FX_MODES)[number];
/** What one book is. Only one scope exists: holder × instrument × caller-supplied wrapper key. */
export const LOT_SCOPES = ["holder-instrument-wrapper"] as const;
export type LotScope = (typeof LOT_SCOPES)[number];
export const LOT_TIME_BASES = ["trade-date", "settlement-date"] as const;
export type LotTimeBasis = (typeof LOT_TIME_BASES)[number];
/**
 * How inputs are ordered. Only one rule exists: by economic time on the
 * policy's basis, and anything that time does not order is indeterminate.
 * No id, ref, revision or recorded-at time ever decides an economic order.
 */
export const LOT_ORDERING_RULES = ["temporal-then-indeterminate"] as const;
export type LotOrderingRule = (typeof LOT_ORDERING_RULES)[number];

/**
 * Every choice is an explicit input; none has a default: the method, the book
 * scope, the time basis, the ordering rule, fee and FX treatment with the FX
 * policy version (`fxPolicyRef`), and rounding. `costUnitRef` is set
 * exactly when amounts are converted (`convert-at-input-rate`). A rounding
 * policy, when given, rounds each partial allocation (`where: "leg"`) and the
 * last consumption of a lot carries the exact remainder (`residual: "carry"`);
 * any other rounding policy is refused rather than reinterpreted.
 */
export interface LotPolicy {
  policyId: string;
  version: number;
  purpose: LotPurpose;
  method: LotMethod;
  scope: LotScope;
  timeBasis: LotTimeBasis;
  ordering: LotOrderingRule;
  acquisitionFee: LotAcquisitionFeeMode;
  disposalFee: LotDisposalFeeMode;
  fx: LotFxMode;
  fxPolicyRef: string;
  costUnitRef: string | null;
  rounding: RoundingPolicy | null;
}

/** Long spot holdings of these classes only; margin, derivatives and the rest are refused per book. */
export const LOT_SUPPORTED_INSTRUMENT_CLASSES = [
  "listed-equity",
  "fund-unit",
  "crypto-asset",
] as const satisfies readonly InstrumentClass[];

/** Whole-run refusals first, then the two that refuse one book. */
export const LOT_REFUSAL_CODES = [
  "policy_missing",
  "tax_rules_unverified",
  "invalid_input",
  "duplicate_ref",
  "same_event_revisions",
  "same_observation_parse_runs",
  "transfer_contract_pending",
  "unsupported_instrument",
] as const;
export type LotRefusalCode = (typeof LOT_REFUSAL_CODES)[number];
export type LotBookRefusalCode = Extract<
  LotRefusalCode,
  "transfer_contract_pending" | "unsupported_instrument"
>;

/** Why a disposal is limited or indeterminate, or why a book stopped being determinate. */
export const LOT_REASON_CODES = [
  "order_tie",
  "unknown_time",
  "negative_holding",
  "unknown_cost",
  "unknown_acquisition_fee",
  "unknown_proceeds",
  "snapshot_mismatch",
  "unknown_lot",
  "lot_selection_missing",
  "lot_selection_mismatch",
  "inexact_allocation",
  "fx_rate_missing",
  "unit_mismatch",
  "value_not_exact",
  "corporate_action_unsupported",
  "upstream_indeterminate",
] as const;
export type LotReasonCode = (typeof LOT_REASON_CODES)[number];

/** Why an amount (a cost, a fee total, proceeds) is not known. */
export const LOT_AMOUNT_UNKNOWN_REASONS = [
  "snapshot_only",
  "consideration_missing",
  "fee_unknown",
  "fx_rate_missing",
  "unit_mismatch",
] as const;
export type LotAmountUnknownReason = (typeof LOT_AMOUNT_UNKNOWN_REASONS)[number];

export type LotAmount =
  | { status: "known"; amount: Quantity }
  | { status: "unknown"; reasonCode: LotAmountUnknownReason };

/** One split applied to a lot's quantity: the input that applied it and the ratio new/old. */
export interface LotSplitStep {
  splitRef: string;
  ratio: ExactRatio;
}

/**
 * Where a lot's quantity and cost came from. Today every lot originates in
 * this book (an acquisition, a history-less snapshot or a moving-average
 * pool) and `fragmentOf` is always null. The field is reserved so that a lot
 * carried in by a transfer can name its origin, original acquisition time,
 * original cost unit and the lot it was split from without a type change;
 * transfers themselves are refused until their contract is decided.
 */
export interface LotLineage {
  originRef: string;
  originAcquiredAt: TemporalValue | null;
  /** Unit of the cost at origin; null when the cost is unknown. */
  originCostUnit: string | null;
  fragmentOf: string | null;
  /** Every split applied to the remainder since origin, in order: the quantity basis of earlier allocations. */
  splits: LotSplitStep[];
}

/**
 * One lot. Under FIFO and specific identification a lot is one acquisition
 * (`lotId` is its ref text) or one history-less snapshot; under moving average
 * it is the pool since the holding was last empty (`lotId` `pool:<first ref>`,
 * `acquiredAt` null). `quantity` and `cost` are what entered the lot,
 * `quantity` in the units of entry; `remainingQuantity` is in the units after
 * every split in `lineage.splits`, which apply only to what was left when
 * each split happened. `remaining*` is what is left after the allocations.
 */
export interface LotState {
  lotId: string;
  acquisitionRefs: string[];
  acquiredAt: TemporalValue | null;
  quantity: Quantity;
  remainingQuantity: Quantity;
  cost: LotAmount;
  remainingCost: LotAmount;
  /** Null when no acquisition fee was stated. Included in `cost` under `capitalize`, beside it under `exclude`. */
  acquisitionFees: LotAmount | null;
  remainingAcquisitionFees: LotAmount | null;
  fxBasis: LotFxRate[];
  lineage: LotLineage;
}

export interface LotAllocation {
  lotId: string;
  acquisitionRefs: string[];
  /** In the lot's units at the time of the disposal; `lineage.splits` of the lot says what came later. */
  quantity: Quantity;
  cost: LotAmount;
  acquisitionFees: LotAmount | null;
  fxBasis: LotFxRate[];
  /** Operands and policy of each rounded share; null where the share was exact or the whole remainder. */
  roundingInputs: { cost: RoundingInputs | null; acquisitionFees: RoundingInputs | null };
}

export const LOT_DISPOSAL_OUTCOMES = ["allocated", "limited", "indeterminate"] as const;
export type LotDisposalOutcome = (typeof LOT_DISPOSAL_OUTCOMES)[number];

/**
 * `allocated`: every unit came from a lot and cost, acquisition fees,
 * proceeds and disposal fees are all known. `limited`: every unit came from a lot, but something is unknown or
 * not summable (the reasons say what). `indeterminate`: no allocation at all.
 * There is no gain field: cost and proceeds are reported side by side.
 */
export interface LotDisposal {
  disposalRef: string;
  /** The disposal's time on the policy's basis. */
  time: TemporalValue;
  quantity: Quantity;
  allocations: LotAllocation[];
  /** Sum of the allocated costs; null when one is unknown or they are in different units. */
  allocatedCost: Quantity | null;
  /** Net of disposal fees under `reduce-proceeds`, gross under `separate`. */
  proceeds: LotAmount;
  disposalFees: LotAmount | null;
  fxBasis: LotFxRate | null;
  outcome: LotDisposalOutcome;
  reasonCodes: LotReasonCode[];
}

export type LotBook =
  | {
      status: "computed";
      holderRef: string;
      instrumentRef: string;
      wrapperKey: string;
      instrumentClass: InstrumentClass;
      disposals: LotDisposal[];
      /** Null once the book is indeterminate: what is left is then not known. */
      remainingLots: LotState[] | null;
      /**
       * The input, or the group of inputs that time does not order among
       * themselves, from which the book stops; refs sorted.
       */
      indeterminateFrom: { refs: string[]; reasonCode: LotReasonCode } | null;
    }
  | {
      status: "refused";
      holderRef: string;
      instrumentRef: string;
      wrapperKey: string;
      instrumentClass: InstrumentClass;
      reasonCode: LotBookRefusalCode;
      refs: string[];
    };

/**
 * What the result was computed from. The caller digests it with
 * `canonicalDigest`; because it holds the validated inputs themselves, equal
 * digests mean equal inputs, policy and engine, and so an equal result.
 */
export interface LotManifest {
  contract: typeof LOT_INPUT_CONTRACT;
  engineVersion: typeof LOT_ENGINE_VERSION;
  policy: LotPolicy;
  /** Sorted, distinct ref texts of every input. */
  refs: string[];
  /** Every input, copied, sorted by holder, instrument, wrapper key and ref. */
  inputs: LotInput[];
}

export type LotResult =
  | {
      status: "computed";
      contract: typeof LOT_INPUT_CONTRACT;
      engineVersion: typeof LOT_ENGINE_VERSION;
      policyRef: string;
      manifest: LotManifest;
      partition: ResultPartition;
      books: LotBook[];
    }
  | {
      status: "refused";
      contract: typeof LOT_INPUT_CONTRACT;
      engineVersion: typeof LOT_ENGINE_VERSION;
      reasonCode: LotRefusalCode;
      /** Ref texts or closed codes; never provider text. */
      refs: string[];
    };

// ---------------------------------------------------------------------------
// References and validators

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;

export function lotInputRefText(ref: LotInputRef): string {
  if (ref.source === "event") return `event:${ref.eventId}@${ref.revision}`;
  const base = `${ref.factKind}:${ref.observationId}@parse_run:${ref.parseRunId}`;
  return ref.jsonPath === null ? base : `${base}#${ref.jsonPath}`;
}

export function validLotInputRef(value: unknown): value is LotInputRef {
  if (!isRecord(value)) return false;
  if (value.source === "event")
    return (
      hasExactKeys(value, ["source", "eventId", "revision"]) &&
      typeof value.eventId === "string" &&
      EVENT_ID.test(value.eventId) &&
      isSafeInt(value.revision, 1)
    );
  return (
    value.source === "observation" &&
    hasExactKeys(value, ["source", "factKind", "observationId", "parseRunId", "jsonPath"]) &&
    isOneOf(LOT_OBSERVATION_FACT_KINDS)(value.factKind) &&
    isSafeInt(value.observationId, 1) &&
    isSafeInt(value.parseRunId, 1) &&
    (value.jsonPath === null ||
      (isText(value.jsonPath, 512) &&
        value.jsonPath.startsWith("$") &&
        !/\s/u.test(value.jsonPath)))
  );
}

function validLotFxRate(value: unknown): value is LotFxRate {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["rate", "fromUnit", "toUnit", "rateRef"]) &&
    validExactDecimal(value.rate) &&
    isText(value.fromUnit, 128) &&
    isText(value.toUnit, 128) &&
    isText(value.rateRef, 512)
  );
}

function validLotInputTimes(value: unknown): value is LotInputTimes {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["trade", "settlement"]) &&
    validTemporalValue(value.trade) &&
    validTemporalValue(value.settlement)
  );
}

function validLotSelection(value: unknown): value is LotSelection {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["lotId", "quantity"]) &&
    isText(value.lotId, 1024) &&
    validQuantity(value.quantity)
  );
}

const INPUT_KEYS = [
  "contract",
  "ref",
  "kind",
  "holderRef",
  "instrumentRef",
  "wrapperKey",
  "instrumentClass",
  "time",
  "quantity",
  "consideration",
  "fees",
  "fx",
  "split",
  "lotSelections",
] as const;

/** Shape only, unknown keys rejected. The per-kind rules are checked by `computeLots`. */
export function validLotInput(value: unknown): value is LotInput {
  return (
    isRecord(value) &&
    hasExactKeys(value, INPUT_KEYS) &&
    value.contract === LOT_INPUT_CONTRACT &&
    validLotInputRef(value.ref) &&
    isOneOf(LOT_INPUT_KINDS)(value.kind) &&
    isText(value.holderRef, 256) &&
    value.holderRef.startsWith("account:") &&
    value.holderRef.length > "account:".length &&
    isText(value.instrumentRef, 256) &&
    isText(value.wrapperKey, 256) &&
    isOneOf(INSTRUMENT_CLASSES)(value.instrumentClass) &&
    validLotInputTimes(value.time) &&
    validQuantity(value.quantity) &&
    (value.consideration === null || validQuantity(value.consideration)) &&
    isArrayOf(validQuantity, 64)(value.fees) &&
    (value.fx === null || validLotFxRate(value.fx)) &&
    (value.split === null || validExactRatio(value.split)) &&
    (value.lotSelections === null || isArrayOf(validLotSelection, 10_000)(value.lotSelections))
  );
}

const POLICY_KEYS = [
  "policyId",
  "version",
  "purpose",
  "method",
  "scope",
  "timeBasis",
  "ordering",
  "acquisitionFee",
  "disposalFee",
  "fx",
  "fxPolicyRef",
  "costUnitRef",
  "rounding",
] as const;
const ROUNDING_KEYS = ["policyId", "where", "mode", "precision", "residual"] as const;

export function validLotPolicy(value: unknown): value is LotPolicy {
  return (
    isRecord(value) &&
    hasExactKeys(value, POLICY_KEYS) &&
    isText(value.policyId, 256) &&
    isSafeInt(value.version, 1) &&
    isOneOf(LOT_PURPOSES)(value.purpose) &&
    isOneOf(LOT_METHODS)(value.method) &&
    isOneOf(LOT_SCOPES)(value.scope) &&
    isOneOf(LOT_TIME_BASES)(value.timeBasis) &&
    isOneOf(LOT_ORDERING_RULES)(value.ordering) &&
    isOneOf(LOT_ACQUISITION_FEE_MODES)(value.acquisitionFee) &&
    isOneOf(LOT_DISPOSAL_FEE_MODES)(value.disposalFee) &&
    isOneOf(LOT_FX_MODES)(value.fx) &&
    isText(value.fxPolicyRef, 256) &&
    (value.fx === "convert-at-input-rate"
      ? isText(value.costUnitRef, 128)
      : value.costUnitRef === null) &&
    (value.rounding === null ||
      (isRecord(value.rounding) &&
        hasExactKeys(value.rounding, ROUNDING_KEYS) &&
        validRoundingPolicy(value.rounding) &&
        value.rounding.where === "leg" &&
        value.rounding.residual === "carry"))
  );
}

export function lotPolicyRef(policy: LotPolicy): string {
  return `${policy.policyId}@${policy.version}`;
}

// ---------------------------------------------------------------------------
// Per-kind input rules

const ZERO = integerDecimal(0);

function exactValue(quantity: Quantity): ExactDecimal | null {
  return quantity.value.status === "exact" ? quantity.value.value : null;
}

/** True when an exact value is not above zero (or below zero when `allowZero`); absent values pass here. */
function signRefused(quantity: Quantity, allowZero: boolean): boolean {
  const value = exactValue(quantity);
  if (value === null) return false;
  const order = compareDecimals(value, ZERO);
  return allowZero ? order < 0 : order <= 0;
}

function inputRulesHold(input: LotInput): boolean {
  if (input.quantity.unitRef !== input.instrumentRef) return false;
  if (input.fees.some((fee) => signRefused(fee, true))) return false;
  if (input.consideration !== null && signRefused(input.consideration, true)) return false;
  if (
    input.fx !== null &&
    (compareDecimals(input.fx.rate, ZERO) <= 0 || input.fx.fromUnit === input.fx.toUnit)
  )
    return false;
  const costless =
    input.consideration === null &&
    input.fees.length === 0 &&
    input.fx === null &&
    input.lotSelections === null;
  switch (input.kind) {
    case "acquisition":
      return (
        !signRefused(input.quantity, false) && input.split === null && input.lotSelections === null
      );
    case "disposal": {
      if (signRefused(input.quantity, false) || input.split !== null) return false;
      if (input.lotSelections === null) return true;
      const ids = input.lotSelections.map((selection) => selection.lotId);
      return (
        new Set(ids).size === ids.length &&
        input.lotSelections.every(
          (selection) =>
            selection.quantity.unitRef === input.instrumentRef &&
            !signRefused(selection.quantity, false),
        )
      );
    }
    case "split":
      return (
        costless &&
        input.split !== null &&
        BigInt(input.split.numerator) > 0n &&
        !signRefused(input.quantity, true)
      );
    case "snapshot":
      return costless && input.split === null && !signRefused(input.quantity, true);
    case "transfer":
      return input.split === null && input.lotSelections === null;
  }
}

// ---------------------------------------------------------------------------
// Amounts

type Amount =
  | { known: true; unitRef: string; value: ExactDecimal }
  | { known: false; reasonCode: LotAmountUnknownReason };

const knownAmount = (unitRef: string, value: ExactDecimal): Amount => ({
  known: true,
  unitRef,
  value,
});
const unknownAmount = (reasonCode: LotAmountUnknownReason): Amount => ({
  known: false,
  reasonCode,
});

function lotAmount(amount: Amount): LotAmount {
  return amount.known
    ? { status: "known", amount: exactQuantity(amount.unitRef, amount.value) }
    : { status: "unknown", reasonCode: amount.reasonCode };
}

function combine(a: Amount, b: Amount, sign: 1 | -1): Amount {
  if (!a.known) return a;
  if (!b.known) return b;
  if (a.unitRef !== b.unitRef) return unknownAmount("unit_mismatch");
  return knownAmount(
    a.unitRef,
    sign === 1 ? addDecimals(a.value, b.value) : subtractDecimals(a.value, b.value),
  );
}

/** Null for an empty list: no fee was stated, which is not the same as an unknown fee. */
function sumAmounts(amounts: readonly Amount[]): Amount | null {
  if (amounts.length === 0) return null;
  return amounts.slice(1).reduce((total, next) => combine(total, next, 1), amounts[0]!);
}

/** One of the input's own amounts in the unit the policy keeps costs in. */
function inCostUnit(
  quantity: Quantity,
  fx: LotFxRate | null,
  policy: LotPolicy,
  absent: LotAmountUnknownReason,
): { amount: Amount; fxUsed: LotFxRate | null } {
  const value = exactValue(quantity);
  if (value === null) return { amount: unknownAmount(absent), fxUsed: null };
  if (policy.fx === "lot-currency" || quantity.unitRef === policy.costUnitRef)
    return { amount: knownAmount(quantity.unitRef, value), fxUsed: null };
  if (fx !== null && fx.fromUnit === quantity.unitRef && fx.toUnit === policy.costUnitRef)
    return { amount: knownAmount(fx.toUnit, multiplyDecimals(value, fx.rate)), fxUsed: fx };
  return { amount: unknownAmount("fx_rate_missing"), fxUsed: null };
}

interface InputAmounts {
  consideration: Amount;
  fees: Amount | null;
  fxUsed: LotFxRate | null;
}

function inputAmounts(input: LotInput, policy: LotPolicy): InputAmounts {
  const consideration =
    input.consideration === null
      ? { amount: unknownAmount("consideration_missing"), fxUsed: null }
      : inCostUnit(input.consideration, input.fx, policy, "consideration_missing");
  const fees = input.fees.map((fee) => inCostUnit(fee, input.fx, policy, "fee_unknown"));
  const fxUsed = [consideration, ...fees].some((part) => part.fxUsed !== null) ? input.fx : null;
  return {
    consideration: consideration.amount,
    fees: sumAmounts(fees.map((part) => part.amount)),
    fxUsed,
  };
}

// ---------------------------------------------------------------------------
// Book state

interface Lot {
  lotId: string;
  acquisitionRefs: string[];
  acquiredAt: TemporalValue | null;
  quantity: ExactDecimal;
  remaining: ExactDecimal;
  cost: Amount;
  remainingCost: Amount;
  fees: Amount | null;
  remainingFees: Amount | null;
  fxBasis: LotFxRate[];
  /** Units the cost entered in, known value or not; a pool stops on a second one. */
  costUnits: string[];
  lineage: LotLineage;
}

interface BookState {
  lots: Lot[];
  /** True once any input has been applied: a snapshot after that is a check, not a seed. */
  history: boolean;
  indeterminate: { refs: string[]; reasonCode: LotReasonCode } | null;
  disposals: LotDisposal[];
}

interface Entry {
  input: LotInput;
  ref: string;
  /** The input's time on the policy's basis. */
  time: TemporalValue;
}

function cloneState(state: BookState): BookState {
  return {
    lots: state.lots.map((lot) => ({
      ...lot,
      acquisitionRefs: [...lot.acquisitionRefs],
      fxBasis: [...lot.fxBasis],
      costUnits: [...lot.costUnits],
      lineage: { ...lot.lineage, splits: [...lot.lineage.splits] },
    })),
    history: state.history,
    indeterminate: state.indeterminate,
    disposals: [...state.disposals],
  };
}

function holding(state: BookState): ExactDecimal {
  return state.lots.reduce((total, lot) => addDecimals(total, lot.remaining), ZERO);
}

function lotState(lot: Lot, instrumentRef: string): LotState {
  return {
    lotId: lot.lotId,
    acquisitionRefs: [...lot.acquisitionRefs],
    acquiredAt: lot.acquiredAt,
    quantity: exactQuantity(instrumentRef, lot.quantity),
    remainingQuantity: exactQuantity(instrumentRef, lot.remaining),
    cost: lotAmount(lot.cost),
    remainingCost: lotAmount(lot.remainingCost),
    acquisitionFees: lot.fees === null ? null : lotAmount(lot.fees),
    remainingAcquisitionFees: lot.remainingFees === null ? null : lotAmount(lot.remainingFees),
    fxBasis: [...lot.fxBasis],
    lineage: { ...lot.lineage, splits: [...lot.lineage.splits] },
  };
}

function originLineage(ref: string, acquiredAt: TemporalValue | null, cost: Amount): LotLineage {
  return {
    originRef: ref,
    originAcquiredAt: acquiredAt,
    originCostUnit: cost.known ? cost.unitRef : null,
    fragmentOf: null,
    splits: [],
  };
}

function markIndeterminate(
  state: BookState,
  refs: readonly string[],
  reasonCode: LotReasonCode,
): void {
  if (state.indeterminate === null) state.indeterminate = { refs: [...refs].sort(), reasonCode };
}

function unionSorted(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

/**
 * Every unit an acquisition's cost is stated in, whether or not its value is
 * known: the consideration's and, when fees are capitalized, the fees'. Under
 * `convert-at-input-rate` that is the policy's cost unit.
 */
function costUnitsOf(input: LotInput, policy: LotPolicy): string[] {
  if (policy.fx === "convert-at-input-rate") return [policy.costUnitRef!];
  const units = input.consideration === null ? [] : [input.consideration.unitRef];
  const fees = policy.acquisitionFee === "capitalize" ? input.fees.map((fee) => fee.unitRef) : [];
  return unionSorted(units, fees);
}

function addFxBasis(list: LotFxRate[], fx: LotFxRate | null): LotFxRate[] {
  if (fx === null) return list;
  const key = (rate: LotFxRate) =>
    `${rate.rateRef}\u0000${rate.fromUnit}\u0000${rate.toUnit}\u0000${rate.rate.coefficient}e${rate.rate.scale}`;
  const merged = new Map(list.map((rate) => [key(rate), rate]));
  merged.set(key(fx), fx);
  return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}

// ---------------------------------------------------------------------------
// Applying inputs

function applyAcquisition(
  state: BookState,
  entry: Entry,
  quantity: ExactDecimal,
  policy: LotPolicy,
): void {
  const amounts = inputAmounts(entry.input, policy);
  const cost =
    policy.acquisitionFee === "capitalize" && amounts.fees !== null
      ? combine(amounts.consideration, amounts.fees, 1)
      : amounts.consideration;
  const fxBasis = amounts.fxUsed === null ? [] : [amounts.fxUsed];
  // A pool holds one cost unit. Units are tracked even while the cost itself
  // is unknown, so a second unit stops the book whatever order it arrived in.
  const costUnits = unionSorted(state.lots[0]?.costUnits ?? [], costUnitsOf(entry.input, policy));
  if (policy.method === "moving-average" && costUnits.length > 1) {
    markIndeterminate(state, [entry.ref], "unit_mismatch");
    return;
  }
  if (policy.method !== "moving-average" || state.lots.length === 0) {
    const acquiredAt = policy.method === "moving-average" ? null : entry.time;
    state.lots.push({
      lotId: policy.method === "moving-average" ? `pool:${entry.ref}` : entry.ref,
      acquisitionRefs: [entry.ref],
      acquiredAt,
      quantity,
      remaining: quantity,
      cost,
      remainingCost: cost,
      fees: amounts.fees,
      remainingFees: amounts.fees,
      fxBasis,
      costUnits: costUnitsOf(entry.input, policy),
      lineage: originLineage(entry.ref, acquiredAt, cost),
    });
    return;
  }
  const pool = state.lots[0]!;
  pool.costUnits = costUnits;
  const addFees = (a: Amount | null, b: Amount | null): Amount | null =>
    a === null ? b : b === null ? a : combine(a, b, 1);
  pool.acquisitionRefs = [...pool.acquisitionRefs, entry.ref].sort();
  pool.quantity = addDecimals(pool.quantity, quantity);
  pool.remaining = addDecimals(pool.remaining, quantity);
  pool.cost = combine(pool.cost, cost, 1);
  pool.remainingCost = combine(pool.remainingCost, cost, 1);
  pool.fees = addFees(pool.fees, amounts.fees);
  pool.remainingFees = addFees(pool.remainingFees, amounts.fees);
  pool.fxBasis = addFxBasis(pool.fxBasis, amounts.fxUsed);
}

function ratioOf(part: ExactDecimal, whole: ExactDecimal): ExactRatio {
  const aligned = alignScales(part, whole);
  return { numerator: aligned.a.toString(), denominator: aligned.b.toString() };
}

type Share = { ok: true; share: Amount; roundingInputs: RoundingInputs | null } | { ok: false };

/**
 * `amount × take / remaining`. Taking the whole remainder takes the exact
 * remaining amount, so earlier rounded shares are carried into the last one
 * and allocated + remaining always equals what entered the lot.
 */
function shareOf(
  amount: Amount,
  take: ExactDecimal,
  remaining: ExactDecimal,
  rounding: RoundingPolicy | null,
): Share {
  if (!amount.known || decimalEquals(take, remaining))
    return { ok: true, share: amount, roundingInputs: null };
  const ratio = ratioOf(take, remaining);
  const exact = multiplyByRatio(amount.value, ratio);
  if (rounding === null)
    return exact.ok
      ? { ok: true, share: knownAmount(amount.unitRef, exact.value), roundingInputs: null }
      : { ok: false };
  const rounded = multiplyByRatio(amount.value, ratio, {
    scale: rounding.precision,
    mode: rounding.mode,
  });
  if (!rounded.ok) return { ok: false };
  // Rounding to a precision coarser than the amount can overshoot what is
  // left (0.6 of 0.9 rounds to 1) and drive the remainder below zero; that
  // is not an allocation this policy can make.
  const sign = compareDecimals(amount.value, ZERO);
  const shareSign = compareDecimals(rounded.value, ZERO);
  const magnitude = (value: ExactDecimal) => (sign < 0 ? negateDecimal(value) : value);
  if (
    (shareSign !== 0 && shareSign !== sign) ||
    compareDecimals(magnitude(rounded.value), magnitude(amount.value)) > 0
  )
    return { ok: false };
  return {
    ok: true,
    share: knownAmount(amount.unitRef, rounded.value),
    roundingInputs: {
      policyId: rounding.policyId,
      where: rounding.where,
      mode: rounding.mode,
      precision: rounding.precision,
      residual: rounding.residual,
      operands: [amount.value, take, remaining],
      preRounding: exact.ok ? exact.value : null,
    },
  };
}

interface DisposalSide {
  proceeds: Amount;
  fees: Amount | null;
  fxUsed: LotFxRate | null;
}

function disposalSide(input: LotInput, policy: LotPolicy): DisposalSide {
  const amounts = inputAmounts(input, policy);
  const proceeds =
    policy.disposalFee === "reduce-proceeds" && amounts.fees !== null
      ? combine(amounts.consideration, amounts.fees, -1)
      : amounts.consideration;
  return { proceeds, fees: amounts.fees, fxUsed: amounts.fxUsed };
}

function disposalRecord(
  entry: Entry,
  side: DisposalSide,
  allocations: LotAllocation[],
  allocatedCost: Quantity | null,
  outcome: LotDisposalOutcome,
  reasonCodes: Iterable<LotReasonCode>,
): LotDisposal {
  return {
    disposalRef: entry.ref,
    time: entry.time,
    quantity: entry.input.quantity,
    allocations,
    allocatedCost,
    proceeds: lotAmount(side.proceeds),
    disposalFees: side.fees === null ? null : lotAmount(side.fees),
    fxBasis: side.fxUsed,
    outcome,
    reasonCodes: [...new Set(reasonCodes)].sort(),
  };
}

function indeterminateDisposal(
  entry: Entry,
  policy: LotPolicy,
  reasonCode: LotReasonCode,
): LotDisposal {
  return disposalRecord(entry, disposalSide(entry.input, policy), [], null, "indeterminate", [
    reasonCode,
  ]);
}

function amountReasons(amount: Amount | null, general: LotReasonCode): LotReasonCode[] {
  if (amount === null || amount.known) return [];
  if (amount.reasonCode === "fx_rate_missing") return [general, "fx_rate_missing"];
  if (amount.reasonCode === "unit_mismatch") return [general, "unit_mismatch"];
  return [general];
}

function applyDisposal(
  state: BookState,
  entry: Entry,
  quantity: ExactDecimal,
  policy: LotPolicy,
): void {
  const fail = (reasonCode: LotReasonCode) => {
    markIndeterminate(state, [entry.ref], reasonCode);
    state.disposals.push(indeterminateDisposal(entry, policy, reasonCode));
  };
  if (compareDecimals(holding(state), quantity) < 0) return fail("negative_holding");
  const plan: { lot: Lot; take: ExactDecimal }[] = [];
  if (policy.method === "specific-identification") {
    const selections = entry.input.lotSelections;
    if (selections === null) return fail("lot_selection_missing");
    const takes = new Map<string, ExactDecimal>();
    for (const selection of selections) {
      const take = exactValue(selection.quantity);
      if (take === null) return fail("value_not_exact");
      if (!state.lots.some((lot) => lot.lotId === selection.lotId)) return fail("unknown_lot");
      takes.set(selection.lotId, take);
    }
    for (const lot of state.lots) {
      const take = takes.get(lot.lotId);
      if (take === undefined) continue;
      if (compareDecimals(take, lot.remaining) > 0) return fail("lot_selection_mismatch");
      plan.push({ lot, take });
    }
    const selected = plan.reduce((total, step) => addDecimals(total, step.take), ZERO);
    if (!decimalEquals(selected, quantity)) return fail("lot_selection_mismatch");
  } else {
    let left = quantity;
    for (const lot of state.lots) {
      if (isZeroDecimal(left)) break;
      if (isZeroDecimal(lot.remaining)) continue;
      const take = compareDecimals(lot.remaining, left) < 0 ? lot.remaining : left;
      plan.push({ lot, take });
      left = subtractDecimals(left, take);
    }
  }
  // Compute every share before changing any lot, so a refusal leaves the lots as they were.
  const shares: { cost: Share & { ok: true }; fees: (Share & { ok: true }) | null }[] = [];
  for (const { lot, take } of plan) {
    const cost = shareOf(lot.remainingCost, take, lot.remaining, policy.rounding);
    const fees =
      lot.remainingFees === null
        ? null
        : shareOf(lot.remainingFees, take, lot.remaining, policy.rounding);
    if (!cost.ok || (fees !== null && !fees.ok)) return fail("inexact_allocation");
    shares.push({ cost, fees });
  }
  const allocations: LotAllocation[] = [];
  const reasons = new Set<LotReasonCode>();
  plan.forEach(({ lot, take }, index) => {
    const { cost, fees } = shares[index]!;
    allocations.push({
      lotId: lot.lotId,
      acquisitionRefs: [...lot.acquisitionRefs],
      quantity: exactQuantity(entry.input.instrumentRef, take),
      cost: lotAmount(cost.share),
      acquisitionFees: fees === null ? null : lotAmount(fees.share),
      fxBasis: [...lot.fxBasis],
      roundingInputs: { cost: cost.roundingInputs, acquisitionFees: fees?.roundingInputs ?? null },
    });
    for (const reason of amountReasons(cost.share, "unknown_cost")) reasons.add(reason);
    // An unknown acquisition fee is reported under either fee mode: excluded
    // from cost, it is still part of what a later P&L would need.
    for (const reason of amountReasons(fees?.share ?? null, "unknown_acquisition_fee"))
      reasons.add(reason);
    lot.remaining = subtractDecimals(lot.remaining, take);
    lot.remainingCost = combine(lot.remainingCost, cost.share, -1);
    if (lot.remainingFees !== null && fees !== null)
      lot.remainingFees = combine(lot.remainingFees, fees.share, -1);
  });
  // A moving-average pool that is emptied closes; the next acquisition opens a new one.
  if (policy.method === "moving-average" && state.lots[0] && isZeroDecimal(state.lots[0].remaining))
    state.lots = [];
  const total = sumAmounts(shares.map(({ cost }) => cost.share));
  let allocatedCost: Quantity | null = null;
  if (total !== null && total.known) allocatedCost = exactQuantity(total.unitRef, total.value);
  else if (total !== null && total.reasonCode === "unit_mismatch") reasons.add("unit_mismatch");
  const side = disposalSide(entry.input, policy);
  for (const reason of amountReasons(side.proceeds, "unknown_proceeds")) reasons.add(reason);
  for (const reason of amountReasons(side.fees, "unknown_proceeds")) reasons.add(reason);
  state.disposals.push(
    disposalRecord(
      entry,
      side,
      allocations,
      allocatedCost,
      reasons.size === 0 ? "allocated" : "limited",
      reasons,
    ),
  );
}

function applySplit(state: BookState, entry: Entry, stated: ExactDecimal): void {
  const ratio = entry.input.split!;
  const scaled: { lot: Lot; remaining: ExactDecimal }[] = [];
  // Only what is left is split. A consumed lot keeps its history as it was,
  // and the quantity that entered a lot stays in its units of entry;
  // `lineage.splits` says which splits apply to the remainder.
  for (const lot of state.lots) {
    if (isZeroDecimal(lot.remaining)) continue;
    const remaining = multiplyByRatio(lot.remaining, ratio);
    // A split that does not scale a holding exactly is a different corporate
    // action (cash in lieu of fractions, for one); it is not modelled here.
    if (!remaining.ok) {
      markIndeterminate(state, [entry.ref], "corporate_action_unsupported");
      return;
    }
    scaled.push({ lot, remaining: remaining.value });
  }
  const after = scaled.reduce((total, step) => addDecimals(total, step.remaining), ZERO);
  if (!decimalEquals(after, stated)) {
    markIndeterminate(state, [entry.ref], "corporate_action_unsupported");
    return;
  }
  for (const step of scaled) {
    step.lot.remaining = step.remaining;
    step.lot.lineage.splits = [...step.lot.lineage.splits, { splitRef: entry.ref, ratio }];
  }
}

function applySnapshot(state: BookState, entry: Entry, stated: ExactDecimal, policy: LotPolicy) {
  if (state.history) {
    if (!decimalEquals(holding(state), stated))
      markIndeterminate(state, [entry.ref], "snapshot_mismatch");
    return;
  }
  if (isZeroDecimal(stated)) return;
  // No history: the holding is known, its cost is not. A provider-stated
  // acquisition cost is a claim and never becomes the lot's cost.
  const unknownCost = unknownAmount("snapshot_only");
  const acquiredAt: TemporalValue | null =
    policy.method === "moving-average" ? null : { kind: "unknown", reasonCode: "snapshot_only" };
  state.lots.push({
    lotId: policy.method === "moving-average" ? `pool:${entry.ref}` : entry.ref,
    acquisitionRefs: [entry.ref],
    acquiredAt,
    quantity: stated,
    remaining: stated,
    cost: unknownCost,
    remainingCost: unknownCost,
    fees: null,
    remainingFees: null,
    fxBasis: [],
    costUnits: [],
    lineage: originLineage(entry.ref, acquiredAt, unknownCost),
  });
}

function applyEntry(state: BookState, entry: Entry, policy: LotPolicy): void {
  const { input } = entry;
  if (state.indeterminate !== null) {
    if (input.kind === "disposal")
      state.disposals.push(indeterminateDisposal(entry, policy, "upstream_indeterminate"));
    return;
  }
  const quantity = exactValue(input.quantity);
  if (quantity === null) {
    markIndeterminate(state, [entry.ref], "value_not_exact");
    if (input.kind === "disposal")
      state.disposals.push(indeterminateDisposal(entry, policy, "value_not_exact"));
    return;
  }
  switch (input.kind) {
    case "acquisition":
      applyAcquisition(state, entry, quantity, policy);
      break;
    case "disposal":
      applyDisposal(state, entry, quantity, policy);
      break;
    case "split":
      applySplit(state, entry, quantity);
      break;
    case "snapshot":
      applySnapshot(state, entry, quantity, policy);
      break;
    case "transfer":
      // Unreachable: a book with a transfer is refused before it is computed.
      markIndeterminate(state, [entry.ref], "upstream_indeterminate");
      break;
  }
  state.history = true;
}

// ---------------------------------------------------------------------------
// Ordering

/**
 * Where a time sits on one absolute line, in seconds: an instant is a point
 * (its epoch), a date or a period is the span of its civil days read as UTC.
 * Used only to lay inputs out and to skip comparisons that cannot fail; every
 * decision about order is `compareTemporal`'s.
 */
interface TimeSpan {
  lo: number;
  loNanos: number;
  hi: number;
}

const DAY_SECONDS = 86_400;
/**
 * Two spans further apart than this are ordered whatever the offsets: an
 * instant's own calendar day is at most 18 hours from its UTC day, so a gap of
 * two days settles every instant/date/period pair in a compatible zone.
 */
const ORDERED_GAP_SECONDS = 2 * DAY_SECONDS;

function timeSpan(time: TemporalValue): TimeSpan {
  switch (time.kind) {
    case "instant": {
      const parsed = parseInstant(time.value)!;
      return { lo: parsed.epochSeconds, loNanos: parsed.nanoseconds, hi: parsed.epochSeconds };
    }
    case "local-date": {
      const day = daysFromCivil(parseLocalDate(time.value)!);
      return { lo: day * DAY_SECONDS, loNanos: 0, hi: (day + 1) * DAY_SECONDS };
    }
    case "period": {
      const bounds = periodBounds(time)!;
      return {
        lo: daysFromCivil(bounds.start) * DAY_SECONDS,
        loNanos: 0,
        hi: daysFromCivil(bounds.endExclusive) * DAY_SECONDS,
      };
    }
    case "unknown":
      return { lo: 0, loNanos: 0, hi: 0 };
  }
}

type LaidOut = Entry & { span: TimeSpan };

function compareLaidOut(a: LaidOut, b: LaidOut): number {
  return (
    a.span.lo - b.span.lo ||
    a.span.loNanos - b.span.loNanos ||
    a.span.hi - b.span.hi ||
    (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
  );
}

/**
 * Cut the laid-out inputs into groups such that every input of a later group
 * is strictly after every input of every earlier group by `compareTemporal`.
 * An input joins the current group as soon as one earlier input is not
 * strictly before it, so "not ordered" is closed over the whole group rather
 * than checked between neighbours only.
 */
function timeGroups(ordered: readonly LaidOut[]): LaidOut[][] {
  const reach = ordered.map((_, index) => index);
  let active: number[] = [];
  ordered.forEach((entry, index) => {
    active = active.filter((j) => ordered[j]!.span.hi + ORDERED_GAP_SECONDS > entry.span.lo);
    for (const j of active) {
      const order = compareTemporal(ordered[j]!.time, entry.time);
      if (order.kind !== "ordered" || order.order >= 0) reach[j] = index;
    }
    active.push(index);
  });
  const groups: LaidOut[][] = [];
  let start = 0;
  let furthest = 0;
  ordered.forEach((_, index) => {
    furthest = Math.max(furthest, reach[index]!);
    if (index === furthest) {
      groups.push(ordered.slice(start, index + 1));
      start = index + 1;
      furthest = index + 1;
    }
  });
  return groups;
}

/** Dates and periods in two named zones cannot be laid out on one line. */
function zonesConflict(entries: readonly Entry[]): boolean {
  const civilZones = new Set<string>();
  for (const { time } of entries)
    if ((time.kind === "local-date" || time.kind === "period") && time.zone)
      civilZones.add(time.zone);
  if (civilZones.size > 1) return true;
  if (civilZones.size === 0) return false;
  const [zone] = civilZones;
  return entries.some(({ time }) => time.kind === "instant" && time.zone !== zone);
}

/**
 * Same-time inputs commute only under moving average, and only when they are
 * all acquisitions (pooling is a sum) or all disposals without rounding (each
 * takes cost × q / Q of the same pool). Everything else is an order tie.
 */
function commutes(group: readonly Entry[], policy: LotPolicy): boolean {
  if (policy.method !== "moving-average") return false;
  if (group.every(({ input }) => input.kind === "acquisition")) return true;
  return policy.rounding === null && group.every(({ input }) => input.kind === "disposal");
}

/**
 * Why a commuting moving-average group cannot apply, checked on the group as
 * a whole in a fixed precedence: an inexact quantity, a second cost unit in
 * the pool, more disposed than held, a share that is not exact.
 */
function groupFailure(
  state: BookState,
  group: readonly Entry[],
  policy: LotPolicy,
): LotReasonCode | null {
  const quantities = group.map(({ input }) => exactValue(input.quantity));
  if (quantities.some((quantity) => quantity === null)) return "value_not_exact";
  const pool = state.lots[0];
  if (group.every(({ input }) => input.kind === "acquisition")) {
    const units = group.reduce(
      (all, { input }) => unionSorted(all, costUnitsOf(input, policy)),
      pool?.costUnits ?? [],
    );
    return units.length > 1 ? "unit_mismatch" : null;
  }
  const disposed = quantities.reduce<ExactDecimal>((total, q) => addDecimals(total, q!), ZERO);
  if (pool === undefined || compareDecimals(pool.remaining, disposed) < 0)
    return "negative_holding";
  // Each disposal takes cost × q / Q of the pool as it stands, in any order.
  const inexact = quantities.some(
    (quantity) =>
      !shareOf(pool.remainingCost, quantity!, pool.remaining, null).ok ||
      (pool.remainingFees !== null &&
        !shareOf(pool.remainingFees, quantity!, pool.remaining, null).ok),
  );
  return inexact ? "inexact_allocation" : null;
}

function failAll(
  state: BookState,
  entries: readonly Entry[],
  reasonCode: LotReasonCode,
  policy: LotPolicy,
): void {
  markIndeterminate(
    state,
    entries.map(({ ref }) => ref),
    reasonCode,
  );
  for (const entry of entries)
    if (entry.input.kind === "disposal")
      state.disposals.push(indeterminateDisposal(entry, policy, reasonCode));
}

function computeBook(
  entries: readonly Entry[],
  policy: LotPolicy,
): { disposals: LotDisposal[]; lots: Lot[] | null; indeterminateFrom: BookState["indeterminate"] } {
  const state: BookState = { lots: [], history: false, indeterminate: null, disposals: [] };
  const byRef = [...entries].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  // An input with no known time could sit anywhere in the history.
  const unknown = byRef.filter(({ time }) => time.kind === "unknown");
  if (unknown.length > 0) {
    markIndeterminate(
      state,
      unknown.map(({ ref }) => ref),
      "unknown_time",
    );
    failAll(state, byRef, "unknown_time", policy);
    return { disposals: state.disposals, lots: null, indeterminateFrom: state.indeterminate };
  }
  const ordered = entries
    .map((entry) => ({ ...entry, span: timeSpan(entry.time) }))
    .sort(compareLaidOut);
  if (zonesConflict(ordered)) {
    failAll(state, ordered, "order_tie", policy);
    return { disposals: state.disposals, lots: null, indeterminateFrom: state.indeterminate };
  }
  for (const group of timeGroups(ordered)) {
    if (state.indeterminate !== null || group.length === 1) {
      for (const entry of group) applyEntry(state, entry, policy);
      continue;
    }
    if (!commutes(group, policy)) {
      failAll(state, group, "order_tie", policy);
      continue;
    }
    // A commuting group either applies as a whole or fails as a whole, and
    // its failure is decided on the group, so neither the reason nor the
    // reported refs depend on an order the evidence lacks.
    const failure = groupFailure(state, group, policy);
    if (failure !== null) {
      failAll(state, group, failure, policy);
      continue;
    }
    const trial = cloneState(state);
    for (const entry of group) applyEntry(trial, entry, policy);
    if (trial.indeterminate === null) Object.assign(state, trial);
    else failAll(state, group, trial.indeterminate.reasonCode, policy);
  }
  return {
    disposals: state.disposals,
    lots: state.indeterminate === null ? state.lots : null,
    indeterminateFrom: state.indeterminate,
  };
}

// ---------------------------------------------------------------------------
// Entry point

function bookKeyOf(input: LotInput): string[] {
  return [input.holderRef, input.instrumentRef, input.wrapperKey];
}

function compareTuples(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1)
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  return a.length - b.length;
}

/** A deep copy of a validated, JSON-shaped value, so results never alias the caller's objects. */
function plainCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function refused(reasonCode: LotRefusalCode, refs: Iterable<string>): LotResult {
  return {
    status: "refused",
    contract: LOT_INPUT_CONTRACT,
    engineVersion: LOT_ENGINE_VERSION,
    reasonCode,
    refs: [...new Set(refs)].sort(),
  };
}

function isSupportedClass(value: InstrumentClass): boolean {
  return (LOT_SUPPORTED_INSTRUMENT_CLASSES as readonly InstrumentClass[]).includes(value);
}

/**
 * Allocate disposals to lots, book by book, under an explicit policy. Gates
 * run first and refuse the whole run: no policy, a tax purpose, an input
 * that breaks the contract, the same ref twice for one instrument, two
 * revisions of one event, or one observation under two parse runs. A transfer or an unsupported instrument class refuses only its
 * book. Inside a book, the first input that makes the history ambiguous or
 * inconsistent stops it: later disposals are `upstream_indeterminate` and the
 * remaining lots are not reported.
 */
export function computeLots(inputs: readonly LotInput[], policy: LotPolicy | null): LotResult {
  if (policy === null) return refused("policy_missing", []);
  if (!validLotPolicy(policy)) return refused("invalid_input", ["policy"]);
  if (policy.purpose === "tax") {
    // The existing gate decides; it holds no verified rule package, so it
    // always answers needs-policy and this module never reaches a number.
    const gate = costBasis({
      jurisdiction: null,
      taxPeriod: null,
      accountWrapper: null,
      residencyOrEntity: null,
      method: policy.method,
      feeTreatment: policy.acquisitionFee,
      carriedCost: null,
      lotSelection: policy.method === "specific-identification" ? policy.method : null,
      rulePackage: null,
    });
    return refused("tax_rules_unverified", [
      `cost-basis:${gate.status}:${gate.reasonCode}`,
      ...gate.missing.map((input) => `missing:${input}`),
    ]);
  }
  const invalid: string[] = [];
  const entries: Entry[] = [];
  for (const input of inputs as readonly unknown[]) {
    if (!validLotInput(input)) {
      invalid.push(
        isRecord(input) && validLotInputRef(input.ref)
          ? lotInputRefText(input.ref)
          : "input:invalid",
      );
      continue;
    }
    const ref = lotInputRefText(input.ref);
    if (!inputRulesHold(input)) invalid.push(ref);
    else
      entries.push({
        input,
        ref,
        time: policy.timeBasis === "trade-date" ? input.time.trade : input.time.settlement,
      });
  }
  const books = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = JSON.stringify(bookKeyOf(entry.input));
    books.set(key, [...(books.get(key) ?? []), entry]);
  }
  for (const book of books.values()) {
    const classes = new Set(book.map(({ input }) => input.instrumentClass));
    if (classes.size > 1) invalid.push(...book.map(({ ref }) => ref));
  }
  if (invalid.length > 0) return refused("invalid_input", invalid);
  const duplicates: string[] = [];
  for (const book of books.values()) {
    const seen = new Set<string>();
    for (const { ref } of book) {
      if (seen.has(ref)) duplicates.push(ref);
      seen.add(ref);
    }
  }
  // One ref in two books of the same instrument would hold the same units
  // twice (INV06). Legs of one event on two instruments (a swap) are two
  // facts; two sides of a transfer are refused per book below.
  const holders = new Map<string, { books: Set<string>; transfersOnly: boolean }>();
  for (const [key, book] of books)
    for (const { input, ref } of book) {
      const slot = JSON.stringify([input.instrumentRef, ref]);
      const seen = holders.get(slot) ?? { books: new Set<string>(), transfersOnly: true };
      seen.books.add(key);
      seen.transfersOnly &&= input.kind === "transfer";
      holders.set(slot, seen);
      if (seen.books.size > 1 && !seen.transfersOnly) duplicates.push(ref);
    }
  if (duplicates.length > 0) return refused("duplicate_ref", duplicates);
  const revisions = new Map<string, Set<string>>();
  for (const { input, ref } of entries)
    if (input.ref.source === "event")
      revisions.set(input.ref.eventId, (revisions.get(input.ref.eventId) ?? new Set()).add(ref));
  const conflicting = [...revisions.values()]
    .filter((refs) => refs.size > 1)
    .flatMap((r) => [...r]);
  if (conflicting.length > 0) return refused("same_event_revisions", conflicting);
  const parseRuns = new Map<string, Set<string>>();
  for (const { input, ref } of entries)
    if (input.ref.source === "observation") {
      const { factKind, observationId, jsonPath } = input.ref;
      const slot = JSON.stringify([factKind, observationId, jsonPath]);
      parseRuns.set(slot, (parseRuns.get(slot) ?? new Set()).add(ref));
    }
  const reparsed = [...parseRuns.values()].filter((refs) => refs.size > 1).flatMap((r) => [...r]);
  if (reparsed.length > 0) return refused("same_observation_parse_runs", reparsed);

  const results: LotBook[] = [];
  const ordered = [...books.values()].sort((a, b) =>
    compareTuples(bookKeyOf(a[0]!.input), bookKeyOf(b[0]!.input)),
  );
  for (const book of ordered) {
    const { holderRef, instrumentRef, wrapperKey, instrumentClass } = book[0]!.input;
    const head = { holderRef, instrumentRef, wrapperKey, instrumentClass };
    if (!isSupportedClass(instrumentClass)) {
      results.push({
        status: "refused",
        ...head,
        reasonCode: "unsupported_instrument",
        refs: book.map(({ ref }) => ref).sort(),
      });
      continue;
    }
    const transfers = book.filter(({ input }) => input.kind === "transfer");
    if (transfers.length > 0) {
      results.push({
        status: "refused",
        ...head,
        reasonCode: "transfer_contract_pending",
        refs: transfers.map(({ ref }) => ref).sort(),
      });
      continue;
    }
    const computed = computeBook(book, policy);
    results.push({
      status: "computed",
      ...head,
      disposals: computed.disposals,
      remainingLots:
        computed.lots === null
          ? null
          : computed.lots
              .filter((lot) => !isZeroDecimal(lot.remaining))
              .map((lot) => lotState(lot, instrumentRef)),
      indeterminateFrom: computed.indeterminateFrom,
    });
  }
  return {
    status: "computed",
    contract: LOT_INPUT_CONTRACT,
    engineVersion: LOT_ENGINE_VERSION,
    policyRef: lotPolicyRef(policy),
    manifest: {
      contract: LOT_INPUT_CONTRACT,
      engineVersion: LOT_ENGINE_VERSION,
      policy: plainCopy(policy),
      refs: [...new Set(entries.map(({ ref }) => ref))].sort(),
      inputs: entries
        .map((entry) => ({ key: [...bookKeyOf(entry.input), entry.ref], input: entry.input }))
        .sort((a, b) => compareTuples(a.key, b.key))
        .map(({ input }) => plainCopy(input)),
    },
    partition: partitionOf(results),
    books: results,
  };
}

function partitionOf(books: readonly LotBook[]): ResultPartition {
  if (!books.some((book) => book.status === "computed")) return "not-computable";
  const complete = books.every(
    (book) =>
      book.status === "computed" &&
      book.indeterminateFrom === null &&
      book.disposals.every((disposal) => disposal.outcome === "allocated") &&
      (book.remainingLots ?? []).every(
        (lot) =>
          lot.remainingCost.status === "known" &&
          (lot.remainingAcquisitionFees === null ||
            lot.remainingAcquisitionFees.status === "known"),
      ),
  );
  return complete ? "complete" : "partial-verified-scope";
}
