// The Vpass durable card binding, derived in the Worker (ADR 0023, option 3).
//
// A Vpass card ordinal (`card-NNN`) is a position in the provider's card list,
// not an identity. The successful card-selection and statement-discovery
// responses carry `header.vpSessionBean` with the provider-local card
// reference `externalId`, `globalid` and `cardCode`; the retired importer
// (`services/collector-r2-importer/src/vpass-identity.ts`, removed in #203)
// turned that tuple into
//
//   vpass-card-v1- + HMAC-SHA-256(key, JSON(["vpass-card-binding-v1", externalId, globalid, cardCode]))
//
// under the fingerprint key version `collector-r2-v1`, and stored only the
// token ([Vpass card binding](../../../docs/vpass-card-identity.md)).
//
// This module is the same derivation with the same checks, run on the raw
// responses while they are still in the Worker's memory, before the sanitizer
// redacts `vpSessionBean`. The tuple never leaves this module: the only
// output is the token, or a closed code saying why there is none. It fails
// closed: no key, a malformed key, no tuple, a malformed tuple, an ambiguous
// card inventory or a selection that disagrees with discovery all return
// `unavailable`, and the card run is stored without a binding.
//
// The token equals the importer's for the same card only when the key is the
// importer's `collector-r2-v1` key (its `ORIGIN_FINGERPRINT_KEY`). The Worker
// secret `VPASS_CARD_BINDING_KEY` must therefore hold that value; a different
// key would be a different key version, which this module does not support.

export const VPASS_BINDING_CONTRACT = "vpass-card-binding-v1";
export const VPASS_BINDING_KEY_VERSION = "collector-r2-v1";
/** The artifact, dataset and format the trusted binding view requires (migrations 0020, 0021, 0055). */
export const VPASS_BINDING_ARTIFACT_KEY = "card-identity-binding.json";
export const VPASS_BINDING_TRANSFORMER_ID = "vpass-card-binding";
export const VPASS_BINDING_TRANSFORMER_VERSION = "v1";
const TOKEN = /^vpass-card-v1-[0-9a-f]{64}$/u;
const KEY = /^[0-9a-f]{64}$/u;
const CARD_LABEL = /^card-(\d{3})$/u;
const DESCRIPTOR = /^[A-Za-z0-9_-]+$/u;

/** Why a card run carries no binding. Closed codes; safe to log. */
export type VpassBindingUnavailable =
  | "binding_key_absent"
  | "binding_key_invalid"
  | "binding_envelope_invalid"
  | "binding_inventory_invalid"
  | "binding_tuple_absent"
  | "binding_tuple_invalid"
  | "binding_selection_mismatch";

export type VpassCardBinding =
  | { readonly status: "derived"; readonly token: string }
  | { readonly status: "unavailable"; readonly code: VpassBindingUnavailable };

/** The raw responses of one card, as the Worker holds them before sanitizing. */
export interface VpassBindingInput {
  readonly cardLabel: string;
  readonly cardListRawJson: string;
  readonly selectCardRawJson: string;
  readonly webMeisaiTopRawJson: string;
}

type JsonObject = Record<string, unknown>;

class Unavailable extends Error {
  readonly code: VpassBindingUnavailable;
  constructor(code: VpassBindingUnavailable) {
    super(code);
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectOr(value: unknown, code: VpassBindingUnavailable): JsonObject {
  if (!isRecord(value)) throw new Unavailable(code);
  return value;
}

/** A successful response envelope, as the importer required. */
function envelope(rawJson: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Unavailable("binding_envelope_invalid");
  }
  const result = objectOr(parsed, "binding_envelope_invalid");
  const code = objectOr(result["header"], "binding_envelope_invalid")["resultCode"];
  if (code !== 0 && code !== "0" && code !== "0000") {
    throw new Unavailable("binding_envelope_invalid");
  }
  return result;
}

function descriptor(value: unknown, length: number): string {
  if (typeof value !== "string" || value.length !== length || !DESCRIPTOR.test(value)) {
    throw new Unavailable("binding_tuple_invalid");
  }
  return value;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyHex: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyHex.match(/../gu)!, (pair) => Number.parseInt(pair, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function deriveTuple(input: VpassBindingInput): [string, string, string] {
  const ordinalMatch = CARD_LABEL.exec(input.cardLabel);
  if (!ordinalMatch) throw new Unavailable("binding_inventory_invalid");
  const ordinal = Number(ordinalMatch[1]);

  // The card inventory: names and selectors present and unique, as the
  // importer required. Names are consistency checks only, never identity.
  const listEnvelope = envelope(input.cardListRawJson);
  const bean = objectOr(
    objectOr(
      objectOr(listEnvelope["body"], "binding_inventory_invalid")["content"],
      "binding_inventory_invalid",
    )["DropdownListInitDisplayServiceBean"],
    "binding_inventory_invalid",
  );
  const entries = bean["multiCardInfoList"];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 999) {
    throw new Unavailable("binding_inventory_invalid");
  }
  const cards = entries.map((entry) => objectOr(entry, "binding_inventory_invalid"));
  const names = cards.map((card) => card["name"]);
  const selectors = cards.map((card) => card["value"]);
  if (
    names.some((name) => typeof name !== "string" || name.length < 1) ||
    selectors.some((value) => typeof value !== "string" || value.length < 1) ||
    new Set(names).size !== cards.length ||
    new Set(selectors).size !== cards.length
  ) {
    throw new Unavailable("binding_inventory_invalid");
  }

  const selectionValue = objectOr(
    envelope(input.selectCardRawJson)["header"],
    "binding_envelope_invalid",
  )["vpSessionBean"];
  const discoveryValue = objectOr(
    envelope(input.webMeisaiTopRawJson)["header"],
    "binding_envelope_invalid",
  )["vpSessionBean"];
  if (selectionValue === undefined && discoveryValue === undefined) {
    throw new Unavailable("binding_tuple_absent");
  }
  const selection = objectOr(selectionValue, "binding_tuple_invalid");
  const discovery = objectOr(discoveryValue, "binding_tuple_invalid");
  const externalId = descriptor(selection["externalId"], 32);
  const globalid = descriptor(selection["globalid"], 32);
  const cardCode = descriptor(selection["cardCode"], 13);
  if (
    discovery["cardCode"] !== cardCode ||
    typeof selection["cardName"] !== "string" ||
    selection["cardName"] !== discovery["cardName"] ||
    selection["cardName"] !== cards[ordinal - 1]?.["name"]
  ) {
    throw new Unavailable("binding_selection_mismatch");
  }
  return [externalId, globalid, cardCode];
}

/**
 * The card's durable token, or why there is none. `keyHex` is the Worker
 * secret; undefined or empty means the secret is not set.
 */
export async function deriveVpassCardBinding(
  input: VpassBindingInput,
  keyHex: string | undefined,
): Promise<VpassCardBinding> {
  if (keyHex === undefined || keyHex.length === 0) {
    return { status: "unavailable", code: "binding_key_absent" };
  }
  if (!KEY.test(keyHex)) return { status: "unavailable", code: "binding_key_invalid" };
  let tuple: [string, string, string];
  try {
    tuple = deriveTuple(input);
  } catch (error) {
    if (error instanceof Unavailable) return { status: "unavailable", code: error.code };
    throw error;
  }
  const token = `vpass-card-v1-${await hmac(keyHex, JSON.stringify([VPASS_BINDING_CONTRACT, ...tuple]))}`;
  if (!TOKEN.test(token)) throw new Error("vpass_binding_token_invalid");
  return { status: "derived", token };
}
