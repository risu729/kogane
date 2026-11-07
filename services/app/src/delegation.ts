// The only transport adapter for the core resolver. Authentication stays in
// auth.ts; no token parsing, new identity, or browser-principal promotion.
// ADR 0084: the authority follows from OPERATOR_SUBJECTS (graded as the UI
// grades it) and the principal's AGENT_API_GRANTS read grant; nothing else
// configures it.
import {
  parseGrants,
  resolveDelegation,
  delegationCapabilities,
  type DelegationCapability,
} from "../../../packages/application/src/index";
import type { AgentCaller } from "./auth";

export interface DelegationVars {
  OPERATOR_SUBJECTS?: string;
  AGENT_GRANTS?: string;
  AGENT_API_GRANTS?: string;
}
export async function resolveMcpDelegation(env: DelegationVars, caller: AgentCaller, now: string) {
  return resolveDelegation({
    grants: { OPERATOR_SUBJECTS: env.OPERATOR_SUBJECTS, AGENT_GRANTS: env.AGENT_GRANTS },
    readGrant: parseGrants(env.AGENT_API_GRANTS).get(caller.principal) ?? null,
    caller,
    now,
  });
}
export async function mcpDelegationCapabilities(
  env: DelegationVars,
  caller: AgentCaller,
  now: string,
  installed: readonly DelegationCapability[] = [],
) {
  return delegationCapabilities(await resolveMcpDelegation(env, caller, now), installed);
}
