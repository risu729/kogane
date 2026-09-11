// The Vpass JSON sanitizer, version 1 (`vpass-json-sanitizer`).
//
// A Vpass response envelope carries session and device material next to the
// statement rows: auth blobs, tokens, device ids, and the card identify keys
// that address a card. None of that may reach central storage, so the bytes
// that are stored are the sanitized, canonically encoded envelope — never the
// provider response as it arrived.
//
// This is the same transformation, with the same id and version, that
// `services/collector-r2-importer` applies today when it copies a Vpass run
// into central storage: the same sensitive-key rule, the same card-list
// rewrite, the same canonical encoding with a trailing newline, and the same
// post-check that refuses output which still holds a sensitive value. It is
// implemented here because a collector writing straight to the shared bucket
// has to sanitize before the bytes leave the Worker (unified plan 03 §2,
// 12 §6), and a Worker may not import another Worker's internals.
//
// Changing what it produces is a new version, never an edit: the digests of
// stored objects are derived from these bytes.

export const VPASS_SANITIZER_ID = "vpass-json-sanitizer";
export const VPASS_SANITIZER_VERSION = "v1";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = Record<string, unknown>;

export class VpassSanitizeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VpassSanitizeError";
  }
}

const REDACTED_VALUE = "<redacted-vpass-sensitive>";
const REDACTED_CARD = "<redacted-card-reference>";

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectAt(value: unknown, ...path: string[]): JsonObject | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

/** Code-unit order, matching the central canonical encoder. */
function binaryCompare(left: string, right: string): number {
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
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new VpassSanitizeError("json_number_invalid");
  }
  return value;
}

/** Sorted-key JSON with a trailing newline: the bytes central storage holds. */
export function encodeCanonical(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(canonical(value))}\n`);
}

/** Anything whose key names authentication, a session, a device or a card
 * reference is replaced wholesale rather than inspected. */
function sensitiveKey(key: string): boolean {
  return /(?:auth|token|session|cookie|password|userid|device|csrf|card.*(?:key|id)|identify)/iu.test(
    key,
  );
}

function sanitizeJson(value: unknown, sensitiveContext: boolean): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return sensitiveContext && typeof value === "string" && value.length > 0
      ? REDACTED_VALUE
      : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new VpassSanitizeError("json_number_invalid");
    return sensitiveContext ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeJson(entry, sensitiveContext));
  if (!isRecord(value)) throw new VpassSanitizeError("json_value_invalid");
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (sensitiveContext || sensitiveKey(key)) return [key, REDACTED_VALUE];
      return [key, sanitizeJson(child, false)];
    }),
  );
}

/** The post-check: output that still holds a sensitive value is refused, so a
 * change in the rules above fails the run instead of publishing the value. */
function assertSanitized(value: JsonValue, cardList: boolean): void {
  const visit = (child: JsonValue): void => {
    if (Array.isArray(child)) {
      child.forEach(visit);
      return;
    }
    if (child === null || typeof child !== "object") return;
    for (const [key, nested] of Object.entries(child)) {
      if (sensitiveKey(key) && nested !== REDACTED_VALUE) {
        throw new VpassSanitizeError("sanitizer_sensitive_value_retained");
      }
      visit(nested);
    }
  };
  visit(value);
  if (!cardList) return;
  const list = objectAt(value, "body", "content", "DropdownListInitDisplayServiceBean")?.[
    "multiCardInfoList"
  ];
  if (
    !Array.isArray(list) ||
    list.some(
      (entry, index) =>
        !isRecord(entry) ||
        entry["name"] !== `card-${String(index + 1).padStart(3, "0")}` ||
        entry["value"] !== REDACTED_CARD,
    )
  ) {
    throw new VpassSanitizeError("sanitizer_card_reference_retained");
  }
}

/**
 * Sanitize one response envelope. `cardList` additionally replaces the card
 * inventory's display names by their ordinal labels and its values by a
 * placeholder, because a card reference addresses the card itself.
 */
function sanitizeEnvelope(envelope: JsonObject, cardList = false): JsonValue {
  const sanitized = sanitizeJson(envelope, false);
  if (!isRecord(sanitized)) throw new VpassSanitizeError("sanitizer_output_invalid");
  if (cardList) {
    const bean = objectAt(sanitized, "body", "content", "DropdownListInitDisplayServiceBean");
    const list = bean?.["multiCardInfoList"];
    if (!Array.isArray(list)) throw new VpassSanitizeError("card_inventory_invalid");
    bean!["multiCardInfoList"] = list.map((entry, index) => {
      if (!isRecord(entry)) throw new VpassSanitizeError("card_inventory_invalid");
      return Object.fromEntries(
        Object.entries(entry).map(([key, value]) => {
          if (key === "name") return [key, `card-${String(index + 1).padStart(3, "0")}`];
          if (key === "value") return [key, REDACTED_CARD];
          return [key, value];
        }),
      );
    });
  }
  assertSanitized(sanitized as JsonValue, cardList);
  return sanitized as JsonValue;
}

/** Parse a captured response body and check it is a successful envelope. */
function parseEnvelope(rawJson: string, code: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new VpassSanitizeError(code);
  }
  if (!isRecord(parsed)) throw new VpassSanitizeError(code);
  const header = objectAt(parsed, "header");
  const body = objectAt(parsed, "body");
  const resultCode = header?.["resultCode"];
  if (!header || !body || !(resultCode === 0 || resultCode === "0" || resultCode === "0000")) {
    throw new VpassSanitizeError(code);
  }
  return parsed;
}

/** The sanitized, canonically encoded bytes of one captured response. */
export function sanitizedEnvelopeBytes(
  rawJson: string,
  code: string,
  cardList = false,
): Uint8Array {
  return encodeCanonical(sanitizeEnvelope(parseEnvelope(rawJson, code), cardList));
}
