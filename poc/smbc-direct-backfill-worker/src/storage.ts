import type { BackfillManifest, StoredArtifact } from "./types";

const encoder = new TextEncoder();

export function runPrefix(startedAt: string, runId: string): string {
  const date = startedAt.slice(0, 10).replaceAll("-", "/");
  return `raw/smbc-direct/${date}/${runId}`;
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function storeBytes(options: {
  bucket: R2Bucket;
  key: string;
  bytes: Uint8Array;
  mediaType: string;
  artifact: Omit<StoredArtifact, "key" | "bytes" | "sha256" | "mediaType">;
}): Promise<StoredArtifact> {
  const sha256 = await sha256Hex(options.bytes);
  await options.bucket.put(options.key, options.bytes, {
    httpMetadata: { contentType: options.mediaType },
    customMetadata: { sha256 },
  });
  return {
    ...options.artifact,
    key: options.key,
    mediaType: options.mediaType,
    bytes: options.bytes.byteLength,
    sha256,
  };
}

export async function storeJson(options: {
  bucket: R2Bucket;
  key: string;
  value: unknown;
  artifact: Omit<StoredArtifact, "key" | "bytes" | "sha256" | "mediaType">;
}): Promise<StoredArtifact> {
  return storeBytes({
    ...options,
    bytes: encoder.encode(`${JSON.stringify(options.value)}\n`),
    mediaType: "application/json; charset=utf-8",
  });
}

export async function storeManifest(
  bucket: R2Bucket,
  prefix: string,
  manifest: BackfillManifest,
): Promise<string> {
  const key = `${prefix}/manifest.json`;
  const bytes = encoder.encode(`${JSON.stringify(manifest)}\n`);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { sha256: await sha256Hex(bytes) },
  });
  return key;
}
