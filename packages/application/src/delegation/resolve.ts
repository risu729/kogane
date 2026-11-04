import { canonicalDigest } from "../../../domain/src/context.ts";
import {
  effectiveDelegationCapabilities,
  type DelegationCaller,
  type DelegationReadGrant,
  type DelegationResolution,
} from "./contract.ts";
import { instantNanoseconds, parseDelegations } from "./parse.ts";

/** The adapter must pass the verified caller, never a claimed body/header. */
export async function resolveDelegation(input: {
  configured: string | undefined | null;
  operatorSubjects: string | undefined | null;
  readGrants: ReadonlyMap<string, DelegationReadGrant>;
  caller: DelegationCaller;
  now: string;
}): Promise<DelegationResolution> {
  if (input.caller.kind !== "mcp-client") return { ok: false, code: "delegation_not_mcp_client" };
  const table = parseDelegations(input.configured, input.operatorSubjects, input.readGrants);
  if (!table.ok) return table;
  const entry = table.entries.get(input.caller.principal);
  if (!entry) return { ok: false, code: "delegation_not_configured" };
  const now = instantNanoseconds(input.now);
  if (now === null) return { ok: false, code: "delegation_misconfigured" };
  if (now < instantNanoseconds(entry.issuedAt)!)
    return { ok: false, code: "delegation_not_yet_valid" };
  if (now >= instantNanoseconds(entry.notAfter)!) return { ok: false, code: "delegation_expired" };
  return {
    ok: true,
    principal: {
      kind: "delegated",
      id: input.caller.principal,
      delegator: entry.delegatedBy,
      capabilities: effectiveDelegationCapabilities(entry),
      scopes: entry.scopes,
      notAfter: entry.notAfter,
      budget: entry.budget,
      delegationRef: `dlg_${await canonicalDigest(entry)}`,
    },
  };
}
