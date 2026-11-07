// The only transport adapter for the core resolver. Authentication stays in
// auth.ts; no token parsing, new identity, or browser-principal promotion.
// ADR 0084: nothing configures the authority; the verified caller is enough.
import {
  resolveDelegation,
  delegationCapabilities,
  type DelegationCapability,
} from "../../../packages/application/src/index";
import type { AgentCaller } from "./auth";

export async function resolveMcpDelegation(_env: unknown, caller: AgentCaller, now: string) {
  return resolveDelegation({ caller, now });
}
export async function mcpDelegationCapabilities(
  _env: unknown,
  caller: AgentCaller,
  now: string,
  installed: readonly DelegationCapability[] = [],
) {
  return delegationCapabilities(await resolveDelegation({ caller, now }), installed);
}
