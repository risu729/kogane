// Configuration only: never read an actor or delegation from request content.
import { hasExactKeys, isOneOf, isRecord, isSafeInt, isText } from "../../../domain/src/guards.ts";
import { parseInstant, validInstantText } from "../../../domain/src/time.ts";
import { ACTOR_PATTERN, parseSubjectList } from "../command/grants.ts";
import { GRANT_LIMITS, type ScopeSet } from "../grants.ts";
import {
  DELEGATION_CAPABILITIES,
  DELEGATION_LIMITS,
  DELEGATION_ROLES,
  effectiveDelegationCapabilities,
  type DelegationEntry,
  type DelegationReadGrant,
  type DelegationTable,
} from "./contract.ts";

const REQUIRED_KEYS = ["delegatedBy", "role", "scopes", "issuedAt", "notAfter", "budget"] as const;
const misconfigured = (): DelegationTable => ({ ok: false, code: "delegation_misconfigured" });

/** Reuse role-typed time; Date.parse would silently truncate nanosecond bounds. */
export function instantNanoseconds(text: string): bigint | null {
  const value = parseInstant(text);
  return value === null
    ? null
    : BigInt(value.epochSeconds) * 1_000_000_000n + BigInt(value.nanoseconds);
}

function validScope(value: unknown): value is ScopeSet {
  return (
    value === "*" ||
    (Array.isArray(value) &&
      value.length <= GRANT_LIMITS.maxScopeValues &&
      value.every((item) => isText(item, 256)) &&
      new Set(value).size === value.length)
  );
}
function within(scope: ScopeSet, read: ScopeSet): boolean {
  return read === "*" || (scope !== "*" && scope.every((value) => read.includes(value)));
}
function validEntry(value: unknown): value is DelegationEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, REQUIRED_KEYS, ["capabilities"]) ||
    !isText(value.delegatedBy, 128) ||
    !ACTOR_PATTERN.test(value.delegatedBy) ||
    value.delegatedBy.startsWith("mcp-client:") ||
    !isOneOf(DELEGATION_ROLES)(value.role) ||
    !isRecord(value.scopes) ||
    !hasExactKeys(value.scopes, ["sources", "accounts", "scheduleSources"]) ||
    !validScope(value.scopes.sources) ||
    !validScope(value.scopes.accounts) ||
    !validScope(value.scopes.scheduleSources) ||
    !validInstantText(value.issuedAt) ||
    !validInstantText(value.notAfter) ||
    !isRecord(value.budget) ||
    !hasExactKeys(value.budget, ["writesPerDay"]) ||
    !isSafeInt(value.budget.writesPerDay, 1, DELEGATION_LIMITS.writesPerDay)
  )
    return false;
  if (
    Object.hasOwn(value, "capabilities") &&
    (!Array.isArray(value.capabilities) ||
      value.capabilities.length > DELEGATION_CAPABILITIES.length ||
      !value.capabilities.every(isOneOf(DELEGATION_CAPABILITIES)) ||
      new Set(value.capabilities).size !== value.capabilities.length)
  )
    return false;
  const lifetime = instantNanoseconds(value.notAfter)! - instantNanoseconds(value.issuedAt)!;
  return lifetime > 0n && lifetime <= BigInt(DELEGATION_LIMITS.lifetimeMs) * 1_000_000n;
}

/** All-or-nothing, including revoked delegators and narrowed read grants. */
export function parseDelegations(
  configured: string | undefined | null,
  operatorSubjects: string | undefined | null,
  readGrants: ReadonlyMap<string, DelegationReadGrant>,
): DelegationTable {
  if (
    configured === undefined ||
    configured === "" ||
    (typeof configured === "string" && configured.trim() === "")
  )
    return { ok: true, entries: new Map() };
  if (typeof configured !== "string") return misconfigured();
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    return misconfigured();
  }
  if (!isRecord(parsed)) return misconfigured();
  const entries = Object.entries(parsed);
  if (entries.length > DELEGATION_LIMITS.entries) return misconfigured();
  // Empty configuration remains inert even if another, unrelated list is bad.
  if (entries.length === 0) return { ok: true, entries: new Map() };
  const operators = parseSubjectList(operatorSubjects);
  if (operators === null) return misconfigured();
  const table = new Map<string, DelegationEntry>();
  for (const [principal, value] of entries) {
    if (
      !validEntry(value) ||
      principal !== `mcp-client:${value.delegatedBy}` ||
      !operators.includes(value.delegatedBy)
    )
      return misconfigured();
    const grant = readGrants.get(principal);
    if (
      !grant ||
      grant.principal !== principal ||
      !within(value.scopes.sources, grant.scopes.sources) ||
      !within(value.scopes.accounts, grant.scopes.accounts) ||
      !within(value.scopes.scheduleSources, grant.scopes.scheduleSources ?? [])
    )
      return misconfigured();
    const capabilities = effectiveDelegationCapabilities(value);
    if (
      capabilities.some(
        (capability) =>
          capability.startsWith("commands.") || capability === "operations.projection.request",
      ) &&
      (value.scopes.sources !== "*" || value.scopes.accounts !== "*")
    )
      return misconfigured();
    table.set(principal, value);
  }
  return { ok: true, entries: table };
}
