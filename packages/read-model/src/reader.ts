// The explicit read repository of the evidence browser. Every query the API
// runs has a method here with a typed input; there is no way to hand the
// reader SQL text, and the API never sees a table name.

import type {
  ArtifactDetail,
  ArtifactRow,
  BalanceHistoryRow,
  BalanceRow,
  FilterOptions,
  GlobalPassEmptyMonths,
  ObservationDetail,
  ObservationKind,
  Overview,
  PositionWithValuations,
  TransactionRow,
  UnitUpdateSummary,
} from "../../../packages/observation-shared/src/api-contract";
import type { MeasureView, PageLimit } from "./scope";
import type { SbiIncomeHistoryQuery, SbiIncomeHistoryRow } from "./sbi-income-history";
import type {
  PortfolioValuationHistoryQuery,
  PortfolioValuationHistoryRow,
} from "./portfolio-valuation-history";

export interface TransactionQuery {
  source?: string;
  account?: string;
  from?: string;
  to?: string;
  q?: string;
  offset: number;
}

/** The scope of `undatedTransactions`: a transaction query without a window or page. */
export type UndatedTransactionQuery = Pick<TransactionQuery, "source" | "account" | "q">;
/** Current transactions of one source account whose `as_of` starts with no calendar date. */
export interface UndatedTransactionCount {
  source_id: string;
  source_account: string;
  row_count: number;
}

export interface LatestBalanceQuery {
  source?: string;
  account?: string;
  instrument?: string;
  metric?: string;
  measureView?: MeasureView;
  offset: number;
  /**
   * 501 for one page. 5001 for the complete bounded candidate set a grouping
   * caller needs before it can page; more than 5,000 candidates is refused.
   */
  limit: PageLimit;
}

export interface BalanceHistoryQuery {
  source?: string;
  account?: string;
  instrument?: string;
  metric?: string;
  measureView?: MeasureView;
  offset: number;
}

export interface PositionQuery {
  source?: string;
  account?: string;
  offset: number;
}

export interface ArtifactQuery {
  /** Exclusive upper artifact id: pages walk an immutable descending id cursor. */
  before: number;
  source?: string;
}

export type FilterOptionsKind = "transactions" | "balances" | "positions" | "artifacts";
export interface FilterOptionsQuery {
  kind: FilterOptionsKind;
  measureView?: MeasureView;
}

export interface ObservationReference {
  kind: ObservationKind;
  id: number;
}

/** A hash the caller is already authenticated to read; reachability is re-checked here. */
export interface RawDownloadReference {
  sha256: string;
}

export interface RawDownload {
  sha256: string;
  blob_key: string;
  byte_size: number;
  artifact_key: string;
  declared_media_type: string | null;
}

export interface ParsingHealth {
  pending: number;
  running: number;
  failed: number;
}

/** One row of `sourceParseRuns`: the run and the parser build it ran. */
export interface SourceParseRun {
  id: number;
  parser_name: string;
  parser_version: string;
}

/**
 * Marks of what the publication gate, the run exclusions and the dataset
 * policies have done: the newest `publication_events` id, the number of
 * `exclude_from_financial_views` annotations, and the policy columns the
 * current lists read. An activation or a rollback moves an artifact's
 * published run without recording a newer parse run, an exclusion hides a run
 * without one, and an operator's policy update (a dataset named for the `unit`
 * eligibility scope, another snapshot policy) changes which published runs are
 * current without one; each still moves these marks.
 */
export interface PublicationMarks {
  publicationEvent: number;
  exclusions: number;
  /**
   * The policy rows of the read sources as canonical text: one JSON array per
   * row, sorted, so equal policies give equal text whatever order the store
   * returns them in. `"[]"` when no row names those sources.
   */
  snapshotPolicies: string;
}

/** One source's visible fetch runs, counted over its whole history. */
export interface SourceFetchRunCount {
  source_id: string;
  run_count: number;
}

export interface ObservationReader {
  overview(): Promise<Overview>;
  /**
   * The exact number of visible fetch runs of each listed source, over each
   * source's whole history: no window, and no run of an unlisted source is
   * read. A listed source with no visible run has no row; an empty list reads
   * nothing. Ordered by source id.
   */
  fetchRunCounts(sources: readonly string[]): Promise<SourceFetchRunCount[]>;
  /**
   * The newest visible parse runs of the listed sources, newest first: the
   * overview's parse-run window (`PAGE_LIMIT` rows), restricted to those
   * sources before it is bounded, so a run of an unlisted source never takes a
   * place in it. An empty list reads nothing.
   */
  sourceParseRuns(sources: readonly string[]): Promise<SourceParseRun[]>;
  /**
   * `PublicationMarks` of the listed sources, or of every source for `null`.
   * A listed source's marks never move with another source's events; an
   * empty list reads nothing and is zero.
   */
  publicationMarks(sources: readonly string[] | null): Promise<PublicationMarks>;
  /**
   * D13 partial-update signal: partial fetch runs that refreshed some units of
   * a dataset on the `unit` eligibility scope. Empty for every dataset on the
   * seeded `run` scope, which is why `overview()` omits the key entirely then.
   */
  unitUpdates(): Promise<UnitUpdateSummary[]>;
  /** Registered parsing backlog for `/api/meta`; also probes that visible evidence is readable. */
  parsingHealth(): Promise<ParsingHealth>;
  /**
   * GLOBAL PASS months whose current snapshot is empty while an older snapshot
   * of the same month had rows, for `/api/meta`. Reports only; the currentness
   * rule that `listTransactions` applies is not changed by this read.
   */
  globalPassEmptyMonths(): Promise<GlobalPassEmptyMonths>;
  listTransactions(query: TransactionQuery): Promise<TransactionRow[]>;
  /**
   * Per source account, how many current transactions in scope a `from`/`to`
   * window of `listTransactions` leaves out because their `as_of` starts with
   * no calendar date (null, a year-month, an impossible day or other text).
   * Only accounts with such rows are listed.
   */
  undatedTransactions(query: UndatedTransactionQuery): Promise<UndatedTransactionCount[]>;
  listLatestBalances(query: LatestBalanceQuery): Promise<BalanceRow[]>;
  listBalanceHistory(query: BalanceHistoryQuery): Promise<BalanceHistoryRow[]>;
  /** Latest complete full-retention provider payment/sale facts; no economic adoption. */
  listSbiIncomeHistory(query: SbiIncomeHistoryQuery): Promise<SbiIncomeHistoryRow[]>;
  listPortfolioValuationHistory(
    query: PortfolioValuationHistoryQuery,
  ): Promise<PortfolioValuationHistoryRow[]>;
  listPositions(query: PositionQuery): Promise<PositionWithValuations[]>;
  listArtifacts(query: ArtifactQuery): Promise<ArtifactRow[]>;
  filterOptions(query: FilterOptionsQuery): Promise<FilterOptions>;
  getArtifact(id: number): Promise<ArtifactDetail | undefined>;
  getObservation(reference: ObservationReference): Promise<ObservationDetail | undefined>;
  getRawDownload(reference: RawDownloadReference): Promise<RawDownload | undefined>;
}

/** A list exceeded the 5,000-row bound; the result is refused rather than truncated. */
export class ResultLimitExceededError extends Error {
  readonly code = "result_limit_exceeded";
  constructor() {
    super("result_limit_exceeded");
    this.name = "ResultLimitExceededError";
  }
}

/** The only thing an implementation needs from a database: run SQL with bound arguments. */
export interface SqlExecutor {
  all<T>(sql: string, args: readonly unknown[]): Promise<T[]>;
  first<T>(sql: string, args: readonly unknown[]): Promise<T | null>;
}

export interface ReaderOptions {
  /** Build the error thrown when a list exceeds the bound (an HTTP layer maps it to 413). */
  limitExceeded?: () => Error;
}
