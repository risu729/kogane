// Nullable id columns ⇄ `number | null`.
//
// CORE keeps its existing integer row ids (unified plan 04 §3) and uses NULL
// for "no such parent / not superseded / not sealed". Two mistakes this codec
// blocks: reading NULL as 0 (row 0 does not exist, but `?? 0` makes a missing
// parent look like a real one), and accepting a non-integer or negative id
// that no `INTEGER PRIMARY KEY` ever produced.
export function isRowId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The id a column holds, or null. Anything that is not a row id reads null. */
export function decodeNullableId(value: unknown): number | null {
  return isRowId(value) ? value : null;
}

/** The id a column must hold; throws rather than inventing one. */
export function requireRowId(value: unknown, code: string): number {
  if (!isRowId(value)) throw new Error(code);
  return value;
}

/** The column an optional reference writes. */
export function encodeNullableId(id: number | null | undefined): number | null {
  return id === null || id === undefined ? null : id;
}
