// Person names are removed from a provider response before it is stored
// (ADR 0029, amendment 2026-09-27: class (d) applies to stored evidence).
//
// Only fields that have been observed to carry a person's name are listed,
// by their path in the response; nothing is guessed from a key's spelling.
// The value is replaced with a fixed marker rather than deleted, so the
// stored object keeps the shape its response schema and every parser
// accept. The number of replaced fields is recorded; the value never is.
import { UnknownResponseShapeError } from "./errors";
import { validateKnownResponse } from "./response-schemas";
import type { JsonObject, ResponseSchemaId } from "./types";

/** What a stored response carries in place of a person's name. */
export const NAME_REDACTION_MARKER = "[redacted:name]";

/**
 * The observed person-name fields of each stored response, as a path of
 * object keys from the response root to the object that holds them, and the
 * field names in that object. Branch names (`branchFetch.responseParam.
 * branchName`) and product names (`tdProductDetail.productName`) are not a
 * person's name and are kept.
 */
export const PERSON_NAME_FIELDS: Readonly<
  Partial<
    Record<ResponseSchemaId, readonly { path: readonly string[]; fields: readonly string[] }[]>
  >
> = {
  "sbi-shinsei-balance-summary-v1": [
    {
      path: ["responseParam", "summary", "responseParam"],
      fields: ["customerName", "customerNameKanji", "customerNameKana"],
    },
  ],
};

export interface RedactedResponse {
  /** The bytes to store: the provider's own text when nothing was redacted. */
  readonly body: string;
  readonly redactedFieldCount: number;
}

/**
 * Replaces every listed name field that holds a value with the marker. An
 * absent, `null` or empty field has nothing to remove and is left as it is.
 * The provider object is never serialized again: the marker is written into
 * the provider's own text, as the string value of each redacted key, so every
 * other byte (numbers, whitespace, escapes, key order) stays as the provider
 * wrote it. The result must then parse, pass the same schema, and equal the
 * original object with exactly the listed fields redacted; a key found
 * anywhere else, or a name field that is not a JSON string, makes that
 * comparison fail and the response is refused with a stable message rather
 * than stored altered.
 */
export function redactPersonNames(
  schema: ResponseSchemaId,
  raw: string,
  parsed: JsonObject,
): RedactedResponse {
  const targets = PERSON_NAME_FIELDS[schema] ?? [];
  if (targets.length === 0) return { body: raw, redactedFieldCount: 0 };
  const expected = structuredClone(parsed);
  const redactedFields = new Set<string>();
  let redactedFieldCount = 0;
  for (const target of targets) {
    const holder = objectAt(expected, target.path);
    if (holder === undefined) continue;
    for (const field of target.fields) {
      const value = holder[field];
      if (value === undefined || value === null || value === "") continue;
      if (value === NAME_REDACTION_MARKER) continue;
      holder[field] = NAME_REDACTION_MARKER;
      redactedFields.add(field);
      redactedFieldCount += 1;
    }
  }
  if (redactedFieldCount === 0) return { body: raw, redactedFieldCount: 0 };
  let body = raw;
  for (const field of redactedFields) body = replaceStringValue(body, field);
  let stored: unknown;
  try {
    stored = JSON.parse(body);
  } catch {
    throw new UnknownResponseShapeError("name redaction did not match the response");
  }
  validateKnownResponse(schema, stored);
  if (JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw new UnknownResponseShapeError("name redaction did not match the response");
  }
  return { body, redactedFieldCount };
}

/**
 * Writes the marker as the string value of every `"<field>": "…"` pair in the
 * text. The value pattern is escaping-aware; a key must be spelled exactly
 * (field names are plain identifiers, so they need no escaping in the
 * pattern), and a key written with escapes is not matched, which the caller's
 * comparison then refuses.
 */
function replaceStringValue(text: string, field: string): string {
  const pair = new RegExp(`("${field}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gu");
  return text.replace(pair, (_match, prefix: string) => `${prefix}"${NAME_REDACTION_MARKER}"`);
}

function objectAt(root: JsonObject, path: readonly string[]): JsonObject | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as JsonObject)[key];
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
  return current as JsonObject;
}
