// Canonical JSON encoding, version 1. The bytes produced here are hashed into
// persisted descriptor and inventory digests, so this file must never change
// behaviour: a new encoding is a new versioned function, never an edit.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = Record<string, unknown>;

/** Code-unit order (plain `<` / `>` on strings), matching SQLite `COLLATE BINARY` for ASCII keys. */
export function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => binaryCompare(left, right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("canonical numbers must be safe integers");
  }
  return value;
}

/**
 * Sorted-key JSON text: object keys in binary order at every depth, array
 * order preserved, strings written by `JSON.stringify` (no Unicode
 * normalization, non-ASCII stays literal), numbers limited to safe integers.
 * Properties whose value is `undefined` are dropped exactly as
 * `JSON.stringify` drops them; `null` is written.
 */
export function canonicalJsonV1(value: JsonValue): string {
  return JSON.stringify(canonical(value));
}

/** UTF-8 bytes of {@link canonicalJsonV1}. */
export function encodeCanonicalV1(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJsonV1(value));
}

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
