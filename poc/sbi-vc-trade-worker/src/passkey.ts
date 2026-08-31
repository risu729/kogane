import { parseSession } from "./session";
import type { PasskeyCredential, SessionMaterial } from "./types";

const ORIGIN = "https://simple.sbivc.co.jp";
const INITIATE_URL = `${ORIGIN}/api/cccmdipresen/gw/initiateLoginWithPasskey`;
const LOGIN_URL = `${ORIGIN}/api/cccmdipresen/gw/loginWithPasskey`;
const MAX_RESPONSE_BYTES = 64 * 1024;
const AUTHENTICATOR_FLAGS = 0x1d;
const COOKIE_NAMES = new Set([
  "vct_bff_sid",
  "JSESSIONID",
  "AWSALBAPP-0",
  "AWSALBAPP-1",
  "AWSALBAPP-2",
  "AWSALBAPP-3",
  "AWSALB",
  "AWSALBCORS",
]);

interface GatewayEnvelope {
  meta: { status: string };
  body: Record<string, unknown>;
}

export function parsePasskeyCredential(value: unknown): PasskeyCredential {
  if (!isRecord(value)) throw new Error("invalid_passkey_credential");
  const counter = typeof value.counter === "string" ? Number(value.counter) : value.counter;
  if (typeof counter === "number" && Number.isInteger(counter) && counter !== 0) {
    throw new Error("nonzero_passkey_counter_not_supported");
  }
  if (
    typeof value.credentialId !== "string"
    || typeof value.keyValue !== "string"
    || value.rpId !== "sbivc.co.jp"
    || typeof value.userHandle !== "string"
    || counter !== 0
    || value.keyAlgorithm !== "ECDSA"
    || value.keyCurve !== "P-256"
  ) throw new Error("invalid_passkey_credential");
  if (!value.credentialId || !value.keyValue || !value.userHandle || /[\r\n]/u.test(value.userHandle)) {
    throw new Error("invalid_passkey_credential");
  }
  return {
    credentialId: value.credentialId,
    keyValue: value.keyValue,
    rpId: value.rpId,
    userHandle: value.userHandle,
    counter: 0,
    keyAlgorithm: value.keyAlgorithm,
    keyCurve: value.keyCurve,
  };
}

export async function createAssertion(
  credential: PasskeyCredential,
  challenge: string,
): Promise<Record<string, string>> {
  if (!challenge || !isBase64Url(challenge)) throw new Error("invalid_passkey_challenge");
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin: ORIGIN,
    crossOrigin: false,
  }));
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential.rpId)));
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(rpIdHash, 0);
  authenticatorData[32] = AUTHENTICATOR_FLAGS;
  new DataView(authenticatorData.buffer).setUint32(33, credential.counter, false);

  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const signedData = new Uint8Array(authenticatorData.byteLength + clientHash.byteLength);
  signedData.set(authenticatorData, 0);
  signedData.set(clientHash, authenticatorData.byteLength);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(fromBase64Url(credential.keyValue)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const rawSignature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    signedData,
  ));
  if (rawSignature.byteLength !== 64) throw new Error("unexpected_passkey_signature_format");

  return {
    challenge,
    credentialId: toBase64Url(parseCredentialId(credential.credentialId)),
    authenticatorData: toBase64Url(authenticatorData),
    clientDataJSON: toBase64Url(clientDataJSON),
    signature: toBase64Url(p1363ToDer(rawSignature)),
    userHandle: credential.userHandle,
  };
}

export async function createPasskeySession(
  credential: PasskeyCredential,
  fetcher: typeof fetch = fetch,
): Promise<SessionMaterial> {
  const cookies = new Map<string, string>();
  const initiateResponse = await postGateway(
    fetcher,
    INITIATE_URL,
    { event: "initiateLoginWithPasskey", data: { channel: "SIMPLE_MODE" } },
    cookies,
  );
  applySetCookies(cookies, initiateResponse.response.headers.getSetCookie());
  const initiate = initiateResponse.envelope;
  if (
    initiate.meta.status !== "OK"
    || typeof initiate.body.challenge !== "string"
    || initiate.body.rpId !== credential.rpId
    || initiate.body.userVerification !== "required"
  ) {
    throw new Error("passkey_initiation_rejected");
  }

  const assertion = await createAssertion(credential, initiate.body.challenge);
  const loginResponse = await postGateway(
    fetcher,
    LOGIN_URL,
    { event: "loginWithPasskey", data: assertion },
    cookies,
  );
  applySetCookies(cookies, loginResponse.response.headers.getSetCookie());
  const login = loginResponse.envelope;
  if (login.meta.status !== "OK") throw new Error("passkey_login_rejected");
  if (login.body.isAgreed !== true) throw new Error("manual_agreement_required");
  if (typeof login.body.accountId !== "string" || !login.body.accountId) {
    throw new Error("passkey_login_missing_account_id");
  }

  return parseSession({
    secureKey: login.body.accountId,
    cookies: {
      vctBffSid: cookies.get("vct_bff_sid"),
      jSessionId: cookies.get("JSESSIONID"),
      awsAlbApp: [0, 1, 2, 3].map((index) => cookies.get(`AWSALBAPP-${index}`)),
      awsAlb: cookies.get("AWSALB"),
      awsAlbCors: cookies.get("AWSALBCORS"),
    },
  });
}

async function postGateway(
  fetcher: typeof fetch,
  url: string,
  body: unknown,
  cookies: Map<string, string>,
): Promise<{ response: Response; envelope: GatewayEnvelope }> {
  const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetcher(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: ORIGIN,
      Referer: `${ORIGIN}/login`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`passkey_http_${response.status}`);
  if (!(response.headers.get("content-type")?.toLowerCase().includes("application/json"))) {
    throw new Error("passkey_non_json_response");
  }
  const parsed = JSON.parse(await readBoundedText(response.clone(), MAX_RESPONSE_BYTES)) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.meta) || typeof parsed.meta.status !== "string" || !isRecord(parsed.body)) {
    throw new Error("invalid_passkey_gateway_envelope");
  }
  return { response, envelope: { meta: { status: parsed.meta.status }, body: parsed.body } };
}

function applySetCookies(cookies: Map<string, string>, headers: readonly string[]): void {
  for (const header of headers) {
    const firstPart = header.split(";", 1)[0];
    if (!firstPart) continue;
    const separator = firstPart.indexOf("=");
    if (separator <= 0) continue;
    const name = firstPart.slice(0, separator);
    const value = firstPart.slice(separator + 1);
    if (COOKIE_NAMES.has(name) && value) cookies.set(name, value);
  }
}

function parseCredentialId(value: string): Uint8Array {
  if (value.startsWith("b64.")) return fromBase64Url(value.slice(4));
  const compact = value.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/u.test(compact)) throw new Error("invalid_passkey_credential_id");
  return Uint8Array.from(compact.match(/.{2}/gu)!, (hex) => Number.parseInt(hex, 16));
}

function p1363ToDer(signature: Uint8Array): Uint8Array {
  const encodeInteger = (input: Uint8Array): Uint8Array => {
    let offset = 0;
    while (offset < input.length - 1 && input[offset] === 0) offset += 1;
    const value = input.subarray(offset);
    const needsZero = (value[0]! & 0x80) !== 0;
    const encoded = new Uint8Array(2 + value.length + (needsZero ? 1 : 0));
    encoded[0] = 0x02;
    encoded[1] = value.length + (needsZero ? 1 : 0);
    if (needsZero) encoded[2] = 0;
    encoded.set(value, 2 + (needsZero ? 1 : 0));
    return encoded;
  };
  const r = encodeInteger(signature.subarray(0, 32));
  const s = encodeInteger(signature.subarray(32));
  const result = new Uint8Array(2 + r.length + s.length);
  result[0] = 0x30;
  result[1] = r.length + s.length;
  result.set(r, 2);
  result.set(s, 2 + r.length);
  return result;
}

function fromBase64Url(value: string): Uint8Array {
  if (!isBase64Url(value)) throw new Error("invalid_base64url");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("missing_response_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("response_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
