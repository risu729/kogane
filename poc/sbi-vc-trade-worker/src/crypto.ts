import type { EncryptedSession, SessionMaterial } from "./types";
import { parseSession } from "./session";

const AAD = new TextEncoder().encode("kogane-sbi-vc-session-v1");

export async function encryptSession(
  session: SessionMaterial,
  encodedKey: string,
): Promise<EncryptedSession> {
  const key = await importKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(session));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD },
    key,
    plaintext,
  );
  return { version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptSession(
  value: EncryptedSession,
  encodedKey: string,
): Promise<SessionMaterial> {
  if (value.version !== 1) throw new Error("unsupported_session_version");
  const key = await importKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(value.iv), additionalData: AAD },
    key,
    fromBase64(value.ciphertext),
  );
  return parseSession(JSON.parse(new TextDecoder().decode(plaintext)) as unknown);
}

async function importKey(encodedKey: string): Promise<CryptoKey> {
  const raw = fromBase64(encodedKey);
  if (raw.byteLength !== 32) throw new Error("invalid_encryption_key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}
