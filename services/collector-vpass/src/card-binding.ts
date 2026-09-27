// The Vpass durable card binding, derived in the Worker (ADR 0023, ADR 0029).
//
// A Vpass card ordinal (`card-NNN`) is a position in the provider's card list,
// not an identity. The successful card-selection and statement-discovery
// responses carry `header.vpSessionBean` with the provider-local card
// reference `externalId`, `globalid` and `cardCode`. This module turns that
// tuple into
//
//   vpass-card-v2- + SHA-256(JSON(["vpass-card-binding-v2", externalId, globalid, cardCode]))
//
// an unkeyed, domain-separated digest (ADR 0029). The retired importer
// (`services/collector-r2-importer/src/vpass-identity.ts`, removed in #203)
// derived `vpass-card-v1-` tokens from the same tuple as an HMAC under a key
// that was retired with it. v1 tokens stay readable as historical evidence,
// but nothing derives them any more, and the v1 and the v2 token of one card
// are different values ([Vpass card binding](../../../docs/vpass-card-identity.md)).
//
// The checks are the importer's, run on the raw responses while they are
// still in the Worker's memory, before the sanitizer redacts `vpSessionBean`.
// The tuple never leaves this module: the only output is the token, or a
// closed code saying why there is none. It fails closed: no tuple, a
// malformed tuple, an ambiguous card inventory or a selection that disagrees
// with discovery all return `unavailable`, and the card run is stored without
// a binding. No secret is involved: ADR 0029 classifies the card reference as
// a provider-local identifier that central storage may hold, so the digest
// only fixes the token's shape and separates it from every other derivation.

export const VPASS_BINDING_CONTRACT = "vpass-card-binding-v2";
/** The token prefix of this derivation (ADR 0029). */
export const VPASS_BINDING_TOKEN_PREFIX = "vpass-card-v2-";
/** The artifact, dataset and format the trusted binding view requires (migrations 0020, 0021, 0055, 0057). */
export const VPASS_BINDING_ARTIFACT_KEY = "card-identity-binding.json";
export const VPASS_BINDING_TRANSFORMER_ID = "vpass-card-binding";
export const VPASS_BINDING_TRANSFORMER_VERSION = "v2";
const TOKEN = /^vpass-card-v2-[0-9a-f]{64}$/u;
const CARD_LABEL = /^card-(\d{3})$/u;
const DESCRIPTOR = /^[A-Za-z0-9_-]+$/u;

/** Why a card run carries no binding. Closed codes; safe to log. */
export type VpassBindingUnavailable =
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

async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
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

/** The card's durable token, or why there is none. */
export async function deriveVpassCardBinding(input: VpassBindingInput): Promise<VpassCardBinding> {
  let tuple: [string, string, string];
  try {
    tuple = deriveTuple(input);
  } catch (error) {
    if (error instanceof Unavailable) return { status: "unavailable", code: error.code };
    throw error;
  }
  const token = `${VPASS_BINDING_TOKEN_PREFIX}${await sha256(JSON.stringify([VPASS_BINDING_CONTRACT, ...tuple]))}`;
  if (!TOKEN.test(token)) throw new Error("vpass_binding_token_invalid");
  return { status: "derived", token };
}
