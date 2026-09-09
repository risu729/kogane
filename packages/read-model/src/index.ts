// @kogane/read-model: the explicit read repository of the evidence browser.
// New queries go through ObservationReader; nothing rewrites SQL strings.

export {
  activeStateProjection,
  completeSnapshotCandidates,
  economicallySummable,
  evidenceExists,
  isObservationKind,
  OBSERVATION_TABLES,
  type ObservationKind,
  type ObservationTable,
  publishedParses,
  SNAPSHOT_RELATIONS,
  snapshotAdoptable,
  snapshotPolicyComparison,
  successfulFetchRuns,
  successfulParses,
  unitParseable,
  visibleEvidence,
} from "./concepts";
export {
  CANDIDATE_LIMIT,
  type CollectionScope,
  type MeasureView,
  ORDER_KEYS,
  type OrderKey,
  PAGE_LIMIT,
  type PageLimit,
  type PageSql,
  pagedCollection,
  periodMeasureSql,
  type Predicates,
  RESULT_BOUND,
  SCOPE_COLUMNS,
  type ScopeKey,
  scopePredicates,
} from "./scope";
export { parseWarnings, summarize } from "./mappers";
export {
  type ArtifactQuery,
  type BalanceHistoryQuery,
  type FilterOptionsKind,
  type FilterOptionsQuery,
  type LatestBalanceQuery,
  type ObservationReader,
  type ObservationReference,
  type ParsingHealth,
  type PositionQuery,
  type RawDownload,
  type RawDownloadReference,
  type ReaderOptions,
  ResultLimitExceededError,
  type SqlExecutor,
  type TransactionQuery,
} from "./reader";
export { createObservationReader } from "./observation-reader";
export { createD1ObservationReader, d1Executor, type D1Like } from "./d1";
