import {
  constants,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  SbiCredential,
  SbiHandshakeKey,
  WebAuthnAssertion,
  WebAuthnRequest,
} from "./types";

export function parseHandshakeKey(value: string): SbiHandshakeKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SBI_HANDSHAKE_KEY_JSON is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SBI handshake key must be an object");
  }
  const object = parsed as Record<string, unknown>;
  if (
    typeof object["publicKeyParam"] !== "string" ||
    object["publicKeyParam"].length === 0 ||
    typeof object["privateKeyPem"] !== "string" ||
    !object["privateKeyPem"].includes("BEGIN PRIVATE KEY")
  ) {
    throw new Error("SBI handshake key is incomplete");
  }
  return {
    publicKeyParam: object["publicKeyParam"],
    privateKeyPem: object["privateKeyPem"],
  };
}

export function base64Url(value: Buffer | Uint8Array | string, keepPadding = false): string {
  const encoded = Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return keepPadding ? encoded : encoded.replace(/=+$/u, "");
}

export function base64UrlBuffer(value: string): Buffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
    "base64",
  );
}

export function parseBitwardenCredentialId(value: string): Buffer {
  if (value.startsWith("b64.")) return base64UrlBuffer(value.slice(4));
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/u.test(hex)) {
    throw new Error("SBI passkey credential ID is invalid");
  }
  return Buffer.from(hex, "hex");
}

export function createBitwardenAssertion(
  credential: SbiCredential,
  request: WebAuthnRequest,
): WebAuthnAssertion {
  if (request.rpId !== credential.rpId) {
    throw new Error("SBI passkey RP ID does not match the challenge");
  }
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: request.challenge,
      origin: credential.origin,
    }),
  );
  const rawCredentialId = parseBitwardenCredentialId(credential.credentialId);
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(request.rpId).digest(),
    Buffer.from([0x1d]),
    uint32be(credential.counter > 0 ? credential.counter + 1 : 0),
  ]);
  const signatureBase = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest(),
  ]);
  const privateKey = createPrivateKey({
    key: base64UrlBuffer(credential.keyValue),
    format: "der",
    type: "pkcs8",
  });

  return {
    id: base64Url(rawCredentialId),
    rawId: base64Url(rawCredentialId),
    clientDataJSON: base64Url(clientDataJSON),
    authenticatorData: base64Url(authenticatorData),
    signature: base64Url(sign("sha256", signatureBase, privateKey)),
    userHandle: credential.userHandle
      ? base64Url(base64UrlBuffer(credential.userHandle))
      : "",
  };
}

export function generateHandshakeKey(): {
  publicKeyParam: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    publicKeyParam: base64Url(publicKey, true),
    privateKeyPem: privateKey,
  };
}

export function decryptPasskeyToken(
  encryptedToken: string,
  privateKeyPem: string,
): string {
  const encodedMessage = privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_NO_PADDING,
    },
    base64UrlBuffer(encryptedToken),
  );
  return oaepUnpad(encodedMessage).toString("utf8");
}

export function secretEquals(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function oaepUnpad(encodedMessage: Buffer): Buffer {
  const labelHash = createHash("sha256").update(Buffer.alloc(0)).digest();
  const hashLength = labelHash.length;
  if (encodedMessage.length < 2 * hashLength + 2 || encodedMessage[0] !== 0) {
    throw new Error("SBI passkey token has an invalid OAEP block");
  }

  const maskedSeed = encodedMessage.subarray(1, 1 + hashLength);
  const maskedDb = encodedMessage.subarray(1 + hashLength);
  const seed = xor(maskedSeed, mgf1(maskedDb, hashLength));
  const db = xor(maskedDb, mgf1(seed, maskedDb.length));
  if (!timingSafeEqual(db.subarray(0, hashLength), labelHash)) {
    throw new Error("SBI passkey token has an invalid OAEP label");
  }

  let index = hashLength;
  while (index < db.length && db[index] === 0) index += 1;
  if (db[index] !== 1) {
    throw new Error("SBI passkey token has an invalid OAEP delimiter");
  }
  return db.subarray(index + 1);
}

function mgf1(seed: Buffer, length: number): Buffer {
  const chunks: Buffer[] = [];
  let produced = 0;
  for (let counter = 0; produced < length; counter += 1) {
    const encodedCounter = uint32be(counter);
    const chunk = createHash("sha1").update(seed).update(encodedCounter).digest();
    chunks.push(chunk);
    produced += chunk.length;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function xor(left: Buffer, right: Buffer): Buffer {
  if (left.length !== right.length) throw new Error("OAEP XOR length mismatch");
  const output = Buffer.alloc(left.length);
  for (let index = 0; index < left.length; index += 1) {
    output[index] = left[index]! ^ right[index]!;
  }
  return output;
}

function uint32be(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}
