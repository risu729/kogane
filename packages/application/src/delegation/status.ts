// The operator's view of the delegation table (ADR 0063, amendment of
// 2026-11-06). It reads the same configuration through the same all-or-nothing
// parser the resolver uses, so a table the resolver refuses is shown as
// `misconfigured` with no entry, never as a partial list: the page cannot show
// a delegation that no call would honour. Nothing here grants, resolves a
// caller or reaches a writer; it is read for display only.
import { canonicalDigest } from "../../../domain/src/context.ts";
import {
  DELEGATION_STATUS_SCHEMA,
  type DelegationStatus,
  type DelegationStatusEntry,
} from "../../../observation-shared/src/delegation-status-contract.ts";
import { effectiveDelegationCapabilities, type DelegationReadGrant } from "./contract.ts";
import { instantNanoseconds, parseDelegations } from "./parse.ts";

const copy = <T>(scope: "*" | readonly T[]): "*" | T[] => (scope === "*" ? "*" : [...scope]);

export async function delegationStatus(input: {
  configured: string | undefined | null;
  operatorSubjects: string | undefined | null;
  readGrants: ReadonlyMap<string, DelegationReadGrant>;
  /** A canonical instant from the server's clock, never a request value. */
  now: string;
}): Promise<DelegationStatus> {
  const view = (
    configuration: DelegationStatus["configuration"],
    delegations: DelegationStatusEntry[] = [],
  ): DelegationStatus => ({
    schemaVersion: DELEGATION_STATUS_SCHEMA,
    evaluatedAt: input.now,
    configuration,
    delegations,
  });
  const now = instantNanoseconds(input.now);
  if (now === null) throw new TypeError("delegation status needs a canonical instant");
  const table = parseDelegations(input.configured, input.operatorSubjects, input.readGrants);
  if (!table.ok) return view("misconfigured");
  if (table.entries.size === 0) return view("none");
  const principals = [...table.entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const delegations: DelegationStatusEntry[] = [];
  for (const principal of principals) {
    const entry = table.entries.get(principal)!;
    delegations.push({
      principal,
      delegatedBy: entry.delegatedBy,
      role: entry.role,
      capabilities: [...effectiveDelegationCapabilities(entry)],
      scopes: {
        sources: copy(entry.scopes.sources),
        accounts: copy(entry.scopes.accounts),
        scheduleSources: copy(entry.scopes.scheduleSources),
      },
      issuedAt: entry.issuedAt,
      notAfter: entry.notAfter,
      writesPerDay: entry.budget.writesPerDay,
      // The resolver's own window, `[issuedAt, notAfter)`.
      state:
        now < instantNanoseconds(entry.issuedAt)!
          ? "not_yet_valid"
          : now >= instantNanoseconds(entry.notAfter)!
            ? "expired"
            : "in_force",
      // The same reference `resolveDelegation` gives and audit records carry.
      delegationRef: `dlg_${await canonicalDigest(entry)}`,
    });
  }
  return view("valid", delegations);
}
