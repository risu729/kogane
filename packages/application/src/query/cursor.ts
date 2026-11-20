// A cursor is bound to its context and to the digest of its query spec
// (addendum 06 section 7). Reusing one query's cursor on another account
// condition, or on a context opened from a different published set, is
// refused rather than silently answered from the newest data. The context
// part is its paging basis: every pinned input except the evaluation clock,
// which every request sets anew (ADR 0091).
//
// The value is opaque to callers: base64url of the canonical JSON of the
// three fields below. It carries no scope, so a cursor is not a way to read
// outside a grant, and it is never a database offset a caller can invent —
// a decoded cursor whose digest does not match this request is rejected.
import { canonicalJson } from "../../../domain/src/context.ts";
import { hasExactKeys, isRecord, isSafeInt, isText } from "../../../domain/src/guards.ts";

export interface CursorPayload {
  /** `OpenedContext.pagingBasisRef` of the context that issued the cursor. */
  basisRef: string;
  queryDigest: string;
  offset: number;
}

const MAX_OFFSET = 1_000_000;

/** The canonical JSON of `payload` as unpadded base64url: the form of every cursor here. */
export function encodeCursorJson(payload: unknown): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(canonicalJson(payload)))
    binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** The JSON value of an unpadded base64url cursor, or null for anything else. */
export function decodeCursorJson(text: string, maxLength: number): unknown {
  if (text.length > maxLength || !/^[A-Za-z0-9_-]+$/u.test(text)) return null;
  try {
    const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
    ) as unknown;
  } catch {
    return null;
  }
}

export function encodeCursor(payload: CursorPayload): string {
  return encodeCursorJson(payload);
}

/** `null` for anything that is not a cursor this service issued. */
export function decodeCursor(text: string): CursorPayload | null {
  const value = decodeCursorJson(text, 2048);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["basisRef", "queryDigest", "offset"]) ||
    !isText(value.basisRef, 256) ||
    !isText(value.queryDigest, 128) ||
    !isSafeInt(value.offset, 0, MAX_OFFSET)
  )
    return null;
  return { basisRef: value.basisRef, queryDigest: value.queryDigest, offset: value.offset };
}

/**
 * The offset a request resumes from, or `stale` when the cursor belongs to a
 * context with other pinned inputs or a different query. `stale` is never
 * downgraded to "start again from the newest rows".
 */
export function resumeOffset(
  cursor: string | null,
  basisRef: string,
  queryDigest: string,
): { ok: true; offset: number } | { ok: false; reason: "stale_context" } {
  if (cursor === null) return { ok: true, offset: 0 };
  const decoded = decodeCursor(cursor);
  if (decoded === null || decoded.basisRef !== basisRef || decoded.queryDigest !== queryDigest)
    return { ok: false, reason: "stale_context" };
  return { ok: true, offset: decoded.offset };
}
