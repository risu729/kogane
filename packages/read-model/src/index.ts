// @kogane/read-model: the explicit read repository of the evidence browser.
// New queries go through ObservationReader; nothing rewrites SQL strings.

export {
  activeStateProjection,
  completeSnapshotCandidates,
  isObservationKind,
  OBSERVATION_TABLES,
  type ObservationKind,
  type ObservationTable,
  publishedParses,
  successfulFetchRuns,
  successfulParses,
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
export {
  DECIMAL_POLICY_RELEASE,
  DEFAULT_IDENTITY_READ_MODE,
  IDENTITY_READ_MODES,
  type IdentityReadMode,
  type InterpretationContext,
  identityReleaseFor,
  interpretationContext,
  isIdentityReadMode,
  LATEST_IDENTITY_RELEASE,
  MAPPING_RELATIONS,
  MEASURE_POLICY_RELEASE,
  NO_RECORDED_IDENTITY_RELEASE,
} from "./identity";
export { organizationSql, PRODUCT_METADATA_LIMIT } from "./organization";
