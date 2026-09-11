import type { EncryptedPayload } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importKey(secret: string): Promise<CryptoKey> {
  const raw = fromBase64(secret);
  if (raw.byteLength !== 32) throw new Error("session_encryption_key_invalid");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(value: unknown, secret: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

export async function decryptJson<T>(payload: EncryptedPayload, secret: string): Promise<T> {
  if (payload.version !== 1) throw new Error("encrypted_payload_version_invalid");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(payload.iv) },
    await importKey(secret),
    fromBase64(payload.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export function parseCredentials(value: string): CredentialsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("smbc_credentials_json_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("smbc_credentials_invalid");
  }
  const record = parsed as Record<string, unknown>;
  const user = record.user;
  const password = record.password;
  if (typeof user !== "string" || typeof password !== "string" || password.length === 0) {
    throw new Error("smbc_credentials_invalid");
  }
  const match = /^(\d+)-(\d+)$/u.exec(user);
  if (!match?.[1] || !match[2]) throw new Error("smbc_credentials_user_invalid");
  return { branchNo: match[1], accountNo: match[2], password };
}

interface CredentialsResult {
  branchNo: string;
  accountNo: string;
  password: string;
}
