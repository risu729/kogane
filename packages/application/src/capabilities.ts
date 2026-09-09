// `kogane.capabilities`: what this principal may ask for, in machine-readable
// form. It reports the grant the principal already holds — its own scope, its
// own limits — and never the shape of what it cannot see: no source it is not
// granted, no account list, and no count of either (addendum 10 section 3).
//
// The advertised `ApiCapabilities` object is the same one `/api/meta` serves,
// so an agent and the human UI read one description of the deployment.
import type { ApiCapabilities } from "../../../poc/observation-pipeline/shared/api-schema.ts";
import { FINANCIAL_ERROR_CODES, type FinancialErrorCode } from "../../domain/src/result.ts";
import { ERROR_REMEDIES } from "./errors.ts";
import {
  type AgentCapability,
  DEFAULT_QUERY_LIMIT,
  type Grant,
  grantAllows,
  type ScopeSet,
} from "./grants.ts";
import { DEFAULT_EXPLAIN_DEPTH } from "./explain.ts";
import {
  INTENT_CAPABILITY,
  INTENT_FILTERS,
  SUPPORTED_QUERY_INTENTS,
  type SupportedQueryIntent,
} from "./query/spec.ts";
import { PROPOSAL_METHODS } from "./propose.ts";

export interface IntentDescription {
  intent: SupportedQueryIntent;
  requires: AgentCapability;
  filters: readonly string[];
}

export interface AgentCapabilitiesReport {
  schemaVersion: "kogane-capabilities-v1";
  principal: string;
  capabilities: readonly AgentCapability[];
  /** Only the intents this grant can actually run. */
  intents: IntentDescription[];
  scopes: { sources: ScopeSet; accounts: ScopeSet };
  limits: {
    defaultQueryLimit: number;
    maxRows: number;
    maxProposalTargets: number;
    maxExplainDepth: number;
    defaultExplainDepth: number;
    maxRequestBytes: number;
  };
  /** Relation kinds a proposal may claim; empty without `interpretation.propose`. */
  proposalMethods: readonly string[];
  resultSchemaVersion: "financial-result-v1";
  errorCodes: { code: FinancialErrorCode; remedy: string }[];
  /** No write beyond a proposal exists in this API; stated, not implied. */
  writes: { proposals: boolean; adoption: false; externalActions: false };
  api: ApiCapabilities;
}

export function capabilitiesFor(
  grant: Grant,
  api: ApiCapabilities,
  maxRequestBytes: number,
): AgentCapabilitiesReport {
  const intents = SUPPORTED_QUERY_INTENTS.filter((intent) =>
    grantAllows(grant, INTENT_CAPABILITY[intent]),
  ).map((intent) => ({
    intent,
    requires: INTENT_CAPABILITY[intent],
    filters: INTENT_FILTERS[intent],
  }));
  const proposes = grantAllows(grant, "interpretation.propose");
  return {
    schemaVersion: "kogane-capabilities-v1",
    principal: grant.principal,
    capabilities: [...grant.capabilities],
    intents,
    scopes: { sources: grant.scopes.sources, accounts: grant.scopes.accounts },
    limits: {
      defaultQueryLimit: DEFAULT_QUERY_LIMIT,
      maxRows: grant.budget.maxRows,
      maxProposalTargets: grant.budget.maxProposalTargets,
      maxExplainDepth: grant.budget.maxExplainDepth,
      defaultExplainDepth: DEFAULT_EXPLAIN_DEPTH,
      maxRequestBytes,
    },
    proposalMethods: proposes ? PROPOSAL_METHODS : [],
    resultSchemaVersion: "financial-result-v1",
    errorCodes: FINANCIAL_ERROR_CODES.map((code) => ({ code, remedy: ERROR_REMEDIES[code] })),
    writes: { proposals: proposes, adoption: false, externalActions: false },
    api,
  };
}
