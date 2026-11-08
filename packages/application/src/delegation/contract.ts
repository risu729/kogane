// ADR 0063's operation vocabulary and the MCP principal ADR 0084 derives.
// Resolving a principal executes nothing: execution goes through
// `execution.ts` and the adapters each transport installs (`readiness.ts`).
import type { ScopeSet } from "../grants.ts";

/**
 * The change-kind families (a kind's prefix before its first dot) an MCP
 * client may plan, approve and commit. The one list every gate reads: the
 * App's `kogane.command.approve`/`.commit` capability, the delegated
 * execution envelope's `commandFamilies`, and the Processor's command route
 * all derive from it, so a family is decidable everywhere or nowhere.
 */
export const DECISION_FAMILIES = ["card-settlement", "relation", "identity"] as const;
export type DecisionFamily = (typeof DECISION_FAMILIES)[number];
export type DecisionCapability = `commands.decide.${DecisionFamily}`;
export function decisionCapability(family: DecisionFamily): DecisionCapability {
  return `commands.decide.${family}`;
}
/** `commands.decide.<family>` for every decision family, in `DECISION_FAMILIES` order. */
export const DECISION_CAPABILITIES: readonly DecisionCapability[] =
  DECISION_FAMILIES.map(decisionCapability);
/** The decision family of a change kind, or `null` when no MCP client may decide it. */
export function decisionFamilyOf(kind: string): DecisionFamily | null {
  const family = kind.split(".", 1)[0] ?? "";
  return (DECISION_FAMILIES as readonly string[]).includes(family)
    ? (family as DecisionFamily)
    : null;
}

export const DELEGATION_CAPABILITIES = [
  "commands.plan",
  ...DECISION_CAPABILITIES,
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
/**
 * ADR 0084: nothing is declared. A verified MCP client holds every operation
 * capability over the whole store, under this fixed rolling-day write budget
 * (a runaway guard, not authority); its App→Processor envelope is valid for
 * one request's lifetime.
 */
export const MCP_AUTHORITY = {
  writesPerDay: 200,
  envelopeMs: 600_000,
} as const;

export interface DelegationScopes {
  sources: ScopeSet;
  accounts: ScopeSet;
  scheduleSources: ScopeSet;
}
export interface DelegatedPrincipal {
  kind: "delegated";
  id: string;
  delegator: string;
  capabilities: readonly DelegationCapability[];
  scopes: DelegationScopes;
  notAfter: string;
  delegationRef: string;
  budget: { writesPerDay: number };
}
export type DelegationCaller =
  | { readonly kind: "mcp-client"; readonly principal: string }
  | { readonly kind: "browser"; readonly principal: string };
export type DelegationRefusal =
  /** Not a verified MCP client (a browser session, the HTTP agent route). */
  | "delegation_not_mcp_client"
  /** Kept for the adapters' closed vocabulary; ADR 0084 no longer produces it. */
  | "delegation_not_configured"
  /** The server clock could not be read: 503. */
  | "delegation_misconfigured";
export type DelegationResolution =
  | { ok: true; principal: DelegatedPrincipal }
  | { ok: false; code: DelegationRefusal };
