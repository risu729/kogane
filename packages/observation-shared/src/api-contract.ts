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
 * The summary detail of `GET /api/overview` and `kogane.store.read`
 * `{page: overview}` (ADR 0123, amendment 2026-11-19): the counts and the
 * coverage as the full answer has them, the sources as their artifact counts
 * (sources with the same count share one line), and the fetch and parse run
 * windows collapsed by status, with one line per source or parser for every
 * status that is not a success, a failing parser's line with its failure
 * codes. Provenance (producer, session id, parser version, the superseding
 * parse's id) and text (provider names, warnings) are in `full` only.
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
    /** One line per source and status other than `success`, with its newest such run. */
    notSuccessful: {
      sourceId: string;
      status: (typeof OVERVIEW_FETCH_RUN_STATUSES)[number];
      runs: number;
      newest: { id: number; startedAt: string; completedAt: string | null };
    }[];
  };
  parseRuns: {
    /**
     * One line per status in the window: how many runs, how many of them a
     * later parse superseded, carried warnings or carried warnings that could
     * not be read, how many parsers, and the newest.
     */
    byStatus: {
      status: (typeof OVERVIEW_PARSE_RUN_STATUSES)[number];
      runs: number;
      superseded: number;
      withWarnings: number;
      unreadableWarnings: number;
      parsers: number;
      newest: { id: number; artifactId: number; parser: string; parsedAt: string };
    }[];
    /** One line per parser and status other than `ok`, with its failure codes and newest such run. */
    notOk: {
      parser: string;
      status: (typeof OVERVIEW_PARSE_RUN_STATUSES)[number];
      runs: number;
      superseded: number;
      /**
       * The distinct failure codes (`parse_runs.error`, a closed code the
       * Processor writes) of the line's runs, newest first; a value that is
       * not code-shaped is `unclassified`. Empty for a line with none.
       */
      failureCodes: string[];
      newest: { id: number; artifactId: number; parsedAt: string };
    }[];
  };
  /** One line per source and dataset of the full answer's `unitUpdates`; absent when it is. */
  unitUpdates?: {
    sourceId: string;
    dataset: string;
    runs: number;
    newest: { fetchRunId: number; fetchedAt: string; updatedUnits: number; staleUnits: number };
  }[];
  coverage: OverviewPage["coverage"];
}
