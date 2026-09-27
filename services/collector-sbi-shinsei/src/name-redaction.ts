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
 * The provider's text is kept byte for byte when no field was replaced;
 * otherwise the response is serialized again from the redacted object, and
 * that object is validated against the same schema before it is returned, so
 * a redaction can never store a shape the schema would refuse. Serializing
 * again must not change how any number is written (a balance given as a JSON
 * number with trailing zeros, an exponent or more digits than a double holds
 * would be stored as a different text): such a response is refused with a
 * stable message rather than stored altered.
 */
export function redactPersonNames(
  schema: ResponseSchemaId,
  raw: string,
  parsed: JsonObject,
): RedactedResponse {
  const targets = PERSON_NAME_FIELDS[schema] ?? [];
  if (targets.length === 0) return { body: raw, redactedFieldCount: 0 };
  const copy = structuredClone(parsed);
  let redactedFieldCount = 0;
  for (const target of targets) {
    const holder = objectAt(copy, target.path);
    if (holder === undefined) continue;
    for (const field of target.fields) {
      const value = holder[field];
      if (value === undefined || value === null || value === "") continue;
      if (value === NAME_REDACTION_MARKER) continue;
      holder[field] = NAME_REDACTION_MARKER;
      redactedFieldCount += 1;
    }
  }
  if (redactedFieldCount === 0) return { body: raw, redactedFieldCount: 0 };
  if (!numbersSurviveSerialization(raw)) {
    throw new UnknownResponseShapeError("name redaction would rewrite a number");
  }
  validateKnownResponse(schema, copy);
  return { body: JSON.stringify(copy), redactedFieldCount };
}

// Strings are matched first, so a digit inside a string is never read as a
// number token; `raw` has already parsed as JSON.
const JSON_STRING_OR_NUMBER = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu;

function numbersSurviveSerialization(raw: string): boolean {
  for (const [token] of raw.matchAll(JSON_STRING_OR_NUMBER)) {
    if (token.startsWith('"')) continue;
    if (JSON.stringify(Number(token)) !== token) return false;
  }
  return true;
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
