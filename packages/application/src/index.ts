// @kogane/application: the query and command application services shared by
// the human UI, the HTTP API and the MCP adapter. Pure: no Cloudflare `Env`,
// no database handle, no HTTP, no clock of its own. Adapters pass a reader, a
// grant and a clock in and get a `FinancialResult` out.
//
// A thin barrel on purpose: `src/query/**`, `src/context/**` and the modules
// beside them are the units, and `src/command/**` is added separately.
export {
  AGENT_CAPABILITIES,
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
