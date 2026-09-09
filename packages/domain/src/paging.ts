// The snapshot page envelope of review 06 (D10) and its cursor contract.
//
// Two things the current `coverage.truncated` cannot say apart are separated
// here: "this page is not the last page" (`page.hasMore`) and "the underlying
// data is incomplete" (`dataCoverage`). A response limit is never evidence
// about a portfolio.
//
// The cursor binds the snapshot, the filter set, the sort key and an opaque
// tie-break position. It carries no account label, no provider metric and no
// amount, and it is never an authorisation: every continuation request is
// authenticated and re-scoped by the caller.
import {
  hasExactKeys,
  isArrayOf,
  isOneOf,
  isRecord,
  isSafeInt,
  isText,
  isTextOrNull,
} from "./guards.ts";
import { validNormalizedDecimal } from "../../../packages/observation-shared/src/normalized-decimal.ts";
import type { NormalizedDecimal } from "../../../packages/observation-shared/src/normalized-decimal.ts";

export const KEYSET_PAGINATION_VERSION = "keyset-v2";
export const SNAPSHOT_PAGE_SCHEMA_VERSION = "snapshot-page-v1";

export const PAGE_COMPLETENESS = ["complete", "partial", "unknown"] as const;
export type PageCompleteness = (typeof PAGE_COMPLETENESS)[number];

export interface PageInfo {
  limit: number;
  hasMore: boolean;
  /** Opaque; only this server decodes it. Null on the last page. */
  nextCursor: string | null;
  snapshotId: string;
  paginationVersion: typeof KEYSET_PAGINATION_VERSION;
}

/** Completeness of the data behind the page, never of the page itself. */
export interface PageDataCoverage {
  completeness: PageCompleteness;
  stale: boolean;
  /** Machine-readable reason codes; no free text, no provider values. */
  reasons: string[];
}

export interface SnapshotPage<T> {
  schemaVersion: typeof SNAPSHOT_PAGE_SCHEMA_VERSION;
  items: T[];
  page: PageInfo;
  dataCoverage: PageDataCoverage;
}

export function validPageInfo(value: unknown): value is PageInfo {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["limit", "hasMore", "nextCursor", "snapshotId", "paginationVersion"]) &&
    isSafeInt(value.limit, 1, 1000) &&
    typeof value.hasMore === "boolean" &&
    isTextOrNull(value.nextCursor, 2048) &&
    isText(value.snapshotId, 128) &&
    value.paginationVersion === KEYSET_PAGINATION_VERSION
  );
}

export function validPageDataCoverage(value: unknown): value is PageDataCoverage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["completeness", "stale", "reasons"]) &&
    isOneOf(PAGE_COMPLETENESS)(value.completeness) &&
    typeof value.stale === "boolean" &&
    isArrayOf((item): item is string => isText(item, 128), 200)(value.reasons)
  );
}

export function validSnapshotPage<T>(
  value: unknown,
  item: (candidate: unknown) => candidate is T,
): value is SnapshotPage<T> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schemaVersion", "items", "page", "dataCoverage"]) &&
    value.schemaVersion === SNAPSHOT_PAGE_SCHEMA_VERSION &&
    Array.isArray(value.items) &&
    value.items.length <= 1000 &&
    value.items.every(item) &&
    validPageInfo(value.page) &&
    validPageDataCoverage(value.dataCoverage)
  );
}

// ── the quantity a read model hands to a caller ──────────────────────────
//
// Root review 07 section 3. `normalized` is the only input a calculation may
// use, and only when its status is `exact`. The legacy provider columns are
// kept as evidence under `sourceRepresentation`, where their names say they
// are the source's own representation and not a second numeric contract; an
// unknown minor-unit exponent stays null rather than being guessed.
export interface ObservedQuantity {
  normalized: NormalizedDecimal;
  unitReference: string | null;
  sourceRepresentation: {
    amountText: string | null;
    legacyMinorUnits: string | null;
    legacyMinorUnitExponent: number | null;
  };
}

export function validObservedQuantity(value: unknown): value is ObservedQuantity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["normalized", "unitReference", "sourceRepresentation"]) ||
    !validNormalizedDecimal(value.normalized) ||
    !isTextOrNull(value.unitReference, 128) ||
    !isRecord(value.sourceRepresentation)
  )
    return false;
  const source = value.sourceRepresentation;
  return (
    hasExactKeys(source, ["amountText", "legacyMinorUnits", "legacyMinorUnitExponent"]) &&
    isTextOrNull(source.amountText, 512) &&
    (source.legacyMinorUnits === null ||
      (isText(source.legacyMinorUnits, 4096) && /^-?\d+$/u.test(source.legacyMinorUnits))) &&
    (source.legacyMinorUnitExponent === null || isSafeInt(source.legacyMinorUnitExponent, 0, 30))
  );
}

// ── cursor ───────────────────────────────────────────────────────────────

export const CURSOR_VERSION = "keyset-cursor-v1";

export interface KeysetCursor {
  v: typeof CURSOR_VERSION;
  /** The snapshot the page was read from; a different one is a mismatch. */
  s: string;
  /** Digest of the resolved filter set and sort; a different one is a mismatch. */
  f: string;
  /** Last sort key value of the previous page (opaque ordering key). */
  k: string;
  /** Opaque, order-compatible tie-break position; never a business identifier. */
  t: number;
}

export const CURSOR_REJECTIONS = ["cursor_invalid", "cursor_mismatch", "context_expired"] as const;
export type CursorRejection = (typeof CURSOR_REJECTIONS)[number];

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(text)) return null;
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Encoding is base64url of a fixed JSON shape, not a signature. Nothing in a
 * cursor is trusted: the snapshot id and the filter digest are compared
 * against the request the server itself resolved, so a forged or replayed
 * cursor can only be rejected, never widen a scope.
 */
export function encodeKeysetCursor(cursor: Omit<KeysetCursor, "v">): string {
  const value: KeysetCursor = { v: CURSOR_VERSION, ...cursor };
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeKeysetCursor(text: string): KeysetCursor | null {
  const bytes = base64urlDecode(text);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["v", "s", "f", "k", "t"]) ||
    parsed.v !== CURSOR_VERSION ||
    !isText(parsed.s, 128) ||
    !isText(parsed.f, 128) ||
    typeof parsed.k !== "string" ||
    parsed.k.length > 256 ||
    !isSafeInt(parsed.t, 0, 2_000_000_000)
  )
    return null;
  return parsed as unknown as KeysetCursor;
}

/**
 * Continuation check. `cursor_mismatch` and `context_expired` are different
 * answers: the first says the cursor belongs to another query (a changed
 * filter, or a snapshot the request explicitly pinned to something else), the
 * second says the fixed snapshot no longer exists and reading must start
 * again. Neither ever silently falls back to the newest snapshot.
 *
 * `requestedSnapshotId` is the snapshot the request pinned, when it pinned
 * one; without a pin the cursor's own snapshot is what the page is served
 * from, which is what keeps membership fixed across pages.
 */
export function checkKeysetCursor(
  cursor: KeysetCursor,
  expected: {
    filterDigest: string;
    requestedSnapshotId?: string | null;
    /** Whether the cursor's snapshot is still readable (present and complete). */
    snapshotReadable: boolean;
  },
): CursorRejection | null {
  if (cursor.f !== expected.filterDigest) return "cursor_mismatch";
  if (
    expected.requestedSnapshotId !== undefined &&
    expected.requestedSnapshotId !== null &&
    expected.requestedSnapshotId !== cursor.s
  )
    return "cursor_mismatch";
  if (!expected.snapshotReadable) return "context_expired";
  return null;
}
