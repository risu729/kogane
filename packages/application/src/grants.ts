// Grants: what one principal may ask this application service for.
//
// Deny by default. A principal with no grant has no capability and no scope,
// and every entry point refuses before it reads anything. Capabilities are the
// minimal set of addendum 10 section 2 that the MVP gate allows: three read
// capabilities and one proposal capability. `interpretation.accept`,
// `calculation.run`, `collection.request`, `report.export`, the admin
// capabilities and every external money action are deliberately absent from
// this type, so no configuration can name them.
//
// A grant is not an authentication decision. The transport authenticates the
// principal (Cloudflare Access) and then looks its grant up here; a valid
// token with no grant is still refused.
import { hasExactKeys, isOneOf, isRecord, isSafeInt, isText } from "../../domain/src/guards.ts";

export const AGENT_CAPABILITIES = [
  /** Aggregates, quality and freshness inside the granted scope. */
  "summary.read",
  /** Structured records inside the granted scope. */
  "records.read",
  /** Bounded expansion to raw locators; never granted by records.read. */
  "evidence.read",
  /** Immutable relation proposals; never adoption. */
  "interpretation.propose",
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
  scopes: { sources: ScopeSet; accounts: ScopeSet };
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
    !hasExactKeys(value.scopes, ["sources", "accounts"]) ||
    !validScopeSet(value.scopes.sources) ||
    !validScopeSet(value.scopes.accounts) ||
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
 * Read the deployment's grant table. Anything unreadable, unparsable or
 * outside the bounds above yields an empty table: the agent API is then off,
 * which is the configured default (`AGENT_API_GRANTS` absent).
 *
 * The parsed text is configuration written by the operator, never a request
 * body, and it never names a capability outside `AGENT_CAPABILITIES`.
 */
export function parseGrants(configured: string | undefined | null): Map<string, Grant> {
  const table = new Map<string, Grant>();
  if (typeof configured !== "string" || configured.trim() === "") return table;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    return table;
  }
  if (!isRecord(parsed)) return table;
  const entries = Object.entries(parsed);
  if (entries.length > 64) return table;
  for (const [principal, body] of entries) {
    if (!isText(principal, 256) || !isRecord(body)) return new Map();
    const grant = { principal, ...body };
    if (!validGrant(grant)) return new Map();
    table.set(principal, grant);
  }
  return table;
}

/** The grant of an authenticated principal, or null when it has none. */
export function grantFor(table: ReadonlyMap<string, Grant>, principal: string): Grant | null {
  return table.get(principal) ?? null;
}
