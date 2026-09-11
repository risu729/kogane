import { Buffer } from "node:buffer";
import type { MoneyForwardCredential } from "./types";

const RP_ID = "id.moneyforward.com";
const ORIGIN = "https://id.moneyforward.com";

export interface AssertionOptions {
  challenge: string;
  rpId?: string;
}

export function parseCredential(value: string): MoneyForwardCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("MONEYFORWARD_CREDENTIAL_JSON is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Money Forward credential must be an object");
  }
  const object = parsed as Record<string, unknown>;
  const rpId = requiredString(object["rpId"], "rpId");
  const origin = requiredString(object["origin"], "origin");
  if (rpId !== RP_ID || origin !== ORIGIN) {
    throw new Error("Money Forward credential RP ID or origin is invalid");
  }
  const counter = Number(object["counter"] ?? 0);
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error("Money Forward credential counter is invalid");
  }
  const userHandle = optionalString(object["userHandle"]);
  return {
    rpId,
    origin,
    credentialId: requiredString(object["credentialId"], "credentialId"),
    keyValue: requiredString(object["keyValue"], "keyValue"),
    ...(userHandle ? { userHandle } : {}),
    counter,
  } as MoneyForwardCredential;
}

export async function createAssertion(
  credential: MoneyForwardCredential,
  options: AssertionOptions,
): Promise<Record<string, unknown>> {
  const rpId = options.rpId ?? credential.rpId;
  if (rpId !== credential.rpId) throw new Error("Passkey RP ID mismatch");
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: options.challenge,
      origin: credential.origin,
      crossOrigin: false,
    }),
  );
  const authenticatorData = Buffer.concat([
    Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(rpId))),
    Buffer.from([0x1d]),
    uint32be(credential.counter),
  ]);
  const signedData = Buffer.concat([
    authenticatorData,
    Buffer.from(await crypto.subtle.digest("SHA-256", clientData)),
  ]);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    exactArrayBuffer(base64UrlDecode(credential.keyValue)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      exactArrayBuffer(signedData),
    ),
  );
  // Web Crypto ECDSA returns fixed-width r || s, including when r happens to
  // begin with DER's 0x30 tag. WebAuthn always requires ASN.1 DER encoding.
  const signature = p1363ToDer(rawSignature);
  const credentialId = base64Url(parseCredentialId(credential.credentialId));
  return {
    id: credentialId,
    rawId: credentialId,
    response: {
      authenticatorData: base64Url(authenticatorData),
      clientDataJSON: base64Url(clientData),
      signature: base64Url(signature),
      userHandle: credential.userHandle ?? null,
    },
    type: "public-key",
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

export function parseCredentialId(value: string): Uint8Array {
  if (value.startsWith("b64.")) return base64UrlDecode(value.slice(4));
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(hex)) throw new Error("Passkey credential ID is invalid");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function p1363ToDer(signature: Uint8Array): Uint8Array {
  if (signature.byteLength !== 64) throw new Error("Unexpected ECDSA signature length");
  const r = derInteger(signature.slice(0, 32));
  const s = derInteger(signature.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

function derInteger(value: Uint8Array): number[] {
  let offset = 0;
  while (offset < value.length - 1 && value[offset] === 0) offset += 1;
  const body = [...value.slice(offset)];
  if ((body[0] ?? 0) & 0x80) body.unshift(0);
  return [0x02, body.length, ...body];
}

function uint32be(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value >>> 0);
  return result;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Money Forward credential ${name} is missing`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
