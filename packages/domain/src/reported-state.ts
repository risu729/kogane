// Reported state on a date (docs/reported-state.md, ADR 0019): what each
// provider last reported, in complete container snapshots captured before the
// end of the date, beside the card statements due around it. Pure: the date
// arithmetic, the freshness policy and the payable status live here so the
// query, the API and the page cannot disagree about them. Nothing here adds
// two amounts: a reported state is a list of provider figures, never a total.
import type { CardSettlementStatus } from "./card-settlement.ts";
import type { AggregationRule, MeasurementKind, SignMeaning, SubjectKind } from "./metrics.ts";
import { addDays, daysBetween, formatLocalDate, parseLocalDate, type CivilDate } from "./time.ts";
import type { Quantity } from "./values.ts";

export const REPORTED_STATE_SCHEMA = "reported-state-v1";
/** `same-day` / `recent` (captured at most `RECENT_DAYS` before the date) / `stale`; `collection-freshness-v1` uses the same thresholds. */
export const DATED_STATE_FRESHNESS_POLICY = "dated-state-freshness-v1";
/** Which containers and rows a reported state lists (ADR 0019, decision 2). */
export const DATED_STATE_PERIMETER_POLICY = "dated-state-perimeter-v1";
export const RECENT_DAYS = 3;
/** The civil zone of the date the owner asks about; capture times are UTC instants. */
export const REPORTED_STATE_ZONE = "Asia/Tokyo";
const ZONE_OFFSET_MS = 9 * 3_600_000;
/**
 * Statements listed as payables: due on or after the date minus this many
 * days, or, without a readable due date, captured within
 * `UNDATED_STATEMENT_WINDOW_DAYS` before the cutoff. An older bill is not
 * listed; the coverage counts it under one of `STATEMENTS_BEFORE_WINDOW_REASONS`.
 */
const PAYABLE_WINDOW_DAYS = 31;
export const UNDATED_STATEMENT_WINDOW_DAYS = 45;
/** Why a statement as of the cutoff is left out of the payables. */
export const STATEMENTS_BEFORE_WINDOW_REASONS = [
  "due_before_window",
  "undated_captured_before_window",
] as const;
export type StatementsBeforeWindowReason = (typeof STATEMENTS_BEFORE_WINDOW_REASONS)[number];

export const FRESHNESS_STATES = ["same-day", "recent", "stale"] as const;
export type Freshness = (typeof FRESHNESS_STATES)[number];
export const PAYABLE_STATUSES = [
  "due_after_date",
  "settled_on_or_before_date",
  "due_unsettled",
  "payment_date_unknown",
] as const;
export type PayableStatus = (typeof PAYABLE_STATUSES)[number];
export const IDENTITY_STATUSES = [
  "identified",
  "provider-local",
  "aggregate",
  "unresolved",
  "not-recorded",
] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/** Parts of the perimeter a reported state deliberately does not list (decision 2). */
export const REPORTED_STATE_EXCLUSIONS = [
  { scope: "source:moneyforward", reasonCode: "aggregator" },
  { scope: "container:sbi-account-assets-current", reasonCode: "aggregate_total" },
  { scope: "container:sony-bank-gross-balance", reasonCode: "aggregate_total" },
  { scope: "metric:event-reported", reasonCode: "balance_after_transaction" },
  { scope: "unit:reward", reasonCode: "reward_units" },
] as const;
export type ExclusionReason = (typeof REPORTED_STATE_EXCLUSIONS)[number]["reasonCode"];
/**
 * What a reported state knows it does not show about what is owed. The first
 * three are named on every answer; `statements_before_window` only when the
 * answer leaves at least one statement out (`statementsBeforeWindow`).
 */
export const LIABILITY_GAPS = [
  "unbilled_card_usage",
  "installment_remaining",
  "loan_balances",
  "statements_before_window",
] as const;
type LiabilityGap = (typeof LIABILITY_GAPS)[number];

/** Statements left out of the payables, per source and reason (never per amount). */
export interface StatementsBeforeWindow {
  sourceId: string;
  reasonCode: StatementsBeforeWindowReason;
  count: number;
}

/**
 * The statements left out of the payables as the manifest records them: per
 * source, resolved account (null when none resolves) and reason, so that a
 * change to any count gives a new `contextId`.
 */
export interface ManifestStatementsBeforeWindow {
  sourceId: string;
  accountId: string | null;
  reasonCode: StatementsBeforeWindowReason;
  count: number;
}

/**
 * The liability gaps of an answer: every gap but `statements_before_window`,
 * and that one too when `omitted` names a statement. Without a count (`null`:
 * the statements left out were not read) every gap is named.
 */
export function liabilityGaps(omitted: readonly StatementsBeforeWindow[] | null): LiabilityGap[] {
  const leftOut = omitted === null || omitted.some((entry) => entry.count > 0);
  return LIABILITY_GAPS.filter((gap) => gap !== "statements_before_window" || leftOut);
}

export interface ReportedSnapshot {
  /** `artifact:<id>` of the newest artifact of the snapshot. */
  ref: string;
  sourceId: string;
  parserName: string;
  dataset: string;
  /** UTC instant, as the capture was recorded. */
  capturedAt: string;
  /** The capture's civil date in `REPORTED_STATE_ZONE`. */
  captureDate: string;
  ageDays: number;
  freshness: Freshness;
}
export interface ReportedInstrument {
  instrumentId: string | null;
  status: IdentityStatus;
}
interface ReportedMetric {
  metricId: string;
  measurementKind: MeasurementKind;
  subjectKind: SubjectKind;
  signMeaning: SignMeaning;
  aggregationRule: AggregationRule;
  overlapGroup: string | null;
  definitionRelease: string;
}
interface ReportedValuation {
  ref: string;
  metric: string;
  /** The provider's figure in the provider's currency; never converted. */
  amount: Quantity;
  providerText: string | null;
  asOf: string | null;
}
export interface ReportedPosition {
  ref: string;
  snapshotRef: string;
  securityCode: string;
  securityName: string | null;
  market: string | null;
  /** The provider's quantity as decimal text; never arithmetic input here. */
  quantityText: string;
  currency: string | null;
  asOf: string | null;
  instrument: ReportedInstrument;
  valuations: ReportedValuation[];
}
export interface ReportedBalance {
  ref: string;
  snapshotRef: string;
  providerMetric: string;
  metric: ReportedMetric;
  amount: Quantity;
  providerText: string | null;
  asOf: string | null;
  instrument: ReportedInstrument;
}
export interface ReportedAccount {
  sourceId: string;
  sourceAccount: string;
  accountId: string | null;
  identityStatus: IdentityStatus;
  snapshots: ReportedSnapshot[];
  positions: ReportedPosition[];
  balances: ReportedBalance[];
}
export interface ReportedSettlement {
  proposalId: string;
  reviewStatus: CardSettlementStatus;
  /** The reviewed bank debit's date, when the review states one. */
  debitDate: string | null;
}
export interface ReportedPayable {
  ref: string;
  sourceId: string;
  sourceAccount: string;
  accountId: string | null;
  period: string | null;
  capturedAt: string;
  paymentDate: string | null;
  /** The provider's statement total; a missing value stays missing. */
  amount: Quantity;
  status: PayableStatus;
  settlement: ReportedSettlement | null;
}
interface ReportedStateCoverage {
  containersWithoutSnapshot: {
    sourceId: string;
    parserName: string;
    dataset: string;
    reasonCode: "no_complete_snapshot_before_cutoff";
  }[];
  staleSnapshots: { ref: string; sourceId: string; parserName: string; ageDays: number }[];
  excluded: { scope: string; reasonCode: ExclusionReason }[];
  excludedRows: { reasonCode: ExclusionReason; count: number }[];
  liabilitiesCoverage: "partial";
  liabilitiesMissing: LiabilityGap[];
  payablesFromPaymentDate: string;
  /**
   * The statements as of the cutoff that the payable window leaves out,
   * counted per source and reason (only counts above zero); empty when the
   * answer lists every statement.
   */
  statementsBeforeWindow: StatementsBeforeWindow[];
  /** Nothing is totalled: a reported state is never a net-asset figure. */
  netAssets: "not-computed";
}
interface ReportedStateManifest {
  schemaVersion: typeof REPORTED_STATE_SCHEMA;
  date: string;
  cutoff: string;
  policies: string[];
  snapshotRefs: string[];
  statementRefs: string[];
  settlementRefs: string[];
  /**
   * The statements the payable window leaves out, counted per source,
   * resolved account and reason under the answer's filters, ordered by those
   * three (ADR 0019, amendment of 2026-11-18). Absent from a state read
   * without the count (`UncountedReportedState`).
   */
  statementsBeforeWindow: ManifestStatementsBeforeWindow[];
}
export interface ReportedState {
  schemaVersion: typeof REPORTED_STATE_SCHEMA;
  date: string;
  cutoff: string;
  zone: typeof REPORTED_STATE_ZONE;
  filters: { source: string | null; account: string | null };
  /** Every snapshot chosen for the date, a complete-empty one included. */
  snapshots: ReportedSnapshot[];
  accounts: ReportedAccount[];
  payables: ReportedPayable[];
  coverage: ReportedStateCoverage;
  manifest: ReportedStateManifest;
  /** `canonicalDigest(manifest)`: the same inputs give the same id. */
  contextId: string;
}

/**
 * A reported state read without counting the statements the payable window
 * leaves out (`queryDatedState` with `includeStatementsBeforeWindow: false`),
 * for the reads that build on it and never show the count. Its coverage has
 * no `statementsBeforeWindow` and names every liability gap, and its manifest
 * has no `statementsBeforeWindow`, so its `contextId` claims no count it did
 * not read. It is never served as a reported-state answer.
 */
export type UncountedReportedState = Omit<ReportedState, "coverage" | "manifest"> & {
  coverage: Omit<ReportedStateCoverage, "statementsBeforeWindow">;
  manifest: Omit<ReportedStateManifest, "statementsBeforeWindow">;
};

function civil(date: string): CivilDate {
  const parsed = parseLocalDate(date);
  if (parsed === null) throw new Error("invalid_date");
  return parsed;
}

/**
 * The exclusive capture-time bound of date `date`: `(date + 1) 00:00` in
 * Asia/Tokyo, written as `observation_fetch_artifacts.fetched_at` stores
 * instants (UTC `%Y-%m-%dT%H:%M:%fZ`), so it compares as text.
 */
export function reportedStateCutoff(date: string): string {
  const next = formatLocalDate(addDays(civil(date), 1));
  return new Date(Date.parse(`${next}T00:00:00.000Z`) - ZONE_OFFSET_MS).toISOString();
}

/** The civil date in Asia/Tokyo of a stored UTC instant, or null when it is not one. */
export function captureDate(capturedAt: string): string | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/u.test(capturedAt))
    return null;
  const instant = Date.parse(capturedAt);
  if (Number.isNaN(instant)) return null;
  return new Date(instant + ZONE_OFFSET_MS).toISOString().slice(0, 10);
}

/** `dated-state-freshness-v1`: days from the capture's date to the asked date. */
export function snapshotFreshness(
  capturedAt: string,
  date: string,
): { captureDate: string; ageDays: number; freshness: Freshness } {
  const captured = captureDate(capturedAt);
  if (captured === null) throw new Error("invalid_capture_time");
  const ageDays = daysBetween(civil(captured), civil(date));
  // The cutoff query never returns a capture after the date.
  if (ageDays < 0) throw new Error("capture_after_date");
  return {
    captureDate: captured,
    ageDays,
    freshness: ageDays === 0 ? "same-day" : ageDays <= RECENT_DAYS ? "recent" : "stale",
  };
}

/** The first due date a payable may have to be listed on `date`. */
export function payablesFromPaymentDate(date: string): string {
  return formatLocalDate(addDays(civil(date), -PAYABLE_WINDOW_DAYS));
}

/**
 * Where a provider statement stands on `date`. Settled only by an accepted
 * settlement review whose bank debit is on or before the date; a proposal, a
 * rejection or a debit after the date settles nothing. An unreadable due date
 * is its own status, never a guess.
 */
export function payableStatus(
  date: string,
  paymentDate: string | null,
  settlement: ReportedSettlement | null,
): PayableStatus {
  const asked = civil(date);
  const debit =
    settlement?.reviewStatus === "accepted" && settlement.debitDate !== null
      ? parseLocalDate(settlement.debitDate)
      : null;
  if (debit !== null && daysBetween(debit, asked) >= 0) return "settled_on_or_before_date";
  const due = paymentDate === null ? null : parseLocalDate(paymentDate);
  if (due === null) return "payment_date_unknown";
  return daysBetween(due, asked) < 0 ? "due_after_date" : "due_unsettled";
}
