// The only transport adapter for the core resolver. Authentication stays in
// auth.ts; no token parsing, new identity, or browser-principal promotion.
import {
  parseGrants,
  resolveDelegation,
  delegationCapabilities,
} from "../../../packages/application/src/index";
import type { AgentCaller } from "./auth";

export interface DelegationVars {
  MCP_DELEGATIONS?: string;
  OPERATOR_SUBJECTS?: string;
  AGENT_API_GRANTS?: string;
}
export async function mcpDelegationCapabilities(
  env: DelegationVars,
  caller: AgentCaller,
  now: string,
) {
  return delegationCapabilities(
    await resolveDelegation({
      configured: env.MCP_DELEGATIONS,
      operatorSubjects: env.OPERATOR_SUBJECTS,
      readGrants: parseGrants(env.AGENT_API_GRANTS),
      caller,
      now,
    }),
  );
}
