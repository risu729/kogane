// Grants: what one principal may ask this application service for.
//
// The grant vocabulary the query services check. Since ADR 0084 no table
// configures grants: every authenticated caller of the agent API holds
// `fullGrant`, and the scope checks below always pass for it. They stay so a
// narrower grant can return without touching every reader. Capabilities are the
// minimal set of addendum 10 section 2 that the MVP gate allows: three read
// capabilities and one proposal capability, plus one maintenance-settings read
// (ADR 0046) that reaches public maintenance windows and nothing else.
// `interpretation.accept`, `calculation.run`, `collection.request`,
// `report.export`, the admin capabilities, every settings write (a maintenance
// revision, a job edit, enable/disable, lease release) and every external
// money action are deliberately absent from this type, so no configuration can
// name them. A maintenance revision is an operation of the authenticated MCP
// principal (`schedules.maintenance.update`, ADR 0063, ADR 0084), never a
// grant here.
//
// A grant is not an authentication decision: the transport authenticates the
// principal (Cloudflare Access) before any grant exists.
import { hasExactKeys, isOneOf, isRecord, isSafeInt, isText } from "../../domain/src/guards.ts";

export const AGENT_CAPABILITIES = [
  /** Aggregates, quality and freshness inside the granted scope. */
  "summary.read",
  /** Structured records inside the granted scope. */
  "records.read",
  /** Scoped common operation history. */
  "audit.read",
  /** Bounded expansion to raw locators; never granted by records.read. */
  "evidence.read",
  /** Immutable relation proposals; never adoption. */
  "interpretation.propose",
  /**
   * Public maintenance windows, schedule timing and reservation state of the
   * sources in `scopes.scheduleSources`. Not a financial read: it never
   * reaches observations, evidence or run links, and no financial capability
   * implies it.
   */
  "schedules.read",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/**
 * `"*"` is every value the store holds; a list is exactly those values. A
 * list is not a display filter: values outside it must not appear in data,
 * coverage, gaps, counts, errors or explanations (SC18).
 */
export type ScopeSet = "*" | readonly string[];

export interface GrantBudget {
  /** Largest number of rows one query may read; a larger request is refused, never truncated. */
  maxRows: number;
  /** Largest number of refs one proposal may name. */
  maxProposalTargets: number;
  /** Largest explanation depth one call may request. */
  maxExplainDepth: number;
}

export interface Grant {
  /** Server-verified principal (Access JWT subject or service-token id). */
  principal: string;
  scopes: {
    sources: ScopeSet;
    accounts: ScopeSet;
    /**
     * Source ids of `config/alarm-jobs.json` whose maintenance settings
     * `schedules.read` reaches, and the outer bound of a delegation's schedule
     * scope (ADR 0063). Separate from `sources`, which scopes financial reads;
     * absent means none.
     */
    scheduleSources?: ScopeSet;
  };
  capabilities: readonly AgentCapability[];
  budget: GrantBudget;
}

/** Bounds a configured grant may not exceed, whatever the deployment writes. */
export const GRANT_LIMITS = {
  maxRows: 1000,
  maxProposalTargets: 50,
  maxExplainDepth: 8,
  maxScopeValues: 64,
} as const;

/** The page size a query gets when it asks for none. */
export const DEFAULT_QUERY_LIMIT = 100;

export function grantAllows(grant: Grant, capability: AgentCapability): boolean {
  return grant.capabilities.includes(capability);
}

function scopeHas(scope: ScopeSet, value: string): boolean {
  return scope === "*" || scope.includes(value);
}

export function grantAllowsSource(grant: Grant, sourceId: string): boolean {
  return scopeHas(grant.scopes.sources, sourceId);
}

/** Whether `schedules.read` reaches this source; an absent scope reaches none. */
export function grantAllowsScheduleSource(grant: Grant, source: string): boolean {
  const scope = grant.scopes.scheduleSources;
  return scope !== undefined && scopeHas(scope, source);
}

export function grantAllowsAccount(grant: Grant, account: string): boolean {
  return scopeHas(grant.scopes.accounts, account);
}

/** A row is in scope only when both its source and its account are. */
export function grantAllowsRow(grant: Grant, sourceId: string, account: string | null): boolean {
  return (
    grantAllowsSource(grant, sourceId) && (account === null || grantAllowsAccount(grant, account))
  );
}

/**
 * The source ids a query must read, or `null` when the grant covers every
 * source and the reader may run one unfiltered query. A list grant is read
 * one source at a time, so no query can observe a row outside the grant.
 */
export function grantedSources(grant: Grant): readonly string[] | null {
  return grant.scopes.sources === "*" ? null : [...grant.scopes.sources].sort();
}

/** The perimeter a context pins for this grant; stable for the same scope. */
export function perimeterRefFor(grant: Grant): string {
  const sources = grant.scopes.sources === "*" ? "*" : [...grant.scopes.sources].sort().join(",");
  const accounts =
    grant.scopes.accounts === "*" ? "*" : [...grant.scopes.accounts].sort().join(",");
  const ref = `perimeter:sources=${sources};accounts=${accounts}`;
  return ref.length <= 512
    ? ref
    : `perimeter:scope-set-of-${String(sources.length + accounts.length)}-chars`;
}

function validScopeSet(value: unknown): value is ScopeSet {
  if (value === "*") return true;
  return (
    Array.isArray(value) &&
    value.length <= GRANT_LIMITS.maxScopeValues &&
    value.every((item) => isText(item, 256)) &&
    new Set(value).size === value.length
  );
}

export function validGrant(value: unknown): value is Grant {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["principal", "scopes", "capabilities", "budget"]) ||
    !isText(value.principal, 256) ||
    !isRecord(value.scopes) ||
    !hasExactKeys(value.scopes, ["sources", "accounts"], ["scheduleSources"]) ||
    !validScopeSet(value.scopes.sources) ||
    !validScopeSet(value.scopes.accounts) ||
    (value.scopes.scheduleSources !== undefined && !validScopeSet(value.scopes.scheduleSources)) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > AGENT_CAPABILITIES.length ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    !value.capabilities.every(isOneOf(AGENT_CAPABILITIES)) ||
    !isRecord(value.budget) ||
    !hasExactKeys(value.budget, ["maxRows", "maxProposalTargets", "maxExplainDepth"])
  )
    return false;
  return (
    isSafeInt(value.budget.maxRows, 1, GRANT_LIMITS.maxRows) &&
    isSafeInt(value.budget.maxProposalTargets, 1, GRANT_LIMITS.maxProposalTargets) &&
    isSafeInt(value.budget.maxExplainDepth, 1, GRANT_LIMITS.maxExplainDepth)
  );
}

/**
 * ADR 0084: there is no grant table. Every caller the transport authenticated
 * (Cloudflare Access) holds every capability over the whole store, bounded only
 * by the fixed per-call limits above, which keep one call bounded and are not
 * authority.
 */
export function fullGrant(principal: string): Grant {
  return {
    principal,
    scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
    capabilities: AGENT_CAPABILITIES,
    budget: {
      maxRows: GRANT_LIMITS.maxRows,
      maxProposalTargets: GRANT_LIMITS.maxProposalTargets,
      maxExplainDepth: GRANT_LIMITS.maxExplainDepth,
    },
  };
}
