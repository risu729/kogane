// A cursor is bound to its context and to the digest of its query spec
// (addendum 06 section 7). Reusing one query's cursor on another account
// condition, or on a context opened from a different published set, is
// refused rather than silently answered from the newest data.
//
// The value is opaque to callers: base64url of the canonical JSON of the
// three fields below. It carries no scope, so a cursor is not a way to read
// outside a grant, and it is never a database offset a caller can invent —
// a decoded cursor whose digest does not match this request is rejected.
import { canonicalJson } from "../../../domain/src/context.ts";
import { hasExactKeys, isRecord, isSafeInt, isText } from "../../../domain/src/guards.ts";

export interface CursorPayload {
  contextId: string;
  queryDigest: string;
  offset: number;
}

const MAX_OFFSET = 1_000_000;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function encodeCursor(payload: CursorPayload): string {
  return base64url(new TextEncoder().encode(canonicalJson(payload)));
}

/** `null` for anything that is not a cursor this service issued. */
export function decodeCursor(text: string): CursorPayload | null {
  if (text.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(text)) return null;
  let json: string;
  try {
    const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contextId", "queryDigest", "offset"]) ||
    !isText(value.contextId, 256) ||
    !isText(value.queryDigest, 128) ||
    !isSafeInt(value.offset, 0, MAX_OFFSET)
  )
    return null;
  return { contextId: value.contextId, queryDigest: value.queryDigest, offset: value.offset };
}

/**
 * The offset a request resumes from, or `stale` when the cursor belongs to a
 * different context or a different query. `stale` is never downgraded to
 * "start again from the newest rows".
 */
export function resumeOffset(
  cursor: string | null,
  contextId: string,
  queryDigest: string,
): { ok: true; offset: number } | { ok: false; reason: "stale_context" } {
  if (cursor === null) return { ok: true, offset: 0 };
  const decoded = decodeCursor(cursor);
  if (decoded === null || decoded.contextId !== contextId || decoded.queryDigest !== queryDigest)
    return { ok: false, reason: "stale_context" };
  return { ok: true, offset: decoded.offset };
}
