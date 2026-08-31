import type { CollectionManifest, RawArtifact, StoredArtifact } from "./types";

export function runPrefix(startedAt: string, runId: string): string {
  return `raw/moneyforward/${startedAt.slice(0, 10).replaceAll("-", "/")}/${runId}`;
}

export async function storeArtifact(options: {
  bucket: R2Bucket;
  prefix: string;
  artifact: RawArtifact;
}): Promise<StoredArtifact> {
  if (!/^[a-z0-9-]+$/u.test(options.artifact.dataset)) {
    throw new Error("Money Forward artifact dataset contains unsafe characters");
  }
  if (!/^[a-z0-9.-]+$/u.test(options.artifact.filename)) {
    throw new Error("Money Forward artifact filename contains unsafe characters");
  }
  const bytes = new TextEncoder().encode(options.artifact.body);
  const sha256 = await sha256Hex(bytes);
  const key = `${options.prefix}/${options.artifact.filename}`;
  await options.bucket.put(key, options.artifact.body, {
    httpMetadata: { contentType: options.artifact.mediaType },
    customMetadata: { dataset: options.artifact.dataset, sha256 },
  });
  return {
    dataset: options.artifact.dataset,
    key,
    mediaType: options.artifact.mediaType,
    sha256,
    bytes: bytes.byteLength,
  };
}

export async function storeManifest(options: {
  bucket: R2Bucket;
  prefix: string;
  manifest: CollectionManifest;
}): Promise<string> {
  const key = `${options.prefix}/manifest.json`;
  await options.bucket.put(key, JSON.stringify(options.manifest), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      source: options.manifest.source,
      status: options.manifest.status,
      runId: options.manifest.runId,
    },
  });
  return key;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
