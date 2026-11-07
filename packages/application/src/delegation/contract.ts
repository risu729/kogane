// ADR 0063's operation vocabulary and the MCP principal ADR 0084 derives.
// Resolving a principal executes nothing: execution goes through
// `execution.ts` and the adapters each transport installs (`readiness.ts`).
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
