// Price and FX selection at an as-of, under an explicit, versioned policy
// (ADR 0050, docs/calculation-and-reports.md §1–§2). Pure: no I/O, no clock,
// and no default policy anywhere — every function takes the policy it applies,
// and the policy's digest goes into the selection manifest, so the same
// candidates under the same policy always give the same answer and a changed
// policy gives a new context (INV04, INV09).
//
// A selection runs six checks in a fixed order, and its answer is either one
// promoted price or one closed refusal code, never a zero and never a
// fallback (INV05):
//
//   1. filter, counting every candidate it removes by a closed exclusion code
//      (rule, kind, effective-time shape, basis, date-only policy, not
//      strictly before the bound);
//   2. nothing left                                   → `missing`;
//   3. more than one admitted rule left and the policy refuses overlap
//                                                     → `sources_overlap`;
//   4. rank by effective instant (a date-only price by its civil date in the
//      policy's zone); a top that cannot be ordered   → `time_incomparable`;
//   5. freshness from the top's civil date to the as-of date; a business-day
//      rule without a calendar covering the span     → `calendar_missing`;
//      older than the policy allows                   → `stale` (the id and age
//      are reported, the price is never used);
//   6. candidates tied at the top instant must agree per unit of base
//      (`a.quote × b.baseQty = b.quote × a.baseQty`, exactly) → else
//      `disagree`; when they agree the later recorded, then the higher id,
//      is selected and the rest corroborate it.
//
// FX goes through one pivot (JPY for the only FX rule there is). A currency
// into the pivot is one exact hop through `valueAtPrice`; out of the pivot it
// divides, which needs an explicit rounding policy, applied once; a currency
// pair that no admitted rule can quote is `unsupported_pair`. Nothing is ever
// converted 1:1.
//
// The proposed policy values (freshness windows, accepted bases, the refusal of
// overlapping sources, the JPY pivot without an inverse) are named constants
// whose names say they are proposals. Nothing in production code uses them;
// ADR 0050 lists the questions the owner has not decided.
import type { RoundingInputs } from "./calculation.ts";
import { canonicalDigest } from "./context.ts";
import { hasExactKeys, isOneOf, isRecord, isRefList, isSafeInt, isText } from "./guards.ts";
import { PRICE_KINDS, valueAtPrice, type PriceKind, type PriceObservation } from "./metrics.ts";
import {
  PRICE_RULE_IDS,
  SBI_SHINSEI_FX_PER_UNIT_CURRENCIES,
  type PriceClaimKind,
  type PriceRuleId,
} from "./price-sources.ts";
import {
  addDays,
  civilDateOfInstant,
  compareTemporal,
  daysBetween,
  daysFromCivil,
  formatLocalDate,
  parseInstant,
  parseLocalDate,
  TEMPORAL_BASES,
  validInstantText,
  validLocalDateText,
  validTemporalValue,
  validZone,
  type CivilDate,
  type TemporalBasis,
  type TemporalValue,
} from "./time.ts";
import {
  decimalEquals,
  divideDecimals,
  exactQuantity,
  multiplyDecimals,
  ROUNDING_MODES,
  type ExactDecimal,
  type Quantity,
  type RoundingMode,
} from "./values.ts";

export const MARKET_DATA_SELECTION_SCHEMA = "market-data-selection-v1";

/** Why a key has no selected price. Closed; each is a reason, never a zero. */
export const PRICE_SELECTION_REFUSALS = [
  "missing",
  "stale",
  "disagree",
  "sources_overlap",
  "time_incomparable",
  "calendar_missing",
] as const;
export type PriceSelectionRefusal = (typeof PRICE_SELECTION_REFUSALS)[number];

/** Why a candidate was not considered. Counted per selection, never dropped silently. */
export const CANDIDATE_EXCLUSIONS = [
  "rule_not_admitted",
  "kind_not_admitted",
  "basis_not_admitted",
  "date_only_excluded",
  "effective_at_or_after_bound",
  "invalid_effective_time",
] as const;
export type CandidateExclusion = (typeof CANDIDATE_EXCLUSIONS)[number];
export type ExclusionCounts = Record<CandidateExclusion, number>;

/** Why a value could not be stated in the base unit. A price or FX leg's own refusal is passed through. */
export const CONVERSION_REFUSALS = [
  ...PRICE_SELECTION_REFUSALS,
  "unsupported_pair",
  "rounding_policy_missing",
  "instrument_mismatch",
  "quantity_not_exact",
] as const;
export type ConversionRefusal = (typeof CONVERSION_REFUSALS)[number];

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** Longest freshness window a policy may name (a century of days); bounds the read window. */
export const MAX_FRESHNESS_DAYS = 36_600;

export type Freshness =
  | { unit: "calendar-days"; maxAgeDays: number }
  | { unit: "business-days"; maxAgeDays: number; calendarRef: string };

/**
 * A market calendar, supplied as an input with its evidence. None is shipped:
 * a business-day freshness rule without one refuses with `calendar_missing`.
 * Weekdays are ISO (1 Monday … 7 Sunday); dates are civil dates in `zone`;
 * `coverage` is inclusive on both ends, and outside it the calendar says
 * nothing.
 */
export interface MarketCalendar {
  calendarRef: string;
  version: string;
  zone: string;
  coverage: { from: string; to: string };
  closedWeekdays: number[];
  closedDates: string[];
  evidenceRefs: string[];
}

export interface PriceSelectionPolicy {
  policyId: string;
  /** Rules whose prices may be selected. Their order is a priority only under `priority-order`. */
  admittedRules: PriceRuleId[];
  priceKinds: PriceKind[];
  /** Whose time a price's effective time may be: the provider's own, or the fetch instant. */
  acceptedBases: TemporalBasis[];
  /** The civil zone of the as-of date, of freshness ages and of date-only prices. */
  zone: string;
  freshness: Freshness;
  /** `exclude` counts every date-only price; `civil-date-in-zone` ranks it by its date in `zone`. */
  dateOnly: "exclude" | "civil-date-in-zone";
  multiSource: "refuse-on-overlap" | "priority-order";
  /**
   * `same-snapshot`: only prices promoted from the holding's own parse run
   * (the read applies it); `latest-in-window`: any published price.
   */
  candidateScope: "latest-in-window" | "same-snapshot";
}

/** How an amount out of the pivot is rounded: once, at the scale of the target unit. */
export interface InverseRounding {
  mode: RoundingMode;
  scaleByUnit: Record<string, number>;
}

export interface FxConversionPolicy {
  policyId: string;
  /** The one currency every FX price is quoted in. */
  pivot: string;
  /** Currencies an admitted rule can quote against the pivot; any other pair is `unsupported_pair`. */
  currencies: string[];
  /** How each currency's rate is selected; it names exactly one price kind. */
  selection: PriceSelectionPolicy;
  /** Null: an amount is never converted out of the pivot (`rounding_policy_missing`). */
  inverse: InverseRounding | null;
}

const CURRENCY = /^[A-Z]{3}$/u;
const FRESHNESS_UNITS = ["calendar-days", "business-days"] as const;
const DATE_ONLY_MODES = ["exclude", "civil-date-in-zone"] as const;
const MULTI_SOURCE_MODES = ["refuse-on-overlap", "priority-order"] as const;
const CANDIDATE_SCOPES = ["latest-in-window", "same-snapshot"] as const;

function uniqueListOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= values.length &&
    value.every(isOneOf(values)) &&
    new Set(value).size === value.length
  );
}

/** A zone name the runtime knows; an unknown zone would make every civil date null. */
function knownZone(value: unknown): value is string {
  return validZone(value) && civilDateOfInstant("2000-01-01T00:00:00Z", value) !== null;
}

export function validFreshness(value: unknown): value is Freshness {
  if (!isRecord(value) || !isOneOf(FRESHNESS_UNITS)(value.unit)) return false;
  if (!isSafeInt(value.maxAgeDays, 0, MAX_FRESHNESS_DAYS)) return false;
  return value.unit === "calendar-days"
    ? hasExactKeys(value, ["unit", "maxAgeDays"])
    : hasExactKeys(value, ["unit", "maxAgeDays", "calendarRef"]) && isText(value.calendarRef, 128);
}

export function validPriceSelectionPolicy(value: unknown): value is PriceSelectionPolicy {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "policyId",
      "admittedRules",
      "priceKinds",
      "acceptedBases",
      "zone",
      "freshness",
      "dateOnly",
      "multiSource",
      "candidateScope",
    ]) &&
    isText(value.policyId, 128) &&
    uniqueListOf(PRICE_RULE_IDS, value.admittedRules) &&
    uniqueListOf(PRICE_KINDS, value.priceKinds) &&
    uniqueListOf(TEMPORAL_BASES, value.acceptedBases) &&
    knownZone(value.zone) &&
    validFreshness(value.freshness) &&
    isOneOf(DATE_ONLY_MODES)(value.dateOnly) &&
    isOneOf(MULTI_SOURCE_MODES)(value.multiSource) &&
    isOneOf(CANDIDATE_SCOPES)(value.candidateScope)
  );
}

function validInverseRounding(value: unknown): value is InverseRounding {
  if (!isRecord(value) || !hasExactKeys(value, ["mode", "scaleByUnit"])) return false;
  if (!isOneOf(ROUNDING_MODES)(value.mode) || !isRecord(value.scaleByUnit)) return false;
  const entries = Object.entries(value.scaleByUnit);
  return (
    entries.length > 0 &&
    entries.every(([unit, scale]) => CURRENCY.test(unit) && isSafeInt(scale, 0, 4096))
  );
}

export function validFxConversionPolicy(value: unknown): value is FxConversionPolicy {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["policyId", "pivot", "currencies", "selection", "inverse"]) &&
    isText(value.policyId, 128) &&
    typeof value.pivot === "string" &&
    CURRENCY.test(value.pivot) &&
    Array.isArray(value.currencies) &&
    value.currencies.length > 0 &&
    value.currencies.length <= 256 &&
    value.currencies.every((code) => typeof code === "string" && CURRENCY.test(code)) &&
    new Set(value.currencies).size === value.currencies.length &&
    !value.currencies.includes(value.pivot) &&
    validPriceSelectionPolicy(value.selection) &&
    value.selection.priceKinds.length === 1 &&
    (value.inverse === null || validInverseRounding(value.inverse))
  );
}

export function validMarketCalendar(value: unknown): value is MarketCalendar {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "calendarRef",
      "version",
      "zone",
      "coverage",
      "closedWeekdays",
      "closedDates",
      "evidenceRefs",
    ]) ||
    !isText(value.calendarRef, 128) ||
    !isText(value.version, 64) ||
    !knownZone(value.zone) ||
    !isRecord(value.coverage) ||
    !hasExactKeys(value.coverage, ["from", "to"]) ||
    !validLocalDateText(value.coverage.from) ||
    !validLocalDateText(value.coverage.to) ||
    value.coverage.from > value.coverage.to ||
    !Array.isArray(value.closedWeekdays) ||
    !value.closedWeekdays.every((day) => isSafeInt(day, 1, 7)) ||
    new Set(value.closedWeekdays).size !== value.closedWeekdays.length ||
    value.closedWeekdays.length > 6 ||
    !Array.isArray(value.closedDates) ||
    value.closedDates.length > 100_000 ||
    !value.closedDates.every(validLocalDateText) ||
    !isRefList(value.evidenceRefs) ||
    value.evidenceRefs.length === 0
  )
    return false;
  const dates = value.closedDates as string[];
  // Sorted and unique, so the calendar's digest does not depend on input order.
  return dates.every((date, index) => index === 0 || dates[index - 1]! < date);
}

/** `sha256(canonicalJson(policy))`: what the manifest records beside the policy id. */
export async function policyDigest(
  policy: PriceSelectionPolicy | FxConversionPolicy | MarketCalendar,
): Promise<string> {
  return canonicalDigest(policy);
}

function deepFrozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFrozen(item);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Proposals. Not decisions: ADR 0050 lists the open questions. Nothing in
// production code imports these; tests and a later, owner-approved change may.
// ---------------------------------------------------------------------------

/**
 * PROPOSAL (ADR 0050, questions 1, 4, 5, 7, 9): SBI Shinsei's mid rate, at
 * most 4 calendar days old, provider or collector basis, date-only excluded,
 * overlapping sources refused.
 */
export const PROPOSED_FX_SELECTION_POLICY_V1: PriceSelectionPolicy =
  deepFrozen<PriceSelectionPolicy>({
    policyId: "proposal:fx-board-mid-selection-v1",
    admittedRules: ["fx-sbi-shinsei-board-v1"],
    priceKinds: ["reference"],
    acceptedBases: ["provider", "collector"],
    zone: "Asia/Tokyo",
    freshness: { unit: "calendar-days", maxAgeDays: 4 },
    dateOnly: "exclude",
    multiSource: "refuse-on-overlap",
    candidateScope: "latest-in-window",
  });

/**
 * PROPOSAL (ADR 0050, questions 1, 8): pivot JPY over the currencies the
 * provider's public pages quote per 1 unit; no inverse, so a non-JPY base is
 * refused with `rounding_policy_missing`.
 */
export const PROPOSED_FX_CONVERSION_POLICY_V1: FxConversionPolicy = deepFrozen<FxConversionPolicy>({
  policyId: "proposal:fx-sbi-shinsei-mid-v1",
  pivot: "JPY",
  currencies: [...SBI_SHINSEI_FX_PER_UNIT_CURRENCIES],
  selection: PROPOSED_FX_SELECTION_POLICY_V1,
  inverse: null,
});

/**
 * PROPOSAL (ADR 0050, questions 2, 3, 4, 5, 7): an SBI Securities position
 * price from the holding's own snapshot, at most 3 calendar days old.
 */
export const PROPOSED_EQUITY_SELECTION_POLICY_V1: PriceSelectionPolicy =
  deepFrozen<PriceSelectionPolicy>({
    policyId: "proposal:equity-same-snapshot-v1",
    admittedRules: ["sbi-domestic-current-price-v1", "sbi-foreign-stock-price-last-v1"],
    priceKinds: ["reference"],
    acceptedBases: ["provider", "collector"],
    zone: "Asia/Tokyo",
    freshness: { unit: "calendar-days", maxAgeDays: 3 },
    dateOnly: "exclude",
    multiSource: "refuse-on-overlap",
    candidateScope: "same-snapshot",
  });

// ---------------------------------------------------------------------------
// Bound, keys and candidates
// ---------------------------------------------------------------------------

export type KnowledgeMode = { mode: "current" } | { mode: "known-at"; knownAt: string };

/**
 * What a selection is for. `effectiveBefore` is exclusive: a price effective
 * at exactly that instant is not before it (the dated state's
 * `fetched_at < (D + 1) 00:00` in Asia/Tokyo). `asOfDate` is the civil date D
 * in the policy's zone that ages are counted to. `knowledge` says which
 * publications count: the current ones, or those known at an instant.
 */
export interface SelectionBound {
  effectiveBefore: string;
  asOfDate: string;
  knowledge: KnowledgeMode;
}

export function validSelectionBound(value: unknown): value is SelectionBound {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["effectiveBefore", "asOfDate", "knowledge"]) ||
    !validInstantText(value.effectiveBefore) ||
    !validLocalDateText(value.asOfDate) ||
    !isRecord(value.knowledge)
  )
    return false;
  const knowledge = value.knowledge;
  return knowledge.mode === "current"
    ? hasExactKeys(knowledge, ["mode"])
    : knowledge.mode === "known-at" &&
        hasExactKeys(knowledge, ["mode", "knownAt"]) &&
        validInstantText(knowledge.knownAt);
}

/** One selection: a base priced in a quote unit, of one kind. */
export interface PriceKey {
  baseInstrumentRef: string;
  quoteUnitRef: string;
  priceKind: PriceKind;
}

/** A stored price, when it was recorded, and the claim it was promoted from. */
export interface PriceCandidate {
  price: PriceObservation;
  recordedAt: string;
  claim: {
    ruleId: string;
    claimKind: PriceClaimKind;
    observationId: number;
    parseRunId: number;
    jsonPath: string;
  };
}

export type PriceSelection =
  | {
      status: "selected";
      key: PriceKey;
      candidate: PriceCandidate;
      /** Calendar or business days from the price's civil date to the as-of date. */
      ageDays: number;
      /** Other candidates at the same instant that state the same price per unit. */
      corroboratedBy: string[];
      excluded: ExclusionCounts;
      policyId: string;
    }
  | {
      status: "refused";
      key: PriceKey;
      reason: PriceSelectionRefusal;
      /** The candidates the refusal is about, sorted; their prices are never used. */
      candidateIds: string[];
      /** Set for `stale`: how old the newest candidate is. */
      ageDays: number | null;
      excluded: ExclusionCounts;
      policyId: string;
    };

function sameKey(a: PriceKey, b: PriceKey): boolean {
  return (
    a.baseInstrumentRef === b.baseInstrumentRef &&
    a.quoteUnitRef === b.quoteUnitRef &&
    a.priceKind === b.priceKind
  );
}

function zeroCounts(): ExclusionCounts {
  return Object.fromEntries(CANDIDATE_EXCLUSIONS.map((code) => [code, 0])) as ExclusionCounts;
}

/** Instant order through the instant parser; never text, never a float. */
function instantOrder(a: string, b: string): -1 | 0 | 1 | null {
  const order = compareTemporal(
    { kind: "instant", value: a, zone: "UTC", basis: "derived" },
    { kind: "instant", value: b, zone: "UTC", basis: "derived" },
  );
  return order.kind === "ordered" ? order.order : null;
}

function civil(text: string): CivilDate {
  const parsed = parseLocalDate(text);
  if (parsed === null) throw new RangeError("invalid civil date");
  return parsed;
}

/** Where an eligible candidate sits: its civil day in the policy zone, and its instant if it has one. */
interface Placed {
  candidate: PriceCandidate;
  day: string;
  instant: string | null;
}

function shiftDate(text: string, days: number): string {
  return formatLocalDate(addDays(civil(text), days));
}

/** Why a candidate is not considered at all, or null when it is eligible. */
function exclusionOf(
  candidate: PriceCandidate,
  bound: SelectionBound,
  policy: PriceSelectionPolicy,
): CandidateExclusion | null {
  const { price } = candidate;
  if (!(policy.admittedRules as readonly string[]).includes(candidate.claim.ruleId))
    return "rule_not_admitted";
  if (!policy.priceKinds.includes(price.priceKind)) return "kind_not_admitted";
  const time: TemporalValue = price.effectiveTime;
  if (!validTemporalValue(time) || (time.kind !== "instant" && time.kind !== "local-date"))
    return "invalid_effective_time";
  if (!policy.acceptedBases.includes(time.basis)) return "basis_not_admitted";
  if (time.kind === "local-date") {
    if (policy.dateOnly === "exclude") return "date_only_excluded";
    // A date of the policy's zone is wholly before the bound when it is not
    // after the as-of date. A date of another zone, or of none, lies on one of
    // three days of this zone (D − 1 … D + 1); only one certainly after the
    // as-of date is excluded here, the rest are placed (or refused) in step 4.
    const latest = time.zone === policy.zone ? time.value : shiftDate(time.value, -1);
    return latest <= bound.asOfDate ? null : "effective_at_or_after_bound";
  }
  const order = instantOrder(time.value, bound.effectiveBefore);
  if (order === null) return "invalid_effective_time";
  return order < 0 ? null : "effective_at_or_after_bound";
}

/** `a.quote × b.baseQty = b.quote × a.baseQty`: the same price per unit of base, exactly. */
export function samePricePerUnit(a: PriceObservation, b: PriceObservation): boolean {
  return decimalEquals(
    multiplyDecimals(a.quoteAmount, b.baseQuantity),
    multiplyDecimals(b.quoteAmount, a.baseQuantity),
  );
}

/** The later recorded, then the higher id: the deterministic pick among agreeing candidates. */
function laterRecorded(a: PriceCandidate, b: PriceCandidate): number {
  const x = parseInstant(a.recordedAt);
  const y = parseInstant(b.recordedAt);
  if (x !== null && y === null) return 1;
  if (x === null && y !== null) return -1;
  if (x !== null && y !== null) {
    const order = instantOrder(a.recordedAt, b.recordedAt);
    if (order !== null && order !== 0) return order;
  }
  return a.price.id < b.price.id ? -1 : a.price.id > b.price.id ? 1 : 0;
}

const ids = (candidates: readonly { candidate: PriceCandidate }[]): string[] =>
  [...new Set(candidates.map((item) => item.candidate.price.id))].sort();

/** ISO weekday (1 Monday … 7 Sunday) of a civil date; 1970-01-01 was a Thursday. */
function isoWeekday(date: CivilDate): number {
  return ((((daysFromCivil(date) + 3) % 7) + 7) % 7) + 1;
}

/** The calendar a business-day rule may use, or null when none applies. */
function usableCalendar(
  policy: PriceSelectionPolicy,
  calendar: MarketCalendar | null,
): MarketCalendar | null {
  if (policy.freshness.unit !== "business-days" || calendar === null) return null;
  if (calendar.calendarRef !== policy.freshness.calendarRef || calendar.zone !== policy.zone)
    return null;
  return calendar;
}

function isOpen(calendar: MarketCalendar, date: CivilDate): boolean {
  return (
    !calendar.closedWeekdays.includes(isoWeekday(date)) &&
    !calendar.closedDates.includes(formatLocalDate(date))
  );
}

type Age = { ok: true; days: number } | { ok: false; reason: "calendar_missing" };

/** Days from `from` to `to` under the policy's freshness unit; business days are open days in (from, to]. */
function ageOf(
  from: string,
  to: string,
  policy: PriceSelectionPolicy,
  calendar: MarketCalendar | null,
): Age {
  const span = daysBetween(civil(from), civil(to));
  if (policy.freshness.unit === "calendar-days") return { ok: true, days: span };
  const usable = usableCalendar(policy, calendar);
  if (usable === null || from < usable.coverage.from || to > usable.coverage.to)
    return { ok: false, reason: "calendar_missing" };
  let open = 0;
  for (let step = 1; step <= span; step += 1)
    if (isOpen(usable, addDays(civil(from), step))) open += 1;
  return { ok: true, days: open };
}

/**
 * The earliest civil date a candidate may have and still be fresh under the
 * policy, for sizing the read window. A business-day rule walks back over the
 * calendar while it covers the dates; without a usable calendar every
 * candidate is refused anyway, so the calendar-day span is returned.
 */
export function freshnessWindowStart(
  policy: PriceSelectionPolicy,
  bound: SelectionBound,
  calendar: MarketCalendar | null,
): string {
  const asOf = civil(bound.asOfDate);
  const max = policy.freshness.maxAgeDays;
  const usable = usableCalendar(policy, calendar);
  if (usable === null || bound.asOfDate > usable.coverage.to)
    return formatLocalDate(addDays(asOf, -max));
  let day = asOf;
  let age = 0;
  for (;;) {
    const previous = addDays(day, -1);
    if (formatLocalDate(previous) < usable.coverage.from) break;
    const next = age + (isOpen(usable, day) ? 1 : 0);
    if (next > max) break;
    day = previous;
    age = next;
  }
  return formatLocalDate(day);
}

/**
 * The coarse window a candidate read covers, as instants: from one day before
 * the earliest fresh civil date to one day after the bound. A day of margin
 * on each side covers any zone offset; the domain decides each row exactly.
 */
export function selectionReadWindow(
  policy: PriceSelectionPolicy,
  bound: SelectionBound,
  calendar: MarketCalendar | null,
): { from: string; to: string } {
  const start = addDays(civil(freshnessWindowStart(policy, bound, calendar)), -1);
  const before = parseInstant(bound.effectiveBefore);
  if (before === null) throw new RangeError("invalid bound");
  const to = (before.epochSeconds + 86_400 + 1) * 1000;
  return {
    from: `${formatLocalDate(start)}T00:00:00Z`,
    to: new Date(to).toISOString(),
  };
}

type GroupOutcome =
  | { selected: true; chosen: Placed; corroboratedBy: string[]; ageDays: number }
  | {
      selected: false;
      reason: PriceSelectionRefusal;
      candidateIds: string[];
      ageDays: number | null;
    };

/** Steps 4–6 over candidates that passed the filter and the overlap check. */
function selectFromGroup(
  eligible: readonly PriceCandidate[],
  bound: SelectionBound,
  policy: PriceSelectionPolicy,
  calendar: MarketCalendar | null,
): GroupOutcome {
  // Step 4: place every candidate on a civil day of the policy zone. A date
  // with no zone, or another zone's, is only known to lie within a day of its
  // own value; it is set aside, and refuses the selection if it might reach
  // the top day.
  const placed: Placed[] = [];
  const unplaced: PriceCandidate[] = [];
  for (const candidate of eligible) {
    const time = candidate.price.effectiveTime as Extract<
      TemporalValue,
      { kind: "instant" | "local-date" }
    >;
    if (time.kind === "local-date") {
      if (time.zone === policy.zone) placed.push({ candidate, day: time.value, instant: null });
      else unplaced.push(candidate);
      continue;
    }
    const day = civilDateOfInstant(time.value, policy.zone);
    if (day === null) unplaced.push(candidate);
    else placed.push({ candidate, day, instant: time.value });
  }
  const topDay =
    placed.length === 0
      ? null
      : placed.reduce((max, item) => (item.day > max ? item.day : max), placed[0]!.day);
  const reaching = unplaced.filter(
    (candidate) =>
      topDay === null ||
      candidate.price.effectiveTime.kind !== "local-date" ||
      shiftDate(candidate.price.effectiveTime.value, 1) >= topDay,
  );
  if (topDay === null || reaching.length > 0)
    return {
      selected: false,
      reason: "time_incomparable",
      candidateIds: ids(reaching.map((candidate) => ({ candidate }))),
      ageDays: null,
    };
  const onTopDay = placed.filter((item) => item.day === topDay);
  let top: Placed[];
  if (onTopDay.every((item) => item.instant !== null)) {
    let newest = onTopDay[0]!;
    for (const item of onTopDay)
      if (instantOrder(item.instant!, newest.instant!)! > 0) newest = item;
    top = onTopDay.filter((item) => instantOrder(item.instant!, newest.instant!) === 0);
  } else if (onTopDay.every((item) => item.instant === null)) {
    top = onTopDay;
  } else {
    // A date and an instant on the same day cannot be ordered: only when they
    // all state the same price does the order not matter.
    const first = onTopDay[0]!.candidate.price;
    if (!onTopDay.every((item) => samePricePerUnit(first, item.candidate.price)))
      return {
        selected: false,
        reason: "time_incomparable",
        candidateIds: ids(onTopDay),
        ageDays: null,
      };
    top = onTopDay;
  }
  // Step 5: freshness from the top's civil date to the as-of date. A price
  // dated after the as-of date means the bound and the date disagree.
  if (daysBetween(civil(topDay), civil(bound.asOfDate)) < 0)
    return { selected: false, reason: "time_incomparable", candidateIds: ids(top), ageDays: null };
  const age = ageOf(topDay, bound.asOfDate, policy, calendar);
  if (!age.ok)
    return { selected: false, reason: age.reason, candidateIds: ids(top), ageDays: null };
  if (age.days > policy.freshness.maxAgeDays)
    return { selected: false, reason: "stale", candidateIds: ids(top), ageDays: age.days };
  // Step 6: everything at the top must agree per unit.
  const reference = top[0]!.candidate.price;
  if (!top.every((item) => samePricePerUnit(reference, item.candidate.price)))
    return { selected: false, reason: "disagree", candidateIds: ids(top), ageDays: null };
  let chosen = top[0]!;
  for (const item of top) if (laterRecorded(item.candidate, chosen.candidate) > 0) chosen = item;
  return {
    selected: true,
    chosen,
    corroboratedBy: ids(top.filter((item) => item !== chosen)),
    ageDays: age.days,
  };
}

/**
 * Select one price for `key` from `candidates` (all of which must be of that
 * key) at `bound`, under `policy`, in the six steps described at the top of
 * this module. `calendar` is the calendar a business-day rule names, or null.
 */
export function selectPrice(
  key: PriceKey,
  candidates: readonly PriceCandidate[],
  bound: SelectionBound,
  policy: PriceSelectionPolicy,
  calendar: MarketCalendar | null,
): PriceSelection {
  const excluded = zeroCounts();
  const eligible: PriceCandidate[] = [];
  // Step 1: filter, counting what is removed.
  for (const candidate of candidates) {
    const price = candidate.price;
    if (
      !sameKey(key, {
        baseInstrumentRef: price.baseInstrumentRef,
        quoteUnitRef: price.quoteUnitRef,
        priceKind: price.priceKind,
      })
    )
      throw new RangeError("candidate_key_mismatch");
    const reason = exclusionOf(candidate, bound, policy);
    if (reason === null) eligible.push(candidate);
    else excluded[reason] += 1;
  }
  const refused = (
    reason: PriceSelectionRefusal,
    candidateIds: string[],
    ageDays: number | null,
  ): PriceSelection => ({
    status: "refused",
    key,
    reason,
    candidateIds,
    ageDays,
    excluded,
    policyId: policy.policyId,
  });
  // Step 2.
  if (eligible.length === 0) return refused("missing", [], null);
  // Step 3: one source, or a declared priority among them.
  const rules = policy.admittedRules.filter((rule) =>
    eligible.some((candidate) => candidate.claim.ruleId === rule),
  );
  const groups =
    rules.length > 1 && policy.multiSource === "refuse-on-overlap"
      ? null
      : rules.map((rule) => eligible.filter((candidate) => candidate.claim.ruleId === rule));
  if (groups === null)
    return refused("sources_overlap", ids(eligible.map((candidate) => ({ candidate }))), null);
  // Under priority-order the first rule with a selectable price wins; when
  // none has one, the highest-priority rule's refusal is reported.
  let first: GroupOutcome | null = null;
  for (const group of groups) {
    const outcome = selectFromGroup(group, bound, policy, calendar);
    if (outcome.selected)
      return {
        status: "selected",
        key,
        candidate: outcome.chosen.candidate,
        ageDays: outcome.ageDays,
        corroboratedBy: outcome.corroboratedBy,
        excluded,
        policyId: policy.policyId,
      };
    first ??= outcome;
  }
  const outcome = first as Extract<GroupOutcome, { selected: false }>;
  return refused(outcome.reason, outcome.candidateIds, outcome.ageDays);
}

// ---------------------------------------------------------------------------
// FX path and conversion
// ---------------------------------------------------------------------------

/** One hop: `direct` multiplies by `base`/`quote`; `inverse` divides by it. */
export interface FxStep {
  base: string;
  quote: string;
  direction: "direct" | "inverse";
}

/**
 * The hops from `from` to `to` through `pivot`: none for the same unit, one
 * into or out of the pivot, two between two other currencies. Null when
 * either side is not a currency code.
 */
export function fxPath(from: string, to: string, pivot: string): FxStep[] | null {
  if (![from, to, pivot].every((code) => CURRENCY.test(code))) return null;
  if (from === to) return [];
  if (to === pivot) return [{ base: from, quote: pivot, direction: "direct" }];
  if (from === pivot) return [{ base: to, quote: pivot, direction: "inverse" }];
  return [
    { base: from, quote: pivot, direction: "direct" },
    { base: to, quote: pivot, direction: "inverse" },
  ];
}

/** The FX selection key of a currency under a conversion policy. */
export function fxKey(currency: string, policy: FxConversionPolicy): PriceKey {
  return {
    baseInstrumentRef: currency,
    quoteUnitRef: policy.pivot,
    priceKind: policy.selection.priceKinds[0]!,
  };
}

/** One leg of a conversion, for the explanation: which price, how old, whose time. */
export interface ConversionLeg {
  leg: "price" | "fx";
  base: string;
  quote: string;
  direction: "direct" | "inverse";
  priceId: string;
  effectiveTime: TemporalValue;
  ageDays: number;
  policyId: string;
}

export type ConversionResult =
  | { ok: true; value: Quantity; legs: ConversionLeg[]; roundingInputs: RoundingInputs | null }
  | {
      ok: false;
      leg: "quantity" | "price" | "fx";
      pair: { base: string; quote: string } | null;
      reason: ConversionRefusal;
    };

function legOf(
  leg: "price" | "fx",
  step: { base: string; quote: string; direction: "direct" | "inverse" },
  selection: Extract<PriceSelection, { status: "selected" }>,
): ConversionLeg {
  return {
    leg,
    base: step.base,
    quote: step.quote,
    direction: step.direction,
    priceId: selection.candidate.price.id,
    effectiveTime: selection.candidate.price.effectiveTime,
    ageDays: selection.ageDays,
    policyId: selection.policyId,
  };
}

/**
 * State an exact amount in `base` through the policy's pivot, with the FX
 * selections keyed by currency. Into the pivot is one exact hop
 * (`valueAtPrice`); out of the pivot, or across it, is one exact ratio rounded
 * once under `policy.inverse` at the target unit's scale, with the operands
 * kept. A missing, stale or disagreeing rate is that refusal, never 1:1.
 */
export function convertToBase(
  amount: Quantity,
  base: string,
  fx: ReadonlyMap<string, PriceSelection>,
  policy: FxConversionPolicy,
): ConversionResult {
  if (amount.value.status !== "exact")
    return { ok: false, leg: "quantity", pair: null, reason: "quantity_not_exact" };
  const value = amount.value.value;
  const path = fxPath(amount.unitRef, base, policy.pivot);
  const pair = { base: amount.unitRef, quote: base };
  if (path === null) return { ok: false, leg: "fx", pair, reason: "unsupported_pair" };
  if (path.length === 0) return { ok: true, value: amount, legs: [], roundingInputs: null };
  for (const step of path)
    if (!policy.currencies.includes(step.base))
      return { ok: false, leg: "fx", pair, reason: "unsupported_pair" };
  const inverse = path.some((step) => step.direction === "inverse") ? policy.inverse : null;
  const scale = inverse === null ? undefined : inverse.scaleByUnit[base];
  if (
    path.some((step) => step.direction === "inverse") &&
    (inverse === null || scale === undefined)
  )
    return { ok: false, leg: "fx", pair, reason: "rounding_policy_missing" };
  const rates: Extract<PriceSelection, { status: "selected" }>[] = [];
  for (const step of path) {
    const selection = fx.get(step.base);
    if (selection === undefined)
      return {
        ok: false,
        leg: "fx",
        pair: { base: step.base, quote: step.quote },
        reason: "missing",
      };
    if (!sameKey(selection.key, fxKey(step.base, policy)))
      throw new RangeError("fx_selection_key_mismatch");
    if (selection.status !== "selected")
      return {
        ok: false,
        leg: "fx",
        pair: { base: step.base, quote: step.quote },
        reason: selection.reason,
      };
    rates.push(selection);
  }
  const legs = path.map((step, index) => legOf("fx", step, rates[index]!));
  if (inverse === null) {
    // One direct hop into the pivot, exact.
    const hop = valueAtPrice(amount, rates[0]!.candidate.price);
    if (!hop.ok) return { ok: false, leg: "fx", pair, reason: "rounding_policy_missing" };
    return { ok: true, value: hop.quantity, legs, roundingInputs: null };
  }
  // amount × Π(direct quote ÷ base qty) ÷ Π(inverse quote ÷ base qty), one division.
  let numerator = value;
  let denominator: ExactDecimal = { coefficient: "1", scale: 0 };
  const operands: ExactDecimal[] = [value];
  path.forEach((step, index) => {
    const price = rates[index]!.candidate.price;
    operands.push(price.quoteAmount, price.baseQuantity);
    if (step.direction === "direct") {
      numerator = multiplyDecimals(numerator, price.quoteAmount);
      denominator = multiplyDecimals(denominator, price.baseQuantity);
    } else {
      numerator = multiplyDecimals(numerator, price.baseQuantity);
      denominator = multiplyDecimals(denominator, price.quoteAmount);
    }
  });
  const rounding = { scale: scale!, mode: inverse.mode };
  const rounded = divideDecimals(numerator, denominator, rounding);
  if (!rounded.ok) return { ok: false, leg: "fx", pair, reason: "rounding_policy_missing" };
  const exact = divideDecimals(numerator, denominator);
  return {
    ok: true,
    value: exactQuantity(base, rounded.value),
    legs,
    roundingInputs: {
      policyId: policy.policyId,
      where: "leg",
      mode: inverse.mode,
      precision: rounding.scale,
      residual: "leave",
      operands,
      preRounding: exact.ok ? exact.value : null,
    },
  };
}

/**
 * A holding's value in `base`: quantity × its selected price (exact, in the
 * price's quote unit), then that amount through `convertToBase`. Both legs are
 * reported with their price ids, effective times and ages; a refused leg
 * names itself.
 */
export function valueInBase(
  quantity: Quantity,
  price: PriceSelection,
  base: string,
  fx: ReadonlyMap<string, PriceSelection>,
  policy: FxConversionPolicy,
): ConversionResult {
  const pricePair = { base: price.key.baseInstrumentRef, quote: price.key.quoteUnitRef };
  if (quantity.value.status !== "exact")
    return { ok: false, leg: "quantity", pair: null, reason: "quantity_not_exact" };
  if (quantity.unitRef !== price.key.baseInstrumentRef)
    return { ok: false, leg: "price", pair: pricePair, reason: "instrument_mismatch" };
  if (price.status !== "selected")
    return { ok: false, leg: "price", pair: pricePair, reason: price.reason };
  const local = valueAtPrice(quantity, price.candidate.price);
  if (!local.ok)
    return { ok: false, leg: "price", pair: pricePair, reason: "rounding_policy_missing" };
  const priceLeg = legOf("price", { ...pricePair, direction: "direct" }, price);
  const converted = convertToBase(local.quantity, base, fx, policy);
  if (!converted.ok) return converted;
  return { ...converted, legs: [priceLeg, ...converted.legs] };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface SelectionManifest {
  schema: typeof MARKET_DATA_SELECTION_SCHEMA;
  policies: { policyId: string; digest: string }[];
  calendars: { calendarRef: string; version: string; digest: string }[];
  effectiveBefore: string;
  asOfDate: string;
  /** The mode only: a known-at instant that changes nothing does not change the context. */
  knowledge: KnowledgeMode["mode"];
  /** The newest `recorded_at` among the selected prices, or null when nothing was selected. */
  knowledgeBoundary: string | null;
  selected: string[];
  refused: { key: PriceKey; reason: PriceSelectionRefusal; candidateIds: string[] }[];
}

const keyText = (key: PriceKey): string =>
  JSON.stringify([key.baseInstrumentRef, key.quoteUnitRef, key.priceKind]);

/**
 * The input set of a selection: every policy and calendar by id and digest,
 * the bound, the knowledge mode, the newest recorded time actually used, the
 * selected price ids and each refusal with its candidates. Sorted, so the
 * order selections were made in does not matter; its `canonicalDigest` is the
 * selection's context id.
 */
export async function selectionManifest(input: {
  policies: readonly (PriceSelectionPolicy | FxConversionPolicy)[];
  calendars: readonly MarketCalendar[];
  bound: SelectionBound;
  selections: readonly PriceSelection[];
}): Promise<SelectionManifest> {
  const policies = await Promise.all(
    input.policies.map(async (policy) => ({
      policyId: policy.policyId,
      digest: await policyDigest(policy),
    })),
  );
  const calendars = await Promise.all(
    input.calendars.map(async (calendar) => ({
      calendarRef: calendar.calendarRef,
      version: calendar.version,
      digest: await policyDigest(calendar),
    })),
  );
  const unique = <T>(items: T[], text: (item: T) => string): T[] =>
    [...new Map(items.map((item) => [text(item), item])).entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, item]) => item);
  let boundary: string | null = null;
  const selected: string[] = [];
  const refused: SelectionManifest["refused"] = [];
  for (const selection of input.selections) {
    if (selection.status === "selected") {
      selected.push(selection.candidate.price.id);
      const recorded = selection.candidate.recordedAt;
      if (
        validInstantText(recorded) &&
        (boundary === null || instantOrder(recorded, boundary)! > 0)
      )
        boundary = recorded;
    } else
      refused.push({
        key: { ...selection.key },
        reason: selection.reason,
        candidateIds: [...selection.candidateIds],
      });
  }
  return {
    schema: MARKET_DATA_SELECTION_SCHEMA,
    policies: unique(policies, (p) => JSON.stringify([p.policyId, p.digest])),
    calendars: unique(calendars, (c) => JSON.stringify([c.calendarRef, c.version, c.digest])),
    effectiveBefore: input.bound.effectiveBefore,
    asOfDate: input.bound.asOfDate,
    knowledge: input.bound.knowledge.mode,
    knowledgeBoundary: boundary,
    selected: [...new Set(selected)].sort(),
    refused: unique(refused, (r) => JSON.stringify([keyText(r.key), r.reason, r.candidateIds])),
  };
}
