import { canonicalDigest } from "../../../domain/src/context.ts";
import { ACTOR_PATTERN } from "../command/grants.ts";
import {
  DELEGATION_CAPABILITIES,
  MCP_AUTHORITY,
  type DelegationCaller,
  type DelegationResolution,
  type DelegationScopes,
} from "./contract.ts";

const PREFIX = "mcp-client:";
const WHOLE_STORE: DelegationScopes = { sources: "*", accounts: "*", scheduleSources: "*" };

/**
 * ADR 0084: an MCP client Cloudflare Access verified on the dedicated MCP
 * application may apply every operation the UI offers, over the whole store,
 * as itself. Nothing is configured: the Access policy decides who signs in.
 * The adapter must pass the verified caller, never a claimed body/header.
 */
export async function resolveDelegation(input: {
  caller: DelegationCaller;
  now: string;
}): Promise<DelegationResolution> {
  const { caller } = input;
  if (caller.kind !== "mcp-client" || !caller.principal.startsWith(PREFIX))
    return { ok: false, code: "delegation_not_mcp_client" };
  const subject = caller.principal.slice(PREFIX.length);
  // The actor shape every writer accepts; `mcpCaller` never forms another.
  if (subject.length > 128 || !ACTOR_PATTERN.test(subject) || subject.startsWith(PREFIX))
    return { ok: false, code: "delegation_not_mcp_client" };
  const now = Date.parse(input.now);
  if (Number.isNaN(now)) return { ok: false, code: "delegation_misconfigured" };
  const capabilities = [...DELEGATION_CAPABILITIES];
  const budget = { writesPerDay: MCP_AUTHORITY.writesPerDay };
  return {
    ok: true,
    principal: {
      kind: "delegated",
      id: caller.principal,
      delegator: subject,
      capabilities,
      scopes: WHOLE_STORE,
      // Bounds only this request's App→Processor envelope; every call
      // resolves again.
      notAfter: new Date(now + MCP_AUTHORITY.envelopeMs).toISOString(),
      budget,
      // No clock in it, so a confirm binds to the authority its prepare
      // recorded.
      delegationRef: `dlg_${await canonicalDigest({
        v: "kogane-mcp-authority-v2",
        principal: caller.principal,
        delegator: subject,
        capabilities,
        scopes: WHOLE_STORE,
        budget,
      })}`,
    },
  };
}
