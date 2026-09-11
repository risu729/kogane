// Boolean columns ⇄ `boolean`.
//
// SQLite has no boolean type; CORE stores 0 or 1 under a CHECK constraint. The
// dangerous direction is reading: `Boolean(row.active)` turns the string "0"
// — which a JSON round trip or a text-affinity column can produce — into
// `true`, so a revoked route would read as active. This codec accepts only the
// two values the schema allows and says so when it sees anything else.
export function encodeBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** `true`/`false` for 1/0, and null for any other column value. */
export function decodeBoolean(value: unknown): boolean | null {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
}

/** `decodeBoolean` with an explicit answer for an unreadable column. */
export function decodeBooleanOr(value: unknown, fallback: boolean): boolean {
  return decodeBoolean(value) ?? fallback;
}

/** A guard that never reads an unexpected value as "yes". */
export function isTrue(value: unknown): boolean {
  return decodeBoolean(value) === true;
}
