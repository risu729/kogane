// Small runtime guards shared by every validator in this package. All
// validators reject unknown keys so that a stored contract cannot grow
// silently; a new field is a reviewed contract change, not a free extension.
export type Guard<T> = (value: unknown) => value is T;
export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every required key present, and no key outside required ∪ optional. */
export function hasExactKeys(
  row: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (required.some((key) => !Object.hasOwn(row, key))) return false;
  return Object.keys(row).every((key) => required.includes(key) || optional.includes(key));
}

export function isText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isTextOrNull(value: unknown, max = 256): value is string | null {
  return value === null || isText(value, max);
}

export function isOneOf<const T extends readonly string[]>(values: T): Guard<T[number]> {
  return (value): value is T[number] => typeof value === "string" && values.includes(value);
}

export function isArrayOf<T>(guard: Guard<T>, max = 10_000): Guard<T[]> {
  return (value): value is T[] =>
    Array.isArray(value) && value.length <= max && value.every((item) => guard(item));
}

export function isSafeInt(
  value: unknown,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Reference identifiers: opaque non-empty strings, bounded, no duplicates. */
export function isRefList(value: unknown, max = 10_000): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => isText(item, 512)) &&
    new Set(value).size === value.length
  );
}

export function isStringRecord(value: unknown, max = 1_000): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= max && entries.every(([key, item]) => isText(key, 256) && isText(item, 1024))
  );
}
