// The C adapter (ADR 0059): what the knowledge selector resolved at a cut
// (`knowledge-selector.ts`, ADR 0058) as the lot engine's provisional input
// (`provisional-lot-input-v0`, `lots.ts`, ADR 0051), then the engine under
// the caller's explicit policy, wrapped in the outer manifest ADR 0054 lists.
//
// What it reads, and nothing else:
//
//   * typed movement (ADR 0054): a revision's one movement leg in an
//     instrument unit is the acquisition (increase) or disposal (decrease) of
//     its book; the cash side is either one cash movement, whose `breakdown`
//     legs are the fees inside it (101 out = 100 principal + 1 fee for an
//     acquisition; 100 in = 101 gross − 1 fee for a disposal), or one
//     `correspondence` of the security movement stating the consideration,
//     with `correspondence` fee legs stating the fees. Any other shape is
//     `writer_unsupported`;
//   * times: the `trade` and `settlement` roles of `economic_event_times` as
//     stored. A missing role is an unknown time on that basis
//     (`time_role_missing`), never another role and never the 0032 effective
//     time;
//   * the book: holder `account:<resolved account>`, the instrument the
//     caller's identity mapping names for the leg's unit (refused when the
//     mapping is unresolved or aggregate, names no supported class, or is not
//     the revision the seal pinned), and the opaque wrapper key the caller
//     supplies for that account (ADR 0051; its source is not decided);
//   * dispositions: a revision the log does not place, an identity change, a
//     claim or alias conflict, an inconsistent chain, a shape the adapter or
//     the selector cannot place: the touched book is held (indeterminate or
//     needs review) and none of its inputs reaches the engine.
//
// What it never does: it reads no FX rate (none is in evidence), produces no
// snapshot (provider acquisition costs are claims, never lot cost), no split
// (no corporate-action kind exists) and no transfer (its contract is
// pending), computes no gain and concludes nothing about tax.
//
// Today no writer admits the `security-quantity` book (CORE 0070 refuses it,
// `economic_claim_book_unsupported`), so every real selection answers
// `unsupported` (`security_quantity_writer_missing`). The mapped path runs on
// hand-built selections in its tests.
//
// Pure apart from hashing; no I/O, no clock.
import { INSTRUMENT_CLASSES, type InstrumentClass } from "./calculation.ts";
import { canonicalDigest } from "./context.ts";
import type { KnowledgeCut } from "./economic-contract.ts";
import { hasExactKeys, isArrayOf, isOneOf, isRecord, isSafeInt, isText } from "./guards.ts";
import {
  KNOWLEDGE_SELECTOR_RELEASE,
  type AdoptedSelection,
  type ResolvedCut,
  type SelectedAdoptedRevision,
  type SelectedLeg,
} from "./knowledge-selector.ts";
import {
  computeLots,
  LOT_ENGINE_VERSION,
  LOT_INPUT_CONTRACT,
  lotInputRefText,
  lotPolicyRef,
  validLotInput,
  validLotPolicy,
  type LotInput,
  type LotInputKind,
  type LotPolicy,
  type LotResult,
  type LotSelection,
} from "./lots.ts";
import { COVERAGE_PRODUCER_NONE } from "./reconstruction-adapter.ts";
import type { TemporalValue } from "./time.ts";
import {
  absentQuantity,
  addQuantities,
  compareDecimals,
  integerDecimal,
  subtractQuantities,
  validQuantity,
  type Quantity,
  type QuantityResult,
} from "./values.ts";

/** The release of this module's mapping rules; pinned in every manifest. */
export const LOT_ADAPTER_RELEASE = "lot-adapter-c-v1";
/** The shape of the outer manifest. */
export const LOTS_ON_SELECTION_MANIFEST_SCHEMA = "lots-on-selection-manifest-v1";

/**
 * The event kinds this adapter reads (a closed list). `trade` and
 * `corporate_action` are reserved names: the 0032 kind CHECK admits neither
 * (ADR 0054, "Later": the kind-CHECK widening for trades and FX, and the
 * securities writer, do not exist), so only a hand-built selection carries
 * them. `transfer` is the 0032 kind; a transfer that moves a security
 * quantity is held (`transfer_contract_pending`). An FX conversion moves no
 * security quantity and is not read. Renaming any of them changes
 * `LOT_ADAPTER_RELEASE`.
 */
export const LOT_ADAPTER_KINDS = ["trade", "transfer", "corporate_action"] as const;
export type LotAdapterKind = (typeof LOT_ADAPTER_KINDS)[number];
/**
 * The states of a reserved `trade` that move a quantity (a closed list; no
 * state family for trades exists yet). A `trade` in state `unknown` with no
 * legs and no claims is a withdrawal; every other state is `writer_unsupported`.
 */
export const LOT_TRADE_STATES = ["executed", "settled"] as const;

/** `instrument_mappings.status` (CORE 0018). Only the first two place a book. */
export const LOT_INSTRUMENT_STATUSES = [
  "identified",
  "provider-local",
  "aggregate",
  "unresolved",
] as const;
export type LotInstrumentStatus = (typeof LOT_INSTRUMENT_STATUSES)[number];
const PLACEABLE_STATUSES: readonly LotInstrumentStatus[] = ["identified", "provider-local"];
/** The identity subject a seal pins for a leg unit (the `REVISION_OF` prefix). */
export const INSTRUMENT_MAPPING_PREFIX = "instrument_mapping:";

/**
 * Why a revision's input was held, or what a mapped input does not state.
 * Closed; each code belongs to one group below.
 */
export const LOT_ADAPTER_CODES = [
  // No writer or contract exists for what the revision is.
  "security_quantity_writer_missing",
  "transfer_contract_pending",
  "corporate_action_unsupported",
  // The log does not place the revision.
  "knowledge_unlogged",
  // The touched book needs review.
  "identity_changed",
  "claim_conflict",
  "alias_conflict",
  "revision_chain_inconsistent",
  "writer_unsupported",
  "instrument_unresolved",
  "holder_unresolved",
  // A mapped input that does not state something (the engine keeps it unknown).
  "time_role_missing",
  "consideration_missing",
  "fee_unknown",
  "fx_rate_missing",
] as const;
export type LotAdapterCode = (typeof LOT_ADAPTER_CODES)[number];
const UNSUPPORTED_CODES: readonly LotAdapterCode[] = [
  "security_quantity_writer_missing",
  "transfer_contract_pending",
  "corporate_action_unsupported",
];
const INDETERMINATE_CODES: readonly LotAdapterCode[] = ["knowledge_unlogged"];
/** Codes that never hold an input: they travel with it and the engine keeps the value unknown. */
export const LOT_ADAPTER_NOTE_CODES = [
  "time_role_missing",
  "consideration_missing",
  "fee_unknown",
  "fx_rate_missing",
] as const satisfies readonly LotAdapterCode[];
const isNote = (code: LotAdapterCode) =>
  (LOT_ADAPTER_NOTE_CODES as readonly LotAdapterCode[]).includes(code);

export interface LotAdapterHolder {
  /** A resolved account id (`accounts.id`). */
  accountId: string;
  /** Opaque to the adapter and the engine (ADR 0051); which source decides it is open (#545, #546). */
  wrapperKey: string;
}

/**
 * The identity mapping of one leg unit, as the caller read it: the unit is an
 * instrument identifier id, its mapping subject is
 * `instrument_mapping:<unitRef>`, and the seal of a revision that moves it
 * must pin that subject at `mappingRevision`.
 */
export interface LotInstrumentMapping {
  unitRef: string;
  mappingRevision: number;
  /** The book's instrument: `instrument:<instruments.id>`. */
  instrumentRef: string;
  status: LotInstrumentStatus;
  /** Null when nothing recorded says which class it is (a listed share and a fund unit are both `security`). */
  instrumentClass: InstrumentClass | null;
}

/** A person's specific-identification choice for one disposal revision; read as given, never repaired. */
export interface LotSelectionChoice {
  /** `event:<id>@<revision>` of the disposal. */
  disposalRef: string;
  selections: LotSelection[];
}

export interface LotAdapterRequest {
  holders: LotAdapterHolder[];
  instruments: LotInstrumentMapping[];
  lotSelections: LotSelectionChoice[];
  /** The caller's explicit policy; null is refused by the engine (`policy_missing`). */
  policy: LotPolicy | null;
}

export interface LotBookKey {
  holderRef: string;
  instrumentRef: string;
  wrapperKey: string;
}

export const LOT_ADAPTER_OUTCOMES = ["mapped", "held", "no_movement"] as const;
export type LotAdapterOutcome = (typeof LOT_ADAPTER_OUTCOMES)[number];

/** One revision the adapter read (a security claim, an instrument leg, or a reserved kind). */
export interface LotAdapterEntry {
  /** `event:<id>@<revision>`. */
  ref: string;
  /**
   * `mapped`: an input for the engine (fed unless its book is held);
   * `held`: not an input, for the codes given; `no_movement`: a withdrawal
   * (a `trade` in state `unknown` with no legs and no claims).
   */
  outcome: LotAdapterOutcome;
  /** In `LOT_ADAPTER_CODES` order. */
  codes: LotAdapterCode[];
  /** The roles `time_role_missing` refers to. */
  missingTimeRoles: ("trade" | "settlement")[];
  /** The books it touches; empty when no leg places it in one. */
  books: LotBookKey[];
}

export const LOT_ADAPTER_BOOK_STATUSES = [
  "fed",
  "unsupported",
  "indeterminate",
  "needs_review",
] as const;
export type LotAdapterBookStatus = (typeof LOT_ADAPTER_BOOK_STATUSES)[number];

export interface LotAdapterBook extends LotBookKey {
  /** `fed` when every revision touching it was mapped; otherwise the worst group of its codes. */
  status: LotAdapterBookStatus;
  /** The holding codes of the revisions touching it (notes excluded). */
  codes: LotAdapterCode[];
  refs: string[];
}

export interface LotAdaptation {
  adapterRelease: typeof LOT_ADAPTER_RELEASE;
  contract: typeof LOT_INPUT_CONTRACT;
  /** `security-quantity` claims of the selected revisions. Zero means `security_quantity_writer_missing`. */
  securityClaims: number;
  /** Selected revisions the adapter does not read (no security claim, no instrument leg, another kind). */
  otherRevisions: number;
  /** The inputs of fed books, sorted by ref. */
  inputs: LotInput[];
  entries: LotAdapterEntry[];
  books: LotAdapterBook[];
  /** `disposalRef`s of the request's choices no fed disposal took (a stale or out-of-scope ref). */
  unusedLotSelections: string[];
  aliasRuleVersions: string[];
}

export type LotAdaptationResult =
  | { ok: true; adaptation: LotAdaptation }
  | { ok: false; error: { code: "invalid_request"; refs: string[] } };

// ---------------------------------------------------------------------------
// Request validation (exact keys)

function validHolder(value: unknown): value is LotAdapterHolder {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["accountId", "wrapperKey"]) &&
    isText(value.accountId, 248) &&
    isText(value.wrapperKey, 256)
  );
}

function validMapping(value: unknown): value is LotInstrumentMapping {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "unitRef",
      "mappingRevision",
      "instrumentRef",
      "status",
      "instrumentClass",
    ]) &&
    isText(value.unitRef, 128) &&
    isSafeInt(value.mappingRevision, 1) &&
    isText(value.instrumentRef, 256) &&
    isOneOf(LOT_INSTRUMENT_STATUSES)(value.status) &&
    (value.instrumentClass === null || isOneOf(INSTRUMENT_CLASSES)(value.instrumentClass))
  );
}

function validChoice(value: unknown): value is LotSelectionChoice {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["disposalRef", "selections"]) &&
    isText(value.disposalRef, 512) &&
    isArrayOf(
      (item: unknown): item is LotSelection =>
        isRecord(item) &&
        hasExactKeys(item, ["lotId", "quantity"]) &&
        isText(item.lotId, 1024) &&
        validQuantity(item.quantity),
      10_000,
    )(value.selections)
  );
}

/** Shape only, unknown keys rejected; one entry per account, unit and disposal. */
export function validLotAdapterRequest(value: unknown): value is LotAdapterRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["holders", "instruments", "lotSelections", "policy"]) ||
    !isArrayOf(validHolder, 64)(value.holders) ||
    !isArrayOf(validMapping, 1_000)(value.instruments) ||
    !isArrayOf(validChoice, 10_000)(value.lotSelections) ||
    !(value.policy === null || validLotPolicy(value.policy))
  )
    return false;
  const distinct = (items: string[]) => new Set(items).size === items.length;
  return (
    distinct(value.holders.map((holder) => holder.accountId)) &&
    distinct(value.instruments.map((mapping) => mapping.unitRef)) &&
    distinct(value.lotSelections.map((choice) => choice.disposalRef))
  );
}

// ---------------------------------------------------------------------------
// Mapping one revision

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bookText = (book: LotBookKey) =>
  JSON.stringify([book.holderRef, book.instrumentRef, book.wrapperKey]);
const ZERO = integerDecimal(0);
/** Placeholder unit of a fee nobody stated: its value is absent, so the engine never reads the unit. */
const UNSTATED_FEE_UNIT = "unit:not-stated";

const moves = (leg: SelectedLeg) =>
  leg.effect === "movement" ||
  (leg.effect === "undeclared" && (leg.role === "increase" || leg.role === "decrease"));

/** True for an exact value below zero (or at zero when `allowZero` is false); absent values pass. */
function badSign(quantity: Quantity, allowZero: boolean): boolean {
  if (quantity.value.status !== "exact") return false;
  const order = compareDecimals(quantity.value.value, ZERO);
  return allowZero ? order < 0 : order <= 0;
}

interface Context {
  mappings: Map<string, LotInstrumentMapping>;
  holders: Map<string, LotAdapterHolder>;
  choices: Map<string, LotSelectionChoice>;
  costUnitRef: string | null;
  selectorUnsupported: Map<string, Set<string>>;
  keyConflicts: Set<string>;
  aliasConflicts: Set<string>;
}

interface Mapped {
  entry: LotAdapterEntry;
  input: LotInput | null;
}

/** The books a revision's instrument legs place it in (any shape). */
function touchedBooks(revision: SelectedAdoptedRevision, context: Context): LotBookKey[] {
  const books = new Map<string, LotBookKey>();
  for (const leg of revision.legs) {
    const mapping = context.mappings.get(leg.quantity.unitRef);
    const holder = leg.accountId === null ? undefined : context.holders.get(leg.accountId);
    if (mapping === undefined || holder === undefined) continue;
    const book = {
      holderRef: `account:${holder.accountId}`,
      instrumentRef: mapping.instrumentRef,
      wrapperKey: holder.wrapperKey,
    };
    books.set(bookText(book), book);
  }
  return [...books.values()].sort((a, b) => cmp(bookText(a), bookText(b)));
}

function timeOf(
  revision: SelectedAdoptedRevision,
  role: "trade" | "settlement",
): TemporalValue | null | "duplicate" {
  const found = revision.times.filter((time) => time.role === role);
  if (found.length > 1) return "duplicate";
  return found[0]?.time ?? null;
}

/**
 * The cash side of a trade: consideration and fees, or the codes that stop it.
 * `direction` is the role the consideration must have (cash out for an
 * acquisition, cash in for a disposal).
 */
function cashSide(
  security: SelectedLeg,
  cashLegs: SelectedLeg[],
  kind: "acquisition" | "disposal",
  codes: Set<LotAdapterCode>,
): { consideration: Quantity | null; fees: Quantity[] } {
  const direction = kind === "acquisition" ? "decrease" : "increase";
  const movements = cashLegs.filter(moves);
  const unsupported = () => {
    codes.add("writer_unsupported");
    return { consideration: null, fees: [] };
  };
  if (cashLegs.length === 0) {
    // No cash side at all: neither the consideration nor the fees are stated.
    codes.add("consideration_missing");
    codes.add("fee_unknown");
    return {
      consideration: null,
      fees: [absentQuantity(UNSTATED_FEE_UNIT, "missing", "fee_unknown")],
    };
  }
  if (movements.length > 1) return unsupported();
  if (movements.length === 1) {
    const movement = movements[0]!;
    if (movement.role !== direction) return unsupported();
    const fees: Quantity[] = [];
    for (const leg of cashLegs) {
      if (leg === movement) continue;
      if (
        leg.effect !== "breakdown" ||
        leg.ofLegIndex !== movement.legIndex ||
        leg.role !== "fee" ||
        leg.quantity.unitRef !== movement.quantity.unitRef
      )
        return unsupported();
      fees.push(leg.quantity);
    }
    if ([movement.quantity, ...fees].some((quantity) => badSign(quantity, true)))
      return unsupported();
    if (fees.some((fee) => fee.value.status !== "exact")) codes.add("fee_unknown");
    // The movement is what crossed the cash account; its fee breakdowns are
    // inside it (paid on top of the principal) or were deducted from it
    // (received net of them).
    let consideration: Quantity | null = movement.quantity;
    for (const fee of fees) {
      if (consideration === null) break;
      const next: QuantityResult =
        kind === "acquisition"
          ? subtractQuantities(consideration, fee)
          : addQuantities(consideration, fee);
      consideration = next.ok ? next.quantity : null;
    }
    if (consideration === null || consideration.value.status !== "exact") {
      codes.add("consideration_missing");
      return { consideration: null, fees };
    }
    if (badSign(consideration, true)) return unsupported();
    return { consideration, fees };
  }
  // No cash movement: one correspondence of the security movement states the
  // consideration, and correspondences with the fee role state the fees.
  const stated = cashLegs.filter(
    (leg) => leg.effect === "correspondence" && leg.ofLegIndex === security.legIndex,
  );
  if (stated.length !== cashLegs.length) return unsupported();
  const considerations = stated.filter((leg) => leg.role === "increase" || leg.role === "decrease");
  const fees = stated.filter((leg) => leg.role === "fee").map((leg) => leg.quantity);
  if (considerations.length !== 1 || considerations.length + fees.length !== stated.length)
    return unsupported();
  const consideration = considerations[0]!;
  if (consideration.role !== direction) return unsupported();
  if ([consideration.quantity, ...fees].some((quantity) => badSign(quantity, true)))
    return unsupported();
  if (fees.some((fee) => fee.value.status !== "exact")) codes.add("fee_unknown");
  if (consideration.quantity.value.status !== "exact") {
    codes.add("consideration_missing");
    return { consideration: null, fees };
  }
  return { consideration: consideration.quantity, fees };
}

function mapRevision(revision: SelectedAdoptedRevision, context: Context): Mapped | null {
  const ref = lotInputRefText({
    source: "event",
    eventId: revision.eventId,
    revision: revision.revision,
  });
  const kind = revision.kind as string;
  const securityClaims = revision.claims.filter((claim) => claim.book === "security-quantity");
  const instrumentLegs = revision.legs.filter((leg) => context.mappings.has(leg.quantity.unitRef));
  const reserved = kind === "trade" || kind === "corporate_action";
  if (securityClaims.length === 0 && instrumentLegs.length === 0 && !reserved) return null;

  const codes = new Set<LotAdapterCode>();
  const missingTimeRoles: ("trade" | "settlement")[] = [];
  const books = touchedBooks(revision, context);
  const entry = (outcome: LotAdapterOutcome): LotAdapterEntry => ({
    ref,
    outcome,
    codes: LOT_ADAPTER_CODES.filter((code) => codes.has(code)),
    missingTimeRoles,
    books,
  });

  // Dispositions the selector reports, and conflicts it would report.
  if (revision.status === "knowledge_unlogged") codes.add("knowledge_unlogged");
  if (revision.status === "chain_inconsistent") codes.add("revision_chain_inconsistent");
  for (const flag of revision.flags)
    if (flag === "identity_changed" || flag === "claim_conflict" || flag === "alias_conflict")
      codes.add(flag);
  for (const claim of securityClaims) {
    if (context.keyConflicts.has(claim.key)) codes.add("claim_conflict");
    if (claim.aliasClass !== null && context.aliasConflicts.has(claim.aliasClass))
      codes.add("alias_conflict");
  }
  const selectorReasons = context.selectorUnsupported.get(
    `${revision.eventId}@${revision.revision}`,
  );
  if (selectorReasons !== undefined) {
    // Today the selector reports every security-quantity claim as a book no
    // writer is admitted for; anything else is a shape it could not read.
    if (selectorReasons.has("book_unsupported")) codes.add("security_quantity_writer_missing");
    if ([...selectorReasons].some((reason) => reason !== "book_unsupported"))
      codes.add("writer_unsupported");
  } else if (revision.flags.includes("unsupported")) codes.add("writer_unsupported");

  if (kind === "transfer") {
    codes.add("transfer_contract_pending");
    return { entry: entry("held"), input: null };
  }
  if (kind === "corporate_action") {
    codes.add("corporate_action_unsupported");
    return { entry: entry("held"), input: null };
  }
  if (kind !== "trade") {
    codes.add("writer_unsupported");
    return { entry: entry("held"), input: null };
  }
  if (
    revision.state === "unknown" &&
    revision.legs.length === 0 &&
    revision.claims.length === 0 &&
    codes.size === 0
  )
    return { entry: entry("no_movement"), input: null };
  if (!(LOT_TRADE_STATES as readonly string[]).includes(revision.state))
    codes.add("writer_unsupported");
  // A movement of a security quantity is held by a claim in its book.
  if (securityClaims.length === 0) codes.add("writer_unsupported");

  // The security side: exactly one movement in an instrument unit.
  const securityMoves = instrumentLegs.filter(moves);
  if (instrumentLegs.length !== securityMoves.length || securityMoves.length > 1)
    codes.add("writer_unsupported");
  if (securityMoves.length === 0) {
    codes.add(instrumentLegs.length === 0 ? "instrument_unresolved" : "writer_unsupported");
    return { entry: entry("held"), input: null };
  }
  const security = securityMoves[0]!;
  const mapping = context.mappings.get(security.quantity.unitRef)!;
  const pinned = revision.seal?.identityPins[`${INSTRUMENT_MAPPING_PREFIX}${mapping.unitRef}`];
  if (
    !PLACEABLE_STATUSES.includes(mapping.status) ||
    mapping.instrumentClass === null ||
    (revision.seal !== null && pinned !== mapping.mappingRevision)
  )
    codes.add("instrument_unresolved");
  const holder = security.accountId === null ? undefined : context.holders.get(security.accountId);
  if (holder === undefined) codes.add("holder_unresolved");
  if (badSign(security.quantity, false)) codes.add("writer_unsupported");
  const lotKind: Extract<LotInputKind, "acquisition" | "disposal"> =
    security.role === "increase" ? "acquisition" : "disposal";
  const cashLegs = revision.legs.filter((leg) => !context.mappings.has(leg.quantity.unitRef));
  const { consideration, fees } = cashSide(security, cashLegs, lotKind, codes);
  if (
    context.costUnitRef !== null &&
    [consideration, ...fees].some(
      (quantity) =>
        quantity !== null &&
        quantity.unitRef !== context.costUnitRef &&
        quantity.unitRef !== UNSTATED_FEE_UNIT,
    )
  )
    // Amounts outside the cost unit and no rate in evidence: the engine keeps them unknown.
    codes.add("fx_rate_missing");

  const time = { trade: timeOf(revision, "trade"), settlement: timeOf(revision, "settlement") };
  if (time.trade === "duplicate" || time.settlement === "duplicate")
    codes.add("writer_unsupported");
  const missing = (role: "trade" | "settlement"): TemporalValue => {
    missingTimeRoles.push(role);
    codes.add("time_role_missing");
    return { kind: "unknown", reasonCode: "time_role_missing" };
  };
  const trade = time.trade === null || time.trade === "duplicate" ? missing("trade") : time.trade;
  const settlement =
    time.settlement === null || time.settlement === "duplicate"
      ? missing("settlement")
      : time.settlement;

  if ([...codes].some((code) => !isNote(code)) || holder === undefined)
    return { entry: entry("held"), input: null };
  const choice = lotKind === "disposal" ? context.choices.get(ref) : undefined;
  const input: LotInput = {
    contract: LOT_INPUT_CONTRACT,
    ref: { source: "event", eventId: revision.eventId, revision: revision.revision },
    kind: lotKind,
    holderRef: `account:${holder.accountId}`,
    instrumentRef: mapping.instrumentRef,
    wrapperKey: holder.wrapperKey,
    instrumentClass: mapping.instrumentClass!,
    time: { trade, settlement },
    // The leg's unit is the identifier; the book's unit is the instrument it maps to.
    quantity: { unitRef: mapping.instrumentRef, value: security.quantity.value },
    consideration,
    fees,
    fx: null,
    split: null,
    lotSelections: choice === undefined ? null : choice.selections,
  };
  if (!validLotInput(input)) {
    codes.add("writer_unsupported");
    return { entry: entry("held"), input: null };
  }
  return { entry: entry("mapped"), input };
}

// ---------------------------------------------------------------------------
// The selection as lot inputs

function severity(codes: readonly LotAdapterCode[]): LotAdapterBookStatus {
  if (codes.some((code) => UNSUPPORTED_CODES.includes(code))) return "unsupported";
  if (codes.some((code) => INDETERMINATE_CODES.includes(code))) return "indeterminate";
  return codes.length === 0 ? "fed" : "needs_review";
}

/**
 * Map the selected revisions to lot inputs. A book is fed to the engine only
 * when every revision touching it was mapped; one held revision holds the
 * whole book, because a missing input would change every later allocation.
 */
export function adaptSelectionToLots(
  selection: AdoptedSelection,
  request: LotAdapterRequest,
): LotAdaptationResult {
  if (!validLotAdapterRequest(request))
    return { ok: false, error: { code: "invalid_request", refs: ["request"] } };
  const policy = request.policy;
  const selectorUnsupported = new Map<string, Set<string>>();
  for (const row of selection.unsupported) {
    const key = `${row.eventId}@${row.revision}`;
    selectorUnsupported.set(key, (selectorUnsupported.get(key) ?? new Set()).add(row.reasonCode));
  }
  // Holders of each security key and alias class among the selected revisions:
  // one row claimed by two events never yields two inputs (B3), whether or not
  // the selector flagged it.
  const keyEvents = new Map<string, Set<string>>();
  const aliasEvents = new Map<string, Set<string>>();
  const aliasRules = new Set<string>();
  let securityClaims = 0;
  for (const revision of selection.revisions)
    for (const claim of revision.claims) {
      if (claim.aliasClass !== null) {
        try {
          const parsed = JSON.parse(claim.aliasClass) as unknown;
          if (Array.isArray(parsed) && typeof parsed[3] === "string") aliasRules.add(parsed[3]);
        } catch {
          // A stored class always parses (0070 checks json_valid).
        }
      }
      if (claim.book !== "security-quantity") continue;
      securityClaims += 1;
      keyEvents.set(claim.key, (keyEvents.get(claim.key) ?? new Set()).add(revision.eventId));
      if (claim.aliasClass !== null)
        aliasEvents.set(
          claim.aliasClass,
          (aliasEvents.get(claim.aliasClass) ?? new Set()).add(
            `${revision.eventId}\u0000${claim.key}`,
          ),
        );
    }
  const context: Context = {
    mappings: new Map(request.instruments.map((mapping) => [mapping.unitRef, mapping])),
    holders: new Map(request.holders.map((holder) => [holder.accountId, holder])),
    choices: new Map(request.lotSelections.map((choice) => [choice.disposalRef, choice])),
    costUnitRef:
      policy !== null && policy.fx === "convert-at-input-rate" ? policy.costUnitRef : null,
    selectorUnsupported,
    keyConflicts: new Set(
      [...keyEvents].filter(([, events]) => events.size > 1).map(([key]) => key),
    ),
    aliasConflicts: new Set(
      [...aliasEvents].filter(([, events]) => events.size > 1).map(([alias]) => alias),
    ),
  };

  const entries: LotAdapterEntry[] = [];
  const inputs = new Map<string, LotInput>();
  let otherRevisions = 0;
  for (const revision of selection.revisions) {
    const mapped = mapRevision(revision, context);
    if (mapped === null) {
      otherRevisions += 1;
      continue;
    }
    entries.push(mapped.entry);
    if (mapped.input !== null) inputs.set(mapped.entry.ref, mapped.input);
  }
  entries.sort((a, b) => cmp(a.ref, b.ref));

  // Books: held by any revision that touches them and was not mapped, and by
  // two classes for one instrument (the engine would refuse the whole run).
  const books = new Map<string, { key: LotBookKey; codes: Set<LotAdapterCode>; refs: string[] }>();
  for (const entry of entries)
    for (const key of entry.books) {
      const text = bookText(key);
      const book = books.get(text) ?? { key, codes: new Set(), refs: [] };
      if (entry.outcome === "held")
        for (const code of entry.codes) if (!isNote(code)) book.codes.add(code);
      book.refs.push(entry.ref);
      books.set(text, book);
    }
  for (const book of books.values()) {
    const classes = new Set(
      book.refs.flatMap((ref) => {
        const input = inputs.get(ref);
        return input === undefined ? [] : [input.instrumentClass];
      }),
    );
    if (classes.size > 1) book.codes.add("instrument_unresolved");
  }
  const bookList: LotAdapterBook[] = [...books.values()]
    .map(({ key, codes, refs }) => {
      const ordered = LOT_ADAPTER_CODES.filter((code) => codes.has(code));
      return {
        ...key,
        status: severity(ordered),
        codes: ordered,
        refs: [...new Set(refs)].sort(cmp),
      };
    })
    .sort((a, b) => cmp(bookText(a), bookText(b)));
  const fed = new Set(bookList.filter((book) => book.status === "fed").map(bookText));
  const fedInputs = [...inputs.entries()]
    .filter(([, input]) => fed.has(bookText(input)))
    .sort(([a], [b]) => cmp(a, b))
    .map(([, input]) => input);
  const taken = new Set(
    fedInputs
      .filter((input) => input.lotSelections !== null)
      .map((input) => lotInputRefText(input.ref)),
  );
  return {
    ok: true,
    adaptation: {
      adapterRelease: LOT_ADAPTER_RELEASE,
      contract: LOT_INPUT_CONTRACT,
      securityClaims,
      otherRevisions,
      inputs: fedInputs,
      entries,
      books: bookList,
      unusedLotSelections: request.lotSelections
        .map((choice) => choice.disposalRef)
        .filter((ref) => !taken.has(ref))
        .sort(cmp),
      aliasRuleVersions: [...aliasRules].sort(cmp),
    },
  };
}

// ---------------------------------------------------------------------------
// Composition with the engine and the outer manifest

export const LOTS_ON_SELECTION_STATUSES = [
  "unsupported",
  "refused",
  "indeterminate",
  "needs_review",
  "limited",
  "complete",
] as const;
export type LotsOnSelectionStatus = (typeof LOTS_ON_SELECTION_STATUSES)[number];

/**
 * Every reason a run can carry, in order of the status it decides: no writer
 * or contract; the engine's whole-run refusals; what the log or the time does
 * not place; what needs review; what is not stated or not known.
 */
export const LOTS_ON_SELECTION_REASONS = [
  "security_quantity_writer_missing",
  "transfer_contract_pending",
  "corporate_action_unsupported",
  "unsupported_instrument",
  "policy_missing",
  "policy_unsupported",
  "tax_rules_unverified",
  "invalid_input",
  "duplicate_ref",
  "same_event_revisions",
  "same_observation_parse_runs",
  "log_empty",
  "cut_before_log_start",
  "cut_epoch_not_current",
  "knowledge_unlogged",
  "order_tie",
  "unknown_time",
  "negative_holding",
  "snapshot_mismatch",
  "unknown_lot",
  "lot_selection_missing",
  "lot_selection_mismatch",
  "inexact_allocation",
  "value_not_exact",
  "upstream_indeterminate",
  "identity_changed",
  "claim_conflict",
  "alias_conflict",
  "revision_chain_inconsistent",
  "writer_unsupported",
  "instrument_unresolved",
  "holder_unresolved",
  "lot_selection_unused",
  "time_role_missing",
  "consideration_missing",
  "fee_unknown",
  "fx_rate_missing",
  "unknown_cost",
  "unknown_acquisition_fee",
  "unknown_proceeds",
  "unknown_disposal_fee",
  "unit_mismatch",
] as const;
export type LotsOnSelectionReason = (typeof LOTS_ON_SELECTION_REASONS)[number];
const UNSUPPORTED_REASONS: readonly LotsOnSelectionReason[] = [
  "security_quantity_writer_missing",
  "transfer_contract_pending",
  "corporate_action_unsupported",
  "unsupported_instrument",
];
const INDETERMINATE_REASONS: readonly LotsOnSelectionReason[] = [
  "log_empty",
  "cut_before_log_start",
  "cut_epoch_not_current",
  "knowledge_unlogged",
];
const REVIEW_REASONS: readonly LotsOnSelectionReason[] = [
  "identity_changed",
  "claim_conflict",
  "alias_conflict",
  "revision_chain_inconsistent",
  "writer_unsupported",
  "instrument_unresolved",
  "holder_unresolved",
  "lot_selection_unused",
];

/** Everything the answer depends on (ADR 0054, "Manifest pins"). Holds no amount but the lot choices'. */
export interface LotsOnSelectionManifest {
  schemaVersion: typeof LOTS_ON_SELECTION_MANIFEST_SCHEMA;
  selectorRelease: typeof KNOWLEDGE_SELECTOR_RELEASE;
  adapterRelease: typeof LOT_ADAPTER_RELEASE;
  contract: typeof LOT_INPUT_CONTRACT;
  engineVersion: typeof LOT_ENGINE_VERSION;
  cut: { requested: KnowledgeCut; resolved: ResolvedCut; knownAt: string | null };
  setVersion: string;
  /** The current identity epoch and every pin of the selected revisions' seals: `[ref, subject, revision]`. */
  identity: { epoch: string; pins: [string, string, number][] };
  aliasRuleVersions: string[];
  coverageProducer: typeof COVERAGE_PRODUCER_NONE;
  /** No snapshot input is produced: provider holdings are claims, never lots. */
  snapshotContexts: string[];
  holders: LotAdapterHolder[];
  instruments: LotInstrumentMapping[];
  lotSelections: LotSelectionChoice[];
  policyRef: string | null;
  /** The policy's FX policy ref; no rate ref, since no rate is in evidence. */
  fx: { policyRef: string | null; rateRefs: string[] };
  /** `canonicalDigest` of the engine's manifest; null when the engine refused the run. */
  lotsManifestDigest: string | null;
}

export interface LotsOnSelection {
  status: LotsOnSelectionStatus;
  reasons: LotsOnSelectionReason[];
  adaptation: LotAdaptation;
  lots: LotResult;
  manifest: LotsOnSelectionManifest;
  /** `canonicalDigest` of the manifest. */
  contextId: string;
}

export type LotsOnSelectionResult =
  | { ok: true; result: LotsOnSelection }
  | { ok: false; error: { code: "invalid_request"; refs: string[] } };

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Adapt, run `computeLots` under the request's policy (with whatever inputs
 * the fed books hold, none included) and pin everything in the outer
 * manifest. The status says what the answer is before what it computed:
 * `unsupported` (no security claim, a transfer, a corporate action, an
 * unsupported class), `refused` (the engine refused the run), `indeterminate`
 * (the log or the time does not place something), `needs_review`, `limited`
 * (something not stated or not known), else `complete`. Every applicable
 * reason is listed. No gain, no tax.
 */
export async function lotsOnSelection(
  selection: AdoptedSelection,
  request: LotAdapterRequest,
): Promise<LotsOnSelectionResult> {
  const adapted = adaptSelectionToLots(selection, request);
  if (!adapted.ok) return adapted;
  const adaptation = adapted.adaptation;
  const lots = computeLots(adaptation.inputs, request.policy);

  const reasons = new Set<LotsOnSelectionReason>();
  let indeterminate = false;
  let limited = false;
  if (adaptation.securityClaims === 0) reasons.add("security_quantity_writer_missing");
  for (const reason of selection.coverage.reasons) reasons.add(reason);
  for (const entry of adaptation.entries) for (const code of entry.codes) reasons.add(code);
  for (const book of adaptation.books) for (const code of book.codes) reasons.add(code);
  if (adaptation.unusedLotSelections.length > 0) reasons.add("lot_selection_unused");
  if (adaptation.entries.some((entry) => entry.codes.some(isNote))) limited = true;
  if (lots.status === "refused") reasons.add(lots.reasonCode);
  else {
    if (lots.partition !== "complete") limited = true;
    for (const book of lots.books) {
      if (book.status === "refused") {
        reasons.add(book.reasonCode);
        continue;
      }
      if (book.indeterminateFrom !== null) {
        indeterminate = true;
        reasons.add(book.indeterminateFrom.reasonCode);
      }
      for (const disposal of book.disposals)
        for (const code of disposal.reasonCodes) reasons.add(code);
      for (const lot of book.remainingLots ?? []) {
        if (lot.remainingCost.status === "unknown") reasons.add("unknown_cost");
        if (lot.remainingAcquisitionFees?.status === "unknown")
          reasons.add("unknown_acquisition_fee");
      }
    }
  }
  const ordered = LOTS_ON_SELECTION_REASONS.filter((reason) => reasons.has(reason));
  const has = (group: readonly LotsOnSelectionReason[]) =>
    ordered.some((reason) => group.includes(reason));
  const status: LotsOnSelectionStatus = has(UNSUPPORTED_REASONS)
    ? "unsupported"
    : lots.status === "refused"
      ? "refused"
      : indeterminate || has(INDETERMINATE_REASONS)
        ? "indeterminate"
        : has(REVIEW_REASONS)
          ? "needs_review"
          : limited || ordered.length > 0
            ? "limited"
            : "complete";

  const pins: [string, string, number][] = selection.revisions
    .flatMap((revision) =>
      Object.entries(revision.seal?.identityPins ?? {}).map(
        ([subject, pinned]): [string, string, number] => [
          `${revision.eventId}@${revision.revision}`,
          subject,
          pinned,
        ],
      ),
    )
    .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  const policy = request.policy;
  const manifest: LotsOnSelectionManifest = {
    schemaVersion: LOTS_ON_SELECTION_MANIFEST_SCHEMA,
    selectorRelease: KNOWLEDGE_SELECTOR_RELEASE,
    adapterRelease: LOT_ADAPTER_RELEASE,
    contract: LOT_INPUT_CONTRACT,
    engineVersion: LOT_ENGINE_VERSION,
    cut: {
      requested: plain(selection.requestedCut),
      resolved: { coreEpoch: selection.cut.coreEpoch, commitSeq: selection.cut.commitSeq },
      knownAt: selection.cutKnownAt,
    },
    setVersion: selection.setVersion,
    identity: { epoch: selection.currentIdentityEpoch, pins },
    aliasRuleVersions: adaptation.aliasRuleVersions,
    coverageProducer: COVERAGE_PRODUCER_NONE,
    snapshotContexts: [],
    holders: plain(request.holders).sort((a, b) => cmp(a.accountId, b.accountId)),
    instruments: plain(request.instruments).sort((a, b) => cmp(a.unitRef, b.unitRef)),
    lotSelections: plain(request.lotSelections).sort((a, b) => cmp(a.disposalRef, b.disposalRef)),
    policyRef: policy === null ? null : lotPolicyRef(policy),
    fx: { policyRef: policy?.fxPolicyRef ?? null, rateRefs: [] },
    lotsManifestDigest: lots.status === "computed" ? await canonicalDigest(lots.manifest) : null,
  };
  return {
    ok: true,
    result: {
      status,
      reasons: ordered,
      adaptation,
      lots,
      manifest,
      contextId: await canonicalDigest(manifest),
    },
  };
}
