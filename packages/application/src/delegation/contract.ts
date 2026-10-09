// ADR 0063's declarations, not an execution grant. The core slice does not
// connect a delegated principal to any command, writer or transport gate.
import type { ScopeSet } from "../grants.ts";

export const DELEGATION_CAPABILITIES = [
  "commands.plan",
  "commands.decide.card-settlement",
  "commands.decide.relation",
  "commands.decide.identity",
  "schedules.maintenance.update",
  "schedules.survey.decide",
  "schedules.job.update",
  "operations.import.request",
  "operations.replay.request",
  "operations.projection.request",
  "operations.collection.request",
  "operations.session.refresh",
  "operations.read",
] as const;
export type DelegationCapability = (typeof DELEGATION_CAPABILITIES)[number];
export const DELEGATION_ROLES = ["maintainer", "reviewer", "operator-delegate"] as const;
export type DelegationRole = (typeof DELEGATION_ROLES)[number];
export const DELEGATION_ROLE_CAPABILITIES: Readonly<
  Record<DelegationRole, readonly DelegationCapability[]>
> = {
  maintainer: [
    "schedules.maintenance.update",
    "schedules.survey.decide",
    "operations.import.request",
    "operations.replay.request",
    "operations.read",
  ],
  reviewer: ["commands.plan", "commands.decide.card-settlement", "commands.decide.relation"],
  "operator-delegate": DELEGATION_CAPABILITIES,
};
export const DELEGATION_LIMITS = {
  entries: 8,
  lifetimeMs: 90 * 86_400_000,
  writesPerDay: 200,
} as const;

export interface DelegationScopes {
  sources: ScopeSet;
  accounts: ScopeSet;
  scheduleSources: ScopeSet;
}
/** Existing read authority; a missing schedule axis means no schedule scope. */
export interface DelegationReadGrant {
  principal: string;
  scopes: { sources: ScopeSet; accounts: ScopeSet; scheduleSources?: ScopeSet };
}
export interface DelegationEntry {
  delegatedBy: string;
  role: DelegationRole;
  capabilities?: readonly DelegationCapability[];
  scopes: DelegationScopes;
  issuedAt: string;
  notAfter: string;
  budget: { writesPerDay: number };
}
export interface DelegatedPrincipal {
  kind: "delegated";
  id: string;
  delegator: string;
  capabilities: readonly DelegationCapability[];
  scopes: DelegationScopes;
  notAfter: string;
  delegationRef: string;
}
export type DelegationCaller =
  | { readonly kind: "mcp-client"; readonly principal: string }
  | { readonly kind: "browser"; readonly principal: string };
export type DelegationRefusal =
  | "delegation_not_mcp_client"
  | "delegation_not_configured"
  | "delegation_misconfigured"
  | "delegation_not_yet_valid"
  | "delegation_expired";
export type DelegationResolution =
  | { ok: true; principal: DelegatedPrincipal }
  | { ok: false; code: DelegationRefusal };
export type DelegationTable =
  | { ok: true; entries: ReadonlyMap<string, DelegationEntry> }
  | { ok: false; code: "delegation_misconfigured" };

export function effectiveDelegationCapabilities(
  entry: DelegationEntry,
): readonly DelegationCapability[] {
  const effective = new Set([
    ...DELEGATION_ROLE_CAPABILITIES[entry.role],
    ...(entry.capabilities ?? []),
  ]);
  return DELEGATION_CAPABILITIES.filter((capability) => effective.has(capability));
}
