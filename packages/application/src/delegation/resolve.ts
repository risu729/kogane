import { canonicalDigest } from "../../../domain/src/context.ts";
import { ACTOR_PATTERN, resolvePrincipal, type SubjectGrantVars } from "../command/grants.ts";
import type { Grant } from "../grants.ts";
import {
  DELEGATION_CAPABILITIES,
  MCP_AUTHORITY,
  WHOLE_STORE_CAPABILITIES,
  type DelegationCaller,
  type DelegationResolution,
  type DelegationScopes,
} from "./contract.ts";

const PREFIX = "mcp-client:";

/**
 * ADR 0084: the verified MCP principal of the UI operator may apply, over MCP,
 * the operations that operator may apply in the UI. Nothing is declared: the
 * subject is graded by the UI's own resolver (`resolvePrincipal`), and the
 * scope is the principal's read grant, so an operation never reaches what the
 * same principal could not read. The adapter must pass the verified caller
 * and its looked-up grant, never a claimed body/header.
 */
export async function resolveDelegation(input: {
  grants: SubjectGrantVars;
  readGrant: Grant | null;
  caller: DelegationCaller;
  now: string;
}): Promise<DelegationResolution> {
  const { caller } = input;
  if (caller.kind !== "mcp-client" || !caller.principal.startsWith(PREFIX))
    return { ok: false, code: "delegation_not_mcp_client" };
  const subject = caller.principal.slice(PREFIX.length);
  // The subject shape the old declarations required of `delegatedBy`.
  if (subject.length > 128 || !ACTOR_PATTERN.test(subject) || subject.startsWith(PREFIX))
    return { ok: false, code: "delegation_not_configured" };
  const graded = resolvePrincipal(input.grants, subject);
  if (!graded.ok)
    return {
      ok: false,
      code:
        graded.code === "grants_misconfigured"
          ? "delegation_misconfigured"
          : "delegation_not_configured",
    };
  if (graded.principal.kind !== "human") return { ok: false, code: "delegation_not_configured" };
  const grant = input.readGrant;
  if (grant === null || grant.principal !== caller.principal)
    return { ok: false, code: "delegation_not_configured" };
  const now = Date.parse(input.now);
  if (Number.isNaN(now)) return { ok: false, code: "delegation_misconfigured" };
  const scopes: DelegationScopes = {
    sources: grant.scopes.sources,
    accounts: grant.scopes.accounts,
    scheduleSources: grant.scopes.scheduleSources ?? [],
  };
  const wholeStore = scopes.sources === "*" && scopes.accounts === "*";
  const capabilities = DELEGATION_CAPABILITIES.filter(
    (capability) => wholeStore || !WHOLE_STORE_CAPABILITIES.includes(capability),
  );
  const budget = { writesPerDay: MCP_AUTHORITY.writesPerDay };
  return {
    ok: true,
    principal: {
      kind: "delegated",
      id: caller.principal,
      delegator: subject,
      capabilities,
      scopes,
      // Bounds only this request's App→Processor envelope; every call
      // resolves again, so nothing outlives the operator list or the grant.
      notAfter: new Date(now + MCP_AUTHORITY.envelopeMs).toISOString(),
      budget,
      // No clock in it, so a confirm binds to the authority its prepare
      // recorded, and a changed grant or operator list voids the prepare.
      delegationRef: `dlg_${await canonicalDigest({
        v: "kogane-mcp-authority-v1",
        principal: caller.principal,
        delegator: subject,
        capabilities,
        scopes,
        budget,
      })}`,
    },
  };
}
