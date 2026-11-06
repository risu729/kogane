// `GET /api/v2/delegations`: the operator's read of the AI delegations the
// App's `MCP_DELEGATIONS` declares (ADR 0063, amendment of 2026-11-06). Every
// field is a closed code, a bounded identifier or a canonical instant; there
// is no free text, and the validator rejects any key it does not name, so a
// new field is a reviewed contract change rather than a silent widening.
import {
  hasExactKeys,
  isOneOf,
  isRecord,
  isSafeInt,
  isText,
  type Guard,
} from "../../domain/src/guards.ts";
import { parseInstant, validInstantText } from "../../domain/src/time.ts";

export const DELEGATION_STATUS_PATH = "/api/v2/delegations";
export const DELEGATION_STATUS_SCHEMA = "kogane-delegation-status-v1";

/**
 * The wire vocabulary. It mirrors `DELEGATION_CAPABILITIES` and
 * `DELEGATION_ROLES` in `packages/application/src/delegation/contract.ts`; an
 * application test pins the two to the same values.
 */
export const DELEGATION_STATUS_CAPABILITIES = [
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
export const DELEGATION_STATUS_ROLES = ["maintainer", "reviewer", "operator-delegate"] as const;
/** `none`: nothing declared; `misconfigured`: one invalid entry voids the table. */
const DELEGATION_CONFIGURATIONS = ["none", "valid", "misconfigured"] as const;
/** An entry's validity window against `evaluatedAt`: `[issuedAt, notAfter)`. */
const DELEGATION_STATES = ["in_force", "not_yet_valid", "expired"] as const;

export type DelegationScopeView = "*" | string[];
export interface DelegationStatusEntry {
  principal: string;
  delegatedBy: string;
  role: (typeof DELEGATION_STATUS_ROLES)[number];
  /** The role's bundle and the entry's own additions, in vocabulary order. */
  capabilities: (typeof DELEGATION_STATUS_CAPABILITIES)[number][];
  scopes: {
    sources: DelegationScopeView;
    accounts: DelegationScopeView;
    scheduleSources: DelegationScopeView;
  };
  issuedAt: string;
  notAfter: string;
  writesPerDay: number;
  state: (typeof DELEGATION_STATES)[number];
  /** `dlg_` + the entry's canonical digest, as audit records carry it. */
  delegationRef: string;
}
export interface DelegationStatus {
  schemaVersion: typeof DELEGATION_STATUS_SCHEMA;
  evaluatedAt: string;
  configuration: (typeof DELEGATION_CONFIGURATIONS)[number];
  delegations: DelegationStatusEntry[];
}

const MAX_ENTRIES = 8;
const MAX_SCOPE_VALUES = 64;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const REF = /^dlg_[0-9a-f]{64}$/u;

function validScope(value: unknown): value is DelegationScopeView {
  return (
    value === "*" ||
    (Array.isArray(value) &&
      value.length <= MAX_SCOPE_VALUES &&
      value.every((item) => isText(item, 256)) &&
      new Set(value).size === value.length)
  );
}
/** Nanoseconds since the epoch; validated instant text only. */
function instant(text: string): bigint {
  const value = parseInstant(text)!;
  return BigInt(value.epochSeconds) * 1_000_000_000n + BigInt(value.nanoseconds);
}
const capability: Guard<(typeof DELEGATION_STATUS_CAPABILITIES)[number]> = isOneOf(
  DELEGATION_STATUS_CAPABILITIES,
);

function validEntry(value: unknown): value is DelegationStatusEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "principal",
      "delegatedBy",
      "role",
      "capabilities",
      "scopes",
      "issuedAt",
      "notAfter",
      "writesPerDay",
      "state",
      "delegationRef",
    ]) &&
    typeof value.delegatedBy === "string" &&
    SUBJECT.test(value.delegatedBy) &&
    !value.delegatedBy.startsWith("mcp-client:") &&
    value.principal === `mcp-client:${value.delegatedBy}` &&
    isOneOf(DELEGATION_STATUS_ROLES)(value.role) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length > 0 &&
    value.capabilities.every(capability) &&
    // Vocabulary order, no repeats: the server's own normal form.
    value.capabilities.every(
      (item, index, all) =>
        index === 0 ||
        DELEGATION_STATUS_CAPABILITIES.indexOf(all[index - 1] as typeof item) <
          DELEGATION_STATUS_CAPABILITIES.indexOf(item),
    ) &&
    isRecord(value.scopes) &&
    hasExactKeys(value.scopes, ["sources", "accounts", "scheduleSources"]) &&
    validScope(value.scopes.sources) &&
    validScope(value.scopes.accounts) &&
    validScope(value.scopes.scheduleSources) &&
    validInstantText(value.issuedAt) &&
    validInstantText(value.notAfter) &&
    instant(value.issuedAt) < instant(value.notAfter) &&
    isSafeInt(value.writesPerDay, 1, 200) &&
    isOneOf(DELEGATION_STATES)(value.state) &&
    typeof value.delegationRef === "string" &&
    REF.test(value.delegationRef)
  );
}

/** Exact keys throughout; entries only for a valid table, ordered by principal. */
export function validDelegationStatus(value: unknown): value is DelegationStatus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "evaluatedAt", "configuration", "delegations"]) ||
    value.schemaVersion !== DELEGATION_STATUS_SCHEMA ||
    !validInstantText(value.evaluatedAt) ||
    !isOneOf(DELEGATION_CONFIGURATIONS)(value.configuration) ||
    !Array.isArray(value.delegations) ||
    value.delegations.length > MAX_ENTRIES ||
    !value.delegations.every(validEntry)
  )
    return false;
  const now = instant(value.evaluatedAt);
  const principals = value.delegations.map((entry) => entry.principal);
  return (
    (value.configuration === "valid") === principals.length > 0 &&
    principals.every((principal, index) => index === 0 || principals[index - 1]! < principal) &&
    // The state is the window read at `evaluatedAt`, never a second opinion.
    value.delegations.every(
      (entry) =>
        entry.state ===
        (now < instant(entry.issuedAt)
          ? "not_yet_valid"
          : now >= instant(entry.notAfter)
            ? "expired"
            : "in_force"),
    )
  );
}
