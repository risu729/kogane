import type { CollectionManifest, CollectorArtifact, StoredArtifact } from "./types";

export function runPrefix(startedAt: string, runId: string): string {
  const date = startedAt.slice(0, 10).replaceAll("-", "/");
  return `raw/sbi-vc-trade/${date}/${runId}`;
}

/**
 * The manifest entry of an artifact — validated, hashed and keyed inside its
 * run — without writing it anywhere. `storeArtifact` is this plus the staging
 * put; in shared mode (U09) the entry is all the run needs, because the bytes
 * go to DATA content-addressed and the staging bucket is not written.
 */
export async function describeArtifact(options: {
  prefix: string;
  artifact: CollectorArtifact;
}): Promise<{ record: StoredArtifact; encoded: Uint8Array }> {
  if (!/^[a-z0-9-]+$/u.test(options.artifact.dataset)) throw new Error("invalid_artifact_dataset");
  const encoded = new TextEncoder().encode(options.artifact.body);
  const sha256 = await sha256Hex(encoded);
  const key = `${options.prefix}/${options.artifact.dataset}.json`;
  return {
    record: { dataset: options.artifact.dataset, key, sha256, bytes: encoded.byteLength },
    encoded,
  };
}

export async function storeArtifact(options: {
  bucket: R2Bucket;
  prefix: string;
  runId: string;
  artifact: CollectorArtifact;
}): Promise<StoredArtifact> {
  const { record, encoded } = await describeArtifact(options);
  const stored = await options.bucket.put(record.key, encoded, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: record.sha256,
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      source: "sbi-vc-trade",
      runId: options.runId,
      dataset: options.artifact.dataset,
      sha256: record.sha256,
    },
  });
  if (!stored) throw new Error("artifact_key_already_exists");
  return record;
}

export async function storeManifest(options: {
  bucket: R2Bucket;
  prefix: string;
  manifest: CollectionManifest;
}): Promise<string> {
  const key = `${options.prefix}/manifest.json`;
  const encoded = new TextEncoder().encode(JSON.stringify(options.manifest));
  const sha256 = await sha256Hex(encoded);
  const stored = await options.bucket.put(key, encoded, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256,
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      source: options.manifest.source,
      runId: options.manifest.runId,
      status: options.manifest.status,
    },
  });
  if (!stored) throw new Error("manifest_key_already_exists");
  return key;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
