// Browser-safe HTTP contracts. No database, runtime, or UI imports.
// Amount strings retain exact minor units; formatting never changes these values.
import type { ObservationOrganization } from "./organization-contract.ts";
import type { ApiCapabilities } from "./api-schema.ts";
export type { ApiCapabilities } from "./api-schema.ts";
export type ObservationKind = "transaction" | "balance" | "position" | "valuation";

export interface FilterOptions {
  sources: string[];
  accounts: {
    source_id: string;
    source_account: string;
    display_name?: string | null;
    organization_ambiguous?: boolean;
  }[];
  instruments: string[];
  metrics: string[];
}

/** Connection names the UI has labels for. Any other name is shown generically. */
type SourceKind = "local-store" | "central-store";

/**
 * A GLOBAL PASS month whose current activity snapshot is an `ok` parse with no
 * row while an older snapshot of the same month had rows. The read model's
 * currentness is unchanged: the newer empty capture stays current and the
 * older rows stay out of the lists; this names the month so a person can check
 * the provider's display. Identifiers only: no amount, no row.
 */
export interface GlobalPassEmptyMonth {
  source: string;
  /** `YYYY-MM`, the month the activity key names. */
  month: string;
  /** The fetch run whose empty page is the month's current snapshot. */
  currentFetchRunId: number;
  /** The newest older eligible fetch run of the month that had rows. */
  supersededFetchRunId: number;
  /** How many older eligible fetch runs of the month had rows; at least 1. */
  supersededRuns: number;
}

export interface GlobalPassEmptyMonths {
  /** Newest month first per source; at most 100. */
  months: GlobalPassEmptyMonth[];
  /** More such months exist than the list holds. */
  truncated: boolean;
}

export interface ApiMetadata {
  /** Registered parsing jobs only; not collector freshness or full source coverage. */
  parsingHealth?: { pending: number; running: number; failed: number };
  /**
   * GLOBAL PASS months whose current empty capture supersedes older rows; a
   * notice to check the provider, not a freshness or completeness claim.
   */
  globalPassEmptyMonths?: GlobalPassEmptyMonths;
  apiVersion: 1;
  source: {
    /**
     * Informational: where the data comes from, for labels only. Behaviour
     * switches on `capabilities`; renaming a kind must not change the UI.
     */
    kind: SourceKind | (string & {});
    /** Synthetic is an explicit assertion by an isolated fixture-only startup. */
    classification: "unknown" | "synthetic" | "financial";
  };
  /** Explicit, versioned capabilities; see `api-schema.ts`. Never an auth switch. */
  capabilities: ApiCapabilities;
}

export interface Warnings {
  /** Parsed warning strings; empty when the stored value could not be read. */
  list: string[];
  /** The stored text, so an unreadable value can be shown rather than hidden. */
  raw: string | null;
  parsed: boolean;
}

/**
 * One partial fetch run that refreshed some but not all of a dataset's units
 * (design review D13, policy `unit-independent-v1`). Counts and identifiers
 * only: unit keys are provider-owned labels and are not reported here.
 */
export interface UnitUpdateSummary {
  source_id: string;
  dataset: string;
  fetch_run_id: number;
  fetched_at: string;
  /** Units of this run whose own terminal report succeeded, so their evidence is new. */
  updated_units: number;
  /** Units of this run that failed; their previous snapshot still stands. */
  stale_units: number;
}

export interface Overview {
  counts: { table: string; rows: number }[];
  /**
   * Present only when a partial run updated some units of a dataset on the
   * `unit` eligibility scope, which no dataset uses until an operator enables
   * it. A reader that sees this key must not describe the run as a complete
   * refresh of the dataset.
   */
  unitUpdates?: UnitUpdateSummary[];
  sources: {
    id: string;
    provider: string;
    ingestion: string;
    artifact_count: number;
  }[];
  fetchRuns: {
    id: number;
    source_id: string;
    tool: string;
    external_run_id: string | null;
    status: string;
    started_at: string;
    completed_at: string | null;
  }[];
  parseRuns: {
    id: number;
    fetch_artifact_id: number;
    parser_name: string;
    parser_version: string;
    parsed_at: string;
    status: string;
    warnings: Warnings;
    error: string | null;
    superseded_by_parse_run_id: number | null;
  }[];
}

/**
 * `GET /api/v2/query`: the shared query service (`@kogane/application`) that
 * the agent API also calls. `contextId` and `resultRef` are the hand-off ids
 * between a page and an agent: each side reads them back under its own
 * authority rather than trusting the other's figures (addendum 11 section 8).
 * Only the fields the UI reads are declared; the server validates the whole
 * `financial-result-v1` contract.
 */
export interface SharedQueryResponse<T = unknown> {
  schemaVersion: "kogane-query-response-v1";
  contextId: string;
  resultRef: string;
  unresolvedInputs: { key: string; question: string; chosen: string; reasonCode: string }[];
  result: {
    schemaVersion: "financial-result-v1";
    contextId: string;
    completeness: "complete" | "partial" | "unavailable";
    data: T;
    coverage: {
      scopeRef: string;
      coveredRef: string;
      gaps: { reasonCode: string; scopeRef: string | null }[];
      truncated: boolean;
    };
    nextCursor: string | null;
    warnings: { code: string; severity: "info" | "warning" | "blocking" }[];
  };
}

/**
 * `data` of the `coverage` intent: what the authorised perimeter covers. Each
 * count is exact for its in-scope source, over the source's whole history.
 */
export interface CoverageSummaryData {
  intent: "coverage";
  scopes: {
    sourceRef: string;
    provider: string;
    ingestion: string;
    artifactCount: number;
    /** Visible fetch runs of the source; not the overview's newest-runs window. */
    collectionRunCount: number;
  }[];
  sourceCount: number;
  artifactCount: number;
  collectionRunCount: number;
}

export interface TransactionRow {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  interpretation?: import("./activity-semantics.ts").ActivityMeaning;
  organization?: ObservationOrganization;
  id: number;
  source_id: string;
  source_account: string;
  as_of: string | null;
  amount_minor: string | null;
  amount_text: string | null;
  currency: string | null;
  description: string | null;
  counterparty: string | null;
  external_id: string | null;
  status: string | null;
  parser: string;
}

export interface BalanceRow {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  interpretation?: import("./balance-semantics.ts").BalanceInterpretation;
  organization?: ObservationOrganization;
  id: number;
  source_id: string;
  source_account: string;
  metric: string;
  instrument: string;
  amount_minor: string | null;
  amount_text: string | null;
  as_of: string | null;
  observed_at: string | null;
  parser: string;
}

export interface BalanceHistoryRow extends BalanceRow {
  superseded_by_parse_run_id: number | null;
  parse_status: string;
}

export interface PositionRow {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  organization?: ObservationOrganization;
  id: number;
  source_id: string;
  source_account: string;
  security_code: string;
  security_name: string | null;
  market: string | null;
  quantity_text: string;
  quantity_scale: number;
  currency: string | null;
  as_of: string | null;
  parser: string;
}

export interface ValuationRow {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  organization?: ObservationOrganization;
  id: number;
  source_id: string;
  source_account: string;
  subject: string;
  metric: string;
  amount_minor: string | null;
  amount_text: string | null;
  currency: string;
  as_of: string | null;
  parser: string;
}

export interface PositionWithValuations {
  position: PositionRow;
  valuations: ValuationRow[];
}

export interface ArtifactRow {
  id: number;
  source_id: string;
  dataset: string | null;
  url: string | null;
  mime: string;
  fetched_at: string;
  sha256: string;
  parse_run_count: number;
  transaction_count: number;
  balance_count: number;
  position_count: number;
  valuation_count: number;
}

export interface ObservationRef {
  kind: ObservationKind;
  id: number;
  summary: string;
}

export interface ParseRunDetail {
  id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  status: string;
  error: string | null;
  warnings: Warnings;
  superseded_by_parse_run_id: number | null;
  observations: ObservationRef[];
}

export interface ArtifactDetail {
  artifact: {
    id: number;
    source_id: string;
    dataset: string | null;
    url: string | null;
    method: string | null;
    http_status: number | null;
    mime: string;
    fetched_at: string;
    sha256: string;
    size: number;
    content_type: string;
    fetch_run_id: number;
    tool: string;
    external_run_id: string | null;
    fetch_status: string;
    started_at: string;
    completed_at: string | null;
  };
  parseRuns: ParseRunDetail[];
}

export interface Provenance {
  parse_run_id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  parse_status: string;
  error: string | null;
  warnings: Warnings;
  superseded_by_parse_run_id: number | null;
  artifact_id: number;
  source_id: string;
  dataset: string | null;
  url: string | null;
  mime: string;
  fetched_at: string;
  sha256: string;
  size: number;
  content_type: string;
  fetch_run_id: number;
  tool: string;
  external_run_id: string | null;
  fetch_status: string;
  started_at: string;
  completed_at: string | null;
}

export interface ObservationDetail {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  organization?: ObservationOrganization;
  interpretationContext?: import("./api-schema.ts").InterpretationContext;
  kind: ObservationKind;
  row: Record<string, unknown>;
  extra: unknown;
  extraRaw: string;
  extraParsed: boolean;
  provenance: Provenance | undefined;
}

// ── v2 balance read model (review D10/D11) ──────────────────────────────
//
// `/api/v2/balances/latest` and `/api/v2/balances/history` are separate
// budgets over one fixed snapshot. Each item keeps the v1-shaped evidence row
// under `row`, so a display that already understands a balance row keeps
// working, and adds the typed read-model fields next to it: the quantity a
// calculation may use, what the measure means, whether it was adopted, and
// what time the value refers to.

export type BalanceAdoptionState = "adopted" | "excluded" | "unresolved" | "conflict" | "stale";

export interface ObservedQuantityWire {
  normalized: import("./normalized-decimal.ts").NormalizedDecimal;
  unitReference: string | null;
  /** Kept as evidence; never a second numeric contract. */
  sourceRepresentation: {
    amountText: string | null;
    legacyMinorUnits: string | null;
    /** Null when the currency has no exponent in the legacy parser contract. */
    legacyMinorUnitExponent: number | null;
  };
}

export interface MeasureDescriptor {
  metricId: string;
  definitionRelease: string;
  measurementKind: string;
  aggregationRule: string;
}

export interface BalanceEvidenceMember {
  ref: string;
  observationId: number;
  metric: string;
}

export interface BalanceAdoption {
  state: BalanceAdoptionState;
  reasonCode: string | null;
  /** Every witness of this one measurement; its length is the evidence count. */
  memberEvidence: BalanceEvidenceMember[];
  evidenceCount: number;
}

/** `TemporalReference` of packages/domain, as it travels on the wire. */
export interface TemporalReferenceWire {
  role: string;
  time: Record<string, unknown>;
}

export interface LatestBalanceItem {
  observationId: number;
  row: BalanceRow;
  quantity: ObservedQuantityWire;
  metric: MeasureDescriptor;
  adoption: BalanceAdoption;
  temporal: TemporalReferenceWire;
  freshness: { state: "current" | "stale" | "unknown"; reasonCode: string | null };
}

export interface BalanceHistoryItem {
  observationId: number;
  row: BalanceHistoryRow;
  quantity: ObservedQuantityWire;
  metric: MeasureDescriptor;
  temporal: TemporalReferenceWire;
}

export interface SnapshotPageInfo {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  snapshotId: string;
  paginationVersion: "keyset-v2";
}

export interface SnapshotDataCoverage {
  completeness: "complete" | "partial" | "unknown";
  stale: boolean;
  reasons: string[];
}

/**
 * Assets the adopted set accounts for, per unit. There is deliberately no
 * `netWorth` field: unfetched liabilities mean an asset subtotal is not even
 * a lower bound, so `liabilitiesCoverage` states that it is unknown
 * (addendum 05 section 5).
 */
export interface KnownAssetsSubtotals {
  policyRelease: string;
  knownAssetsSubtotal:
    | { unitRef: string; coefficient: string; scale: number; adoptedCount: number }[]
    | null;
  liabilitiesCoverage: "unknown";
  reasonCode: string | null;
}

export interface LatestBalancePage {
  schemaVersion: "snapshot-page-v1";
  items: LatestBalanceItem[];
  page: SnapshotPageInfo;
  dataCoverage: SnapshotDataCoverage;
  subtotals: KnownAssetsSubtotals;
  interpretationContext: import("./api-schema.ts").InterpretationContext;
}

export interface BalanceHistoryPage {
  schemaVersion: "snapshot-page-v1";
  items: BalanceHistoryItem[];
  page: SnapshotPageInfo;
  dataCoverage: SnapshotDataCoverage;
  interpretationContext: import("./api-schema.ts").InterpretationContext;
}

/**
 * How much a balance read answers per row (ADR 0123): `summary`, one short
 * line per row (the default of the routes and of `kogane.balances.read`), or
 * `full`, the row with its whole provenance. The rows, their order, the page,
 * its cursor, the coverage and the subtotals are the same under both.
 */
export const BALANCE_READ_DETAILS = ["summary", "full"] as const;
export type BalanceReadDetail = (typeof BALANCE_READ_DETAILS)[number];

/**
 * One value in a summary line. `value` is the exact decimal text and `scale`
 * its scale; a value that is not exact has neither, and `status` is its
 * reason (`missing`, `unparsed`, `conflict`), never a zero (INV05).
 */
export interface SummaryAmount {
  value: string | null;
  unit: string | null;
  status: import("./normalized-decimal.ts").NormalizedDecimal["status"];
  scale: number | null;
}

/**
 * One provider account a summary page's lines name, once per page. `ref`
 * (`a1`, `a2`, ... in order of first appearance) is local to the page;
 * `sourceAccount` is the provider's account key (what the read's `account`
 * filter takes); `account`, `label` and `status` are its organized account
 * entity, label and mapping status, and `lineage` whether the row was
 * organized under the current or a historical mapping, all four null when the
 * row's organization is unavailable.
 */
export interface SummaryAccount {
  ref: string;
  source: string;
  sourceAccount: string;
  account: string | null;
  label: string | null;
  status: import("./organization-contract.ts").OrganizedAccount["status"] | null;
  lineage: import("./organization-contract.ts").ObservationOrganization["lineage"];
}

/** One provider metric a summary page's lines name, once per page, with the registry's id for it. */
export interface SummaryMetric {
  ref: string;
  source: string;
  metric: string;
  providerMetric: string;
}

/** One summary line of a balance row; `observationId` reads it in full or as evidence. */
export interface BalanceSummaryLine {
  observationId: number;
  /** The `ref` of the page's `accounts` entry. */
  account: string;
  /** The `ref` of the page's `metrics` entry. */
  metric: string;
  amount: SummaryAmount;
  asOf: string | null;
}

/**
 * One summary line of a balance history row. History carries superseded and
 * failed parses' rows beside current ones, so `reasons` says which a row is:
 * `parse:superseded` when a later parse replaced its parse, and
 * `parse:<status>` when its parse is not `ok` (`parse:pending`,
 * `parse:error`: the parse run statuses migration 0017's CHECK allows);
 * none for a row of a current successful parse.
 */
export interface BalanceHistorySummaryItem extends BalanceSummaryLine {
  reasons: BalanceHistoryReason[];
}

/** The closed reason codes of a balance history summary line. */
export const BALANCE_HISTORY_REASONS = [
  "parse:superseded",
  "parse:pending",
  "parse:error",
] as const;
export type BalanceHistoryReason = (typeof BALANCE_HISTORY_REASONS)[number];

/**
 * One summary line of a latest balance: the adoption and freshness states,
 * and their reason codes as `adoption:<code>` and `freshness:<code>`.
 */
export interface LatestBalanceSummaryItem extends BalanceSummaryLine {
  freshness: LatestBalanceItem["freshness"]["state"];
  adoption: BalanceAdoptionState;
  reasons: string[];
}

export interface LatestBalanceSummaryPage extends Omit<
  LatestBalancePage,
  "items" | "interpretationContext"
> {
  detail: "summary";
  accounts: SummaryAccount[];
  metrics: SummaryMetric[];
  items: LatestBalanceSummaryItem[];
}

export interface BalanceHistorySummaryPage extends Omit<
  BalanceHistoryPage,
  "items" | "interpretationContext"
> {
  detail: "summary";
  accounts: SummaryAccount[];
  metrics: SummaryMetric[];
  items: BalanceHistorySummaryItem[];
}

// ── cash per account (ADR 0123, amendment 2026-11-20) ───────────────────
//
// `/api/v2/balances/cash` and `kogane.balances.read` `collection: cash`: the
// latest cash measurements of the published snapshot, one line per account,
// with exact subtotals per unit and per source. No unit is added to another,
// nothing is valued, and there is no net worth.

/**
 * The metrics this read counts as cash: the known-assets subtotal's metrics
 * (`known-assets-subtotal-v1`: `sum-disjoint` currency stocks with an
 * asset-positive sign and no overlap group). A test pins it to
 * `knownAssetMetricIds()`, so a registry change that moves a metric in or
 * out of that set fails until this list, its ADR and its docs follow.
 */
export const CASH_METRIC_IDS = [
  "broker.foreign-cash-deposit",
  "deposit.balance",
  "exchange.cash-balance",
] as const;
export type CashMetricId = (typeof CASH_METRIC_IDS)[number];

/**
 * Why a latest measurement of the scope is not cash, from its registry
 * definition, in this order:
 *
 *   * `metric_unknown` — the registry does not describe the provider metric;
 *   * `not_currency` — its unit is a reward point or another non-currency unit;
 *   * `not_a_stock` — a capacity, flow, period total, valuation, obligation,
 *     price or qualification, not an amount held;
 *   * `not_asset_positive` — a liability or a provider-signed amount;
 *   * `overlaps_another_measure` — it shares an overlap group with another
 *     measure (an aggregate, a provider total, a term-deposit principal);
 *   * `restates_a_balance` — a balance after a transaction (`select-one`);
 *   * `not_summable` — any other aggregation rule.
 */
export const CASH_LEFT_OUT_REASONS = [
  "metric_unknown",
  "not_currency",
  "not_a_stock",
  "not_asset_positive",
  "overlaps_another_measure",
  "restates_a_balance",
  "not_summable",
] as const;
export type CashLeftOutReason = (typeof CASH_LEFT_OUT_REASONS)[number];

/**
 * The reason the cash read adds to an adopted amount it does not count: its
 * account (or its provider reference) holds another adopted amount of the
 * same unit, so adding both could count one balance twice (INV06).
 */
export const CASH_REPORTED_TWICE = "cash:account_reported_twice";

/**
 * One cash measurement. `value` and `scale` are the exact decimal of an exact
 * value; a value that is not exact has neither, and `status` is its reason
 * (`missing`, `unparsed`, `conflict`), never a zero (INV05). `counted` says
 * whether the subtotals add it: adopted, exact, and the only adopted amount
 * of its unit on its line and on its provider reference. `reasons` are
 * `adoption:<code>`, `freshness:<code>` and `cash:account_reported_twice`;
 * an amount that is not counted always has one.
 */
export interface CashAmount {
  observationId: number;
  metric: CashMetricId;
  unit: string;
  value: string | null;
  scale: number | null;
  status: import("./normalized-decimal.ts").NormalizedDecimal["status"];
  adoption: BalanceAdoptionState;
  counted: boolean;
  asOf: string | null;
  reasons: string[];
}

/** One provider reference of an account: its source and account key, and its cash. */
export interface CashReference {
  source: string;
  /** The provider account key, as the read's `account` filter takes it. */
  sourceAccount: string;
  amounts: CashAmount[];
}

/**
 * One account: its organized account entity and readable label (ADR 0120),
 * both null when the rows' organization is unavailable, and the cash of each
 * provider reference that reaches it. An account reached through two
 * references is one line with two references, never two lines.
 */
export interface CashLine {
  account: string | null;
  label: string | null;
  references: CashReference[];
}

/**
 * The counted amounts of one unit, added exactly. `value` is null when no
 * amount is counted, never a zero. `status` is `partial` when an amount of
 * the unit is not counted for a reason other than adoption's `excluded`
 * (another counted measurement covers an excluded one), and `reasons` names
 * every not-counted amount's reasons.
 */
export interface CashSubtotal {
  unit: string;
  value: string | null;
  scale: number | null;
  counted: number;
  notCounted: number;
  status: "complete" | "partial";
  reasons: string[];
}

export interface CashSourceSubtotal extends CashSubtotal {
  source: string;
}

/**
 * At most this many metric ids on one `leftOut` entry, those with the most
 * rows first; `moreMetrics` counts the rest, so the entry stays bounded
 * whatever the registry grows to (the overview summary's pattern, ADR 0123).
 */
export const CASH_LEFT_OUT_METRICS = 3;

/** The latest measurements of the scope that are not cash, per reason. */
export interface CashLeftOut {
  reason: CashLeftOutReason;
  rows: number;
  metrics: string[];
  moreMetrics: number;
}

/**
 * The bytes a cash page is held to: the UTF-8 bytes of the tool's answer,
 * `{ schemaVersion: "kogane-page-read-v1", data }` serialized as `/mcp`
 * writes its text content, at most the 8 KB an MCP client shows (issue
 * 1414). The route answers `data` alone, which is shorter.
 */
export const CASH_PAGE_BYTES = 8_192;

/**
 * The bytes of a page read tool's answer that carries `data`, as `/mcp`
 * writes it (`services/app/src/page-read-tools.ts` names the envelope; a
 * test there pins this to the text `/mcp` answers).
 */
export function cashAnswerBytes(data: unknown): number {
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: "kogane-page-read-v1", data }))
    .length;
}

/**
 * A page holds whole lines up to `limit` measurements (ten by default,
 * `DEFAULT_SUMMARY_PAGE_LIMIT`), as `limit` counts rows on the latest page,
 * and fewer when the next line would carry the tool's answer past
 * `CASH_PAGE_BYTES`. A line with more measurements than `limit` is a page of
 * its own; a page that cannot hold its first line within the bytes is
 * refused (`413 result_limit_exceeded`), never cut.
 */
export interface CashPageInfo extends SnapshotPageInfo {
  /** Lines in the whole scope; the page holds at most `limit` of them. */
  lines: number;
}

export interface CashPerAccountPage {
  schemaVersion: "snapshot-page-v1";
  collection: "cash";
  /** `known-assets-subtotal-v1`: the policy that names the cash metrics. */
  policyRelease: string;
  lines: CashLine[];
  /** Over the whole filter scope, never the page. */
  subtotals: { byUnit: CashSubtotal[]; bySource: CashSourceSubtotal[] };
  leftOut: CashLeftOut[];
  /** Unfetched liabilities mean cash is not a net worth, or a lower bound of one. */
  liabilitiesCoverage: "unknown";
  dataCoverage: SnapshotDataCoverage;
  page: CashPageInfo;
}

/**
 * `GET /api/overview` as its route answers it in full: the reader's overview,
 * each list cut to 500 rows, with that bound's coverage.
 */
export interface OverviewPage extends Overview {
  coverage: { limit: number; truncated: boolean };
}

/** The closed statuses of `observation_fetch_runs.status` (migration 0017's view). */
export const OVERVIEW_FETCH_RUN_STATUSES = ["success", "partial"] as const;
/** The closed statuses of `parse_runs.status` (migration 0017's CHECK). */
export const OVERVIEW_PARSE_RUN_STATUSES = ["ok", "pending", "error"] as const;

/**
 * At most this many lines in each of the overview summary's per-source and
 * per-parser lists (`notSuccessful`, `notOk`, `unitUpdates`), those with the
 * newest runs; the lines left out are counted in the list's `...Omitted`
 * entry and listed in `full` (ADR 0123, amendment 2026-11-19). It bounds the
 * summary: no other part of it grows with the number of failing sources or
 * parsers.
 */
export const OVERVIEW_SUMMARY_LINES = 5;
/**
 * At most this many failure codes on one `notOk` line, the newest first; the
 * rest are counted in its `moreFailureCodes`, and every one of them is on its
 * status's `byStatus` line (ADR 0123, amendment 2026-11-19).
 */
export const OVERVIEW_LINE_FAILURE_CODES = 3;

/** The lines of one status that a capped overview summary list left out, and their runs. */
export interface OverviewOmitted<Status extends string> {
  status: Status;
  lines: number;
  runs: number;
}

/**
 * The summary detail of `GET /api/overview` and `kogane.store.read`
 * `{page: overview}` (ADR 0123, amendment 2026-11-19): the counts and the
 * coverage as the full answer has them, the sources as their artifact counts
 * (sources with the same count share one line), and the fetch and parse run
 * windows collapsed by status, each parse status with every failure code of
 * its runs. For every status that is not a success, the
 * `OVERVIEW_SUMMARY_LINES` sources or parsers with the newest runs have a
 * line of their own (a failing parser's with its newest failure codes), and
 * the rest are counted, never dropped silently. Provenance (producer,
 * session id, parser version, the superseding parse's id) and text (provider
 * names, warnings) are in `full` only.
 */
export interface OverviewSummary {
  detail: "summary";
  counts: Overview["counts"];
  sources: { sourceIds: string[]; artifacts: number }[];
  fetchRuns: {
    /** One line per status in the window: how many runs, of how many sources, and the newest. */
    byStatus: {
      status: (typeof OVERVIEW_FETCH_RUN_STATUSES)[number];
      runs: number;
      sources: number;
      newest: { id: number; sourceId: string; startedAt: string; completedAt: string | null };
    }[];
    /**
     * One line per source and status other than `success`, with its newest
     * such run: the `OVERVIEW_SUMMARY_LINES` with the newest runs.
     */
    notSuccessful: {
      sourceId: string;
      status: (typeof OVERVIEW_FETCH_RUN_STATUSES)[number];
      runs: number;
      newest: { id: number; startedAt: string; completedAt: string | null };
    }[];
    /** Per status, the `notSuccessful` lines left out and their runs; empty when none is. */
    notSuccessfulOmitted: OverviewOmitted<(typeof OVERVIEW_FETCH_RUN_STATUSES)[number]>[];
  };
  parseRuns: {
    /**
     * One line per status in the window: how many runs, how many of them a
     * later parse superseded, carried warnings or carried warnings that could
     * not be read, how many parsers, every distinct failure code of its runs
     * (newest first; at most the Processor's closed set), and the newest.
     */
    byStatus: {
      status: (typeof OVERVIEW_PARSE_RUN_STATUSES)[number];
      runs: number;
      superseded: number;
      withWarnings: number;
      unreadableWarnings: number;
      parsers: number;
      failureCodes: string[];
      newest: { id: number; artifactId: number; parser: string; parsedAt: string };
    }[];
    /**
     * One line per parser and status other than `ok`, with its failure codes
     * and newest such run: the `OVERVIEW_SUMMARY_LINES` with the newest runs.
     */
    notOk: {
      parser: string;
      status: (typeof OVERVIEW_PARSE_RUN_STATUSES)[number];
      runs: number;
      superseded: number;
      /**
       * The distinct failure codes (`parse_runs.error`, a closed code the
       * Processor writes) of the line's runs, newest first, at most
       * `OVERVIEW_LINE_FAILURE_CODES`; a value that is not code-shaped is
       * `unclassified`. Empty for a line with none.
       */
      failureCodes: string[];
      /** How many more distinct failure codes the line's runs have; each is on its `byStatus` line. */
      moreFailureCodes: number;
      newest: { id: number; artifactId: number; parsedAt: string };
    }[];
    /** Per status, the `notOk` lines left out and their runs; empty when none is. */
    notOkOmitted: OverviewOmitted<(typeof OVERVIEW_PARSE_RUN_STATUSES)[number]>[];
  };
  /**
   * One line per source and dataset of the full answer's `unitUpdates`: the
   * `OVERVIEW_SUMMARY_LINES` with the newest runs. Absent when it is.
   */
  unitUpdates?: {
    sourceId: string;
    dataset: string;
    runs: number;
    newest: { fetchRunId: number; fetchedAt: string; updatedUnits: number; staleUnits: number };
  }[];
  /** The `unitUpdates` lines left out and their runs; present exactly when `unitUpdates` is. */
  unitUpdatesOmitted?: { lines: number; runs: number };
  coverage: OverviewPage["coverage"];
}
