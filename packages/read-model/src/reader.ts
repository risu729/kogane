// The explicit read repository of the evidence browser. Every query the API
// runs has a method here with a typed input; there is no way to hand the
// reader SQL text, and the API never sees a table name.

import type {
  ArtifactDetail,
  ArtifactRow,
  BalanceHistoryRow,
  BalanceRow,
  FilterOptions,
  ObservationDetail,
  ObservationKind,
  Overview,
  PositionWithValuations,
  TransactionRow,
} from "../../../poc/observation-pipeline/shared/api-contract";
import type { MeasureView, PageLimit } from "./scope";

export interface TransactionQuery {
  source?: string;
  account?: string;
  from?: string;
  to?: string;
  q?: string;
  offset: number;
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

export interface ObservationReader {
  overview(): Promise<Overview>;
  /** Registered parsing backlog for `/api/meta`; also probes that visible evidence is readable. */
  parsingHealth(): Promise<ParsingHealth>;
  listTransactions(query: TransactionQuery): Promise<TransactionRow[]>;
  listLatestBalances(query: LatestBalanceQuery): Promise<BalanceRow[]>;
  listBalanceHistory(query: BalanceHistoryQuery): Promise<BalanceHistoryRow[]>;
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
