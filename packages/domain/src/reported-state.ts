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

/**
 * v4: the answer lists the provider's scheduled card payments as of the
 * cutoff (`scheduledPayments`; ADR 0019's scheduled-payments amendment of
 * 2026-11-21), and the manifest pins each listed capture's parse and each
 * listed row. v3: the coverage and the manifest count the statements the payable window
 * leaves out (`statementsBeforeWindow`; ADR 0019's statements-before-window
 * amendment of 2026-11-18, released after v2 and so a version of its own).
 * v2: the manifest pins every input the answer reads (INV09; ADR 0019's
 * context amendment of 2026-11-19): the filters, the metric registry release,
 * the containers without a snapshot, each listed or counted row with the
 * identity it was read under, each payable's account and each settlement
 * review's decision. A v1 manifest named only snapshot, statement and review
 * ids, so a mapping correction, a review decision, a parse activated over the
 * same artifact or another account filter kept the context id.
 */
export const REPORTED_STATE_SCHEMA = "reported-state-v4";
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
/**
 * Where a provider-scheduled payment stands against the asked date, from its
 * due date alone: whether it was paid is not read (no settlement links one).
 */
export const SCHEDULED_PAYMENT_DUE_STATUSES = ["due_after_date", "due_on_or_before_date"] as const;
export type ScheduledPaymentDueStatus = (typeof SCHEDULED_PAYMENT_DUE_STATUSES)[number];
/** The schedule kinds `scheduled_payment_observations` admits (migration 0061). */
export const SCHEDULED_PAYMENT_KINDS = ["card-skip-payment"] as const;
export type ScheduledPaymentKind = (typeof SCHEDULED_PAYMENT_KINDS)[number];
/**
 * Whether an answer lists the scheduled payments: `listed` (possibly none),
 * or `not_listed_account_filter` under an account filter, since a scheduled
 * payment has no identity run and so no resolved account to match it with
 * (ADR 0005, amendment e).
 */
export const SCHEDULED_PAYMENTS_LISTING = ["listed", "not_listed_account_filter"] as const;
export type ScheduledPaymentsListing = (typeof SCHEDULED_PAYMENTS_LISTING)[number];
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
/**
 * One row of a provider's scheduled-payment page (MyJCB ショッピングスキップ払い,
 * `scheduled_payment_observations`): a payment the provider said, on the
 * page's as-of date, is still to be made on `dueDate`. What the amount covers
 * (one deferred payment or the rest of it) and whether a statement month
 * later carries it are not confirmed, so it is never matched with a
 * statement, a settlement or a purchase, and never added to anything.
 */
interface ReportedScheduledPayment {
  /** `scheduled-payment:<observation id>`. */
  ref: string;
  sourceAccount: string;
  scheduleKind: ScheduledPaymentKind;
  usageDate: string;
  dueDate: string;
  /** The provider's 今後のお支払い金額 as an exact decimal; a malformed text stays unparsed. */
  amount: Quantity;
  providerText: string;
  counterparty: string;
  /** The page's own as-of date. */
  asOf: string;
  dueStatus: ScheduledPaymentDueStatus;
}
/**
 * One published capture of a scheduled-payment page: per source and fetch
 * unit, the pages of the newest fetch run captured before the cutoff. Its
 * `payments` are what that page listed; an empty list means the page listed
 * none, not that nothing was scheduled after the capture.
 */
export interface ReportedScheduledPaymentCapture {
  /** `artifact:<id>` of the captured page. */
  ref: string;
  sourceId: string;
  parserName: string;
  capturedAt: string;
  captureDate: string;
  ageDays: number;
  freshness: Freshness;
  payments: ReportedScheduledPayment[];
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
  /** Whether `scheduledPayments` lists the scheduled payments (ADR 0019, amendment of 2026-11-21). */
  scheduledPayments: ScheduledPaymentsListing;
  /** Nothing is totalled: a reported state is never a net-asset figure. */
  netAssets: "not-computed";
}
/**
 * One position or balance the answer lists or counts, with the identity it
 * was read under: `[ref, accountId, accountIdentity, instrumentId,
 * instrumentIdentity]`. The identity is the one the answer shows, so a later
 * mapping revision or identity run that changes it changes the manifest.
 */
export type ReportedStateManifestRow = [
  ref: string,
  accountId: string | null,
  accountIdentity: IdentityStatus,
  instrumentId: string | null,
  instrumentIdentity: IdentityStatus,
];
interface ReportedStateManifest {
  schemaVersion: typeof REPORTED_STATE_SCHEMA;
  date: string;
  cutoff: string;
  policies: string[];
  /** `METRIC_REGISTRY_RELEASE`: it decides each balance's metric and which rows are excluded. */
  metricRegistryRelease: string;
  filters: { source: string | null; account: string | null };
  snapshotRefs: string[];
  /** `sourceId/parserName/dataset` of each perimeter container without a snapshot, sorted. */
  containersWithoutSnapshot: string[];
  /** Every listed or counted position and balance, sorted by ref. */
  rows: ReportedStateManifestRow[];
  statementRefs: string[];
  /** `[statementRef, accountId]` of each payable, sorted by ref. */
  statementAccounts: [ref: string, accountId: string | null][];
  /** `card-settlement:<id>@decision:<decision revision id>`, or `@proposed` before any decision. */
  settlementRefs: string[];
  /**
   * The statements the payable window leaves out, counted per source,
   * resolved account and reason under the answer's filters, ordered by those
   * three (ADR 0019, amendment of 2026-11-18). Absent from a state read
   * without the count (`UncountedReportedState`).
   */
  statementsBeforeWindow: ManifestStatementsBeforeWindow[];
  /**
   * `[captureRef, "parse_run:<id>"]` of each listed scheduled-payment
   * capture, sorted, so a parse activated over the same page changes it.
   */
  scheduledPaymentCaptures: [ref: string, parseRun: string][];
  /** The refs of the listed scheduled payments, sorted. */
  scheduledPaymentRefs: string[];
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
  /** The provider's scheduled card payments as of the cutoff, per capture; never added. */
  scheduledPayments: ReportedScheduledPaymentCapture[];
  coverage: ReportedStateCoverage;
  manifest: ReportedStateManifest;
  /** `canonicalDigest(manifest)`: the same inputs give the same id. */
  contextId: string;
}

/**
 * A reported state read without counting the statements the payable window
 * leaves out and without the scheduled payments (`queryDatedState` with
 * `includeStatementsBeforeWindow: false`), for the reads that build on it and
 * show neither. Its coverage has no `statementsBeforeWindow` or
 * `scheduledPayments` and names every liability gap, and its manifest records
 * neither, so its `contextId` claims nothing it did not read. It is never
 * served as a reported-state answer.
 */
export type UncountedReportedState = Omit<
  ReportedState,
  "coverage" | "manifest" | "scheduledPayments"
> & {
  coverage: Omit<ReportedStateCoverage, "statementsBeforeWindow" | "scheduledPayments">;
  manifest: Omit<
    ReportedStateManifest,
    "statementsBeforeWindow" | "scheduledPaymentCaptures" | "scheduledPaymentRefs"
  >;
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

/**
 * Where a scheduled payment stands on `date`, from its due date alone: due
 * after the date, or due on or before it. Whether it was paid is not read.
 */
export function scheduledPaymentDueStatus(
  date: string,
  dueDate: string,
): ScheduledPaymentDueStatus {
  return daysBetween(civil(dueDate), civil(date)) < 0 ? "due_after_date" : "due_on_or_before_date";
}
