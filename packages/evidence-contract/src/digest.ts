// SHA-256 helpers shared by the ingest client and the raw-evidence server.

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy so a view over a shared or resizable buffer is never handed to WebCrypto.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
  return bytesHex(new Uint8Array(digest));
}

/** Lower-case hex SHA-256 of canonical descriptor bytes (descriptor-v1). */
export function descriptorDigestV1(canonicalBytes: Uint8Array): Promise<string> {
  return sha256Hex(canonicalBytes);
}
