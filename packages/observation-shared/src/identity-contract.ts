import { validAccountConnection, type AccountConnection } from "./account-connection-contract";
export type IdentityStatus = "identified" | "provider-local" | "aggregate" | "unresolved";
export type IdentityOrigin = {
  kind: "transaction" | "balance" | "position" | "valuation";
  id: number;
};
export interface IdentityAccountRow {
  connection?: AccountConnection;
  referenceId: string;
  targetId: string;
  label: string;
  role: string;
  status: IdentityStatus;
  source: string;
  reference: string;
  reason: string;
  revision: number;
  observedCount: number;
  origin: IdentityOrigin;
}
export interface IdentityInstrumentRow {
  referenceId: string;
  targetId: string;
  label: string;
  kind: string;
  status: IdentityStatus;
  source: string;
  namespace: string;
  scope: string;
  value: string;
  reason: string;
  revision: number;
  observedCount: number;
  origin: IdentityOrigin;
}
export interface IdentityCoverageRow {
  source: string;
  eligible: number;
  organized: number;
  identified: number;
  providerLocal: number;
  aggregate: number;
  unresolved: number;
}
export interface IdentityPage<T> {
  rows: T[];
  coverage: { limit: number; nextOffset: number | null; truncated: boolean };
}
export type IdentityCoverage = IdentityPage<IdentityCoverageRow>;
export const IDENTITY_PAGE_LIMIT = 100;
/**
 * The connection state of an account entity in the account list: the one
 * state of the connections its references show (`confirmed`, `unresolved`,
 * `evidence-ineligible`), `mixed` when they show several, `not-reviewed` for
 * an aggregator entity no current review names (its institution is not
 * recorded), and null for an entity no connection concerns.
 */
const ACCOUNT_LIST_CONNECTIONS = [
  "confirmed",
  "unresolved",
  "evidence-ineligible",
  "mixed",
  "not-reviewed",
] as const;
export type AccountListConnection = (typeof ACCOUNT_LIST_CONNECTIONS)[number];
/** One account entity of the account list (ADR 0077 amendment 2026-11-19). */
export interface AccountListRow {
  /** The account entity id (`targetId` of the rows that use it). */
  account: string;
  label: string;
  /** The entity's role, as the identity rule recorded it. */
  kind: string;
  /** The sources of its current references, sorted. */
  sources: string[];
  /** Its references' current mapping status, or `mixed` when they differ. */
  mapping: IdentityStatus | "mixed";
  connection: AccountListConnection | null;
  /** The newest capture time (UTC, to the second) of its current published observations. */
  lastObservedAt: string | null;
}
export interface AccountListPage {
  rows: AccountListRow[];
  coverage: { limit: number; total: number; nextOffset: number | null; truncated: boolean };
}
/** Entities one account list page holds at most. */
export const ACCOUNT_LIST_PAGE_SIZE = 50;
/** The bound on one account list answer as UTF-8 JSON; a page closes early to stay within it. */
export const ACCOUNT_LIST_BYTE_BUDGET = 8_000;
const IDENTITY_STATUSES = ["identified", "provider-local", "aggregate", "unresolved"];
const ACCOUNT_LIST_PATH = "/api/identity/account-list";
export function nextIdentityOffset(offset: number, hasMore: boolean): number | null {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("invalid_offset");
  if (!hasMore) return null;
  const next = offset + IDENTITY_PAGE_LIMIT;
  if (!Number.isSafeInteger(next)) throw new RangeError("pagination_offset_overflow");
  return next;
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function validAccountListPage(value: unknown): boolean {
  if (!object(value) || !Array.isArray(value.rows) || !object(value.coverage)) return false;
  const { coverage } = value;
  if (
    value.rows.length > ACCOUNT_LIST_PAGE_SIZE ||
    coverage.limit !== ACCOUNT_LIST_PAGE_SIZE ||
    !count(coverage.total) ||
    typeof coverage.truncated !== "boolean" ||
    !(coverage.nextOffset === null || count(coverage.nextOffset)) ||
    coverage.truncated !== (coverage.nextOffset !== null)
  )
    return false;
  return value.rows.every(
    (row) =>
      object(row) &&
      typeof row.account === "string" &&
      typeof row.label === "string" &&
      typeof row.kind === "string" &&
      Array.isArray(row.sources) &&
      row.sources.length > 0 &&
      row.sources.every((source) => typeof source === "string") &&
      [...IDENTITY_STATUSES, "mixed"].includes(String(row.mapping)) &&
      (row.connection === null ||
        (ACCOUNT_LIST_CONNECTIONS as readonly string[]).includes(String(row.connection))) &&
      (row.lastObservedAt === null ||
        (typeof row.lastObservedAt === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(row.lastObservedAt))),
  );
}
export function validIdentityResponse(path: string, value: unknown): boolean {
  if (path === ACCOUNT_LIST_PATH) return validAccountListPage(value);
  if (path === "/api/identity/connections")
    return (
      object(value) &&
      Array.isArray(value.connections) &&
      value.connections.length <= 64 &&
      value.connections.every(validAccountConnection)
    );
  if (
    !["/api/identity/accounts", "/api/identity/instruments", "/api/identity/coverage"].includes(
      path,
    )
  )
    return false;
  if (
    !object(value) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 100 ||
    !object(value.coverage)
  )
    return false;
  if (
    value.coverage.limit !== 100 ||
    typeof value.coverage.truncated !== "boolean" ||
    !(value.coverage.nextOffset === null || count(value.coverage.nextOffset))
  )
    return false;
  return value.rows.every((row) => {
    if (!object(row) || typeof row.source !== "string") return false;
    if (path === "/api/identity/coverage") {
      if (
        !["eligible", "organized", "identified", "providerLocal", "aggregate", "unresolved"].every(
          (k) => count(row[k]),
        )
      )
        return false;
      const counts = row as unknown as IdentityCoverageRow;
      const total = counts.identified + counts.providerLocal + counts.aggregate + counts.unresolved;
      return (
        counts.organized <= counts.eligible &&
        Number.isSafeInteger(total) &&
        total === counts.organized
      );
    }
    const fields =
      path === "/api/identity/accounts"
        ? ["reference", "role"]
        : path === "/api/identity/instruments"
          ? ["kind", "namespace", "scope", "value"]
          : null;
    return (
      fields !== null &&
      (path !== "/api/identity/accounts" ||
        row.connection === undefined ||
        validAccountConnection(row.connection)) &&
      [...fields, "referenceId", "targetId", "label", "reason"].every(
        (k) => typeof row[k] === "string",
      ) &&
      IDENTITY_STATUSES.includes(String(row.status)) &&
      count(row.revision) &&
      row.revision > 0 &&
      count(row.observedCount) &&
      object(row.origin) &&
      ["transaction", "balance", "position", "valuation"].includes(String(row.origin.kind)) &&
      count(row.origin.id) &&
      row.origin.id > 0
    );
  });
}
