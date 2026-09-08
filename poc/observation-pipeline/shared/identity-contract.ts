export type IdentityStatus = "identified" | "provider-local" | "aggregate" | "unresolved";
export type IdentityOrigin = {
  kind: "transaction" | "balance" | "position" | "valuation";
  id: number;
};
export interface IdentityAccountRow {
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
export function validIdentityResponse(path: string, value: unknown): boolean {
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
      [...fields, "referenceId", "targetId", "label", "reason"].every(
        (k) => typeof row[k] === "string",
      ) &&
      ["identified", "provider-local", "aggregate", "unresolved"].includes(String(row.status)) &&
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
