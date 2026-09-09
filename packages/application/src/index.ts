// @kogane/application: the application services shared by HTTP, UI and MCP
// adapters. Query services (A08) and command services (A09) live side by side;
// this barrel is the only import surface.

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
