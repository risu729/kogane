import type { CollectionManifest, CollectorArtifact, StoredArtifact } from "./types";

export function runPrefix(startedAt: string, runId: string): string {
  const date = startedAt.slice(0, 10).replaceAll("-", "/");
  return `raw/sbi-vc-trade/${date}/${runId}`;
}

export async function storeArtifact(options: {
  bucket: R2Bucket;
  prefix: string;
  artifact: CollectorArtifact;
}): Promise<StoredArtifact> {
  if (!/^[a-z0-9-]+$/u.test(options.artifact.dataset)) throw new Error("invalid_artifact_dataset");
  const encoded = new TextEncoder().encode(options.artifact.body);
  const sha256 = await sha256Hex(encoded);
  const key = `${options.prefix}/${options.artifact.dataset}.json`;
  await options.bucket.put(key, encoded, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { dataset: options.artifact.dataset, sha256 },
  });
  return { dataset: options.artifact.dataset, key, sha256, bytes: encoded.byteLength };
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
      runId: options.manifest.runId,
      status: options.manifest.status,
    },
  });
  return key;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
