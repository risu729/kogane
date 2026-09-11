// @kogane/application: the application services shared by HTTP, UI and MCP
// adapters. Query services (A08) and command services (A09) live side by side;
// this barrel is the only import surface. Pure: no Cloudflare `Env`, no
// database handle, no HTTP, no clock of its own.
//
// Two capability vocabularies meet here and are deliberately not merged. The
// command path grades a *principal* (`AGENT_CAPABILITIES` /
// `HUMAN_CAPABILITIES`, `CommandCapability`); the query path grades a *grant*
// looked up per principal (`QUERY_GRANT_CAPABILITIES`, `AgentCapability`).
// They answer different questions, so a caller must name the one it means.

// ── command services (A09) ───────────────────────────────────────────
export { APPROVAL_TTL_SECONDS_DEFAULT, approve, type ApproveInput } from "./command/approve.ts";
export {
  commandKey,
  CHANGE_KINDS,
  COMMAND_CAPABILITIES,
  type ApprovalReceipt,
  type BatchOutcome,
  type ChangeKind,
  type ChangePayload,
  type ChangePlan,
  type CommandCapability,
  type CommandReceipt,
  type CommandStore,
  type CommitGuard,
  type ExpectedRevisions,
  type GrantLoader,
  type IdentityAssignPayload,
  type IdentityReleasePayload,
  type IdentitySubject,
  IDENTITY_SUBJECTS,
  isChangeKind,
  type MutationInput,
  type MutationPlanner,
  type MutationPlanners,
  type MutationWrites,
  type OperationReceiptStatus,
  OUTBOX_TARGETS,
  type OutboxTarget,
  type PlanStatus,
  type PlanTarget,
  type PreparedWrite,
  type Principal,
  type PrincipalKind,
  principalCan,
  type RelationPayload,
  type Simulation,
  validPayload,
} from "./command/contract.ts";
export {
  commandError,
  COMMAND_ERROR_CODES,
  type CommandError,
  type CommandErrorCode,
  type CommandResult,
  statusForCommandError,
} from "./command/errors.ts";
export {
  agentSubjects,
  AGENT_CAPABILITIES,
  HUMAN_CAPABILITIES,
  staticGrantLoader,
} from "./command/grants.ts";
export {
  createPlan,
  loadPlan,
  PLAN_TTL_SECONDS_DEFAULT,
  planDigestOf,
  type PlanContext,
} from "./command/plan.ts";
export {
  currentRevisions,
  markStale,
  simulate,
  type SimulationReport,
} from "./command/simulate.ts";
export { commit, type CommitInput, type CommitOutput, getReceipt } from "./command/commit.ts";
export { relationMutation } from "./operations/relation-writes.ts";
export { d1CommandStore, type D1Like } from "./operations/store.ts";
export {
  currentRevisionsSql,
  expectedRevisionsJson,
  expectedRevisionsSql,
  identitySubjectRef,
  relationSubjectRef,
  subjectRefOf,
} from "./operations/sql.ts";
export { resolveAndSimulate } from "./operations/targets.ts";

// ── operations services (02 §4, U06) ─────────────────────────────────
export {
  type AcceptedOperation,
  type CollectionRequest,
  type DispatchResult,
  DISPATCH_STATES,
  type DispatchState,
  type ImportRequest,
  OPERATION_KINDS,
  OPERATION_STAGES,
  OPERATION_STATUSES,
  type OperationContext,
  type OperationKind,
  operationIdFor,
  operationPayloadDigest,
  type OperationReceipt,
  type OperationRequest,
  type OperationStage,
  type OperationStageReport,
  type OperationStatus,
  pendingDispatches,
  type ProjectionRequest,
  readOperation,
  recordDispatch,
  recordOperationStage,
  type ReplayRequest,
  requestCollection,
  requestImport,
  requestProjectionRebuild,
  requestReplay,
  requestSessionRefresh,
  SESSION_REFRESH_MODES,
  type SessionRefreshMode,
  sessionRefreshPolicy,
  type SessionRefreshRequest,
  STAGE_STATES,
  STAGES_BY_KIND,
  type StageReport,
  type StageState,
} from "./operations/requests.ts";

// ── query services (A08) ─────────────────────────────────────────────
export {
  AGENT_CAPABILITIES as QUERY_GRANT_CAPABILITIES,
  type AgentCapability,
  DEFAULT_QUERY_LIMIT,
  type Grant,
  type GrantBudget,
  GRANT_LIMITS,
  grantAllows,
  grantAllowsAccount,
  grantAllowsRow,
  grantAllowsSource,
  grantedSources,
  grantFor,
  parseGrants,
  perimeterRefFor,
  type ScopeSet,
  validGrant,
} from "./grants.ts";
export { ERROR_REMEDIES, ERROR_STATUS, financialError } from "./errors.ts";
export {
  type AgentCapabilitiesReport,
  capabilitiesFor,
  type IntentDescription,
} from "./capabilities.ts";
export {
  contextIdOf,
  type ContextInputs,
  EVENT_DECISION_MANIFEST_REF,
  openContext,
  type OpenContextRequest,
  type OpenedContext,
  QUERY_SEMANTICS_VERSION,
  type UnresolvedInput,
} from "./context/open.ts";
export {
  INTENT_CAPABILITY,
  INTENT_FILTERS,
  parseQueryRequest,
  QUERY_FILTER_KEYS,
  type QueryFilterKey,
  type QueryRequest,
  querySpecDigest,
  requestedLimit,
  resolveQuerySpec,
  SUPPORTED_QUERY_INTENTS,
  type SupportedQueryIntent,
} from "./query/spec.ts";
export { type CursorPayload, decodeCursor, encodeCursor, resumeOffset } from "./query/cursor.ts";
export {
  type ActivityRow,
  type CoverageScope,
  type CoverageSummary,
  executeQuery,
  type QueryData,
  type QueryExecution,
  type QueryOutcome,
  type QueryReader,
  type ReportedStateRow,
} from "./query/execute.ts";
export {
  DEFAULT_EXPLAIN_DEPTH,
  explain,
  type ExplainReader,
  type ExplainRequest,
  type ExplanationGraph,
  type ExplanationNode,
  EXPLANATION_NODE_KINDS,
  MAX_NODE_DEPTH,
  parseExplainRequest,
} from "./explain.ts";
export {
  parseProposalRequest,
  PROPOSAL_METHODS,
  type ProposalMethod,
  type ProposalReceipt,
  type ProposalRequest,
  type ProposalStore,
  proposeReconciliation,
  type ResolvedRef,
  type StoredProposal,
} from "./propose.ts";
