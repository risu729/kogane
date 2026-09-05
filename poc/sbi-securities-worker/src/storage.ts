import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Artifact, ArtifactManifest, CollectionManifest } from "./types";

export async function storeArtifact(options: {
  bucket: R2Bucket;
  prefix: string;
  artifact: Artifact;
}): Promise<ArtifactManifest> {
  const body = JSON.stringify(options.artifact.body);
  const bytes = Buffer.byteLength(body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const key = `${options.prefix}/${safeDataset(options.artifact.dataset)}.json`;
  await options.bucket.put(key, body, {
    httpMetadata: { contentType: options.artifact.mediaType },
    customMetadata: {
      dataset: options.artifact.dataset,
      sha256,
    },
  });
  return {
    dataset: options.artifact.dataset,
    key,
    sha256,
    bytes,
    ...(options.artifact.window ? { window: options.artifact.window } : {}),
  };
}

export async function storeManifest(options: {
  bucket: R2Bucket;
  prefix: string;
  manifest: CollectionManifest;
}): Promise<string> {
  const key = `${options.prefix}/manifest.json`;
  const body = JSON.stringify(options.manifest);
  await options.bucket.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      source: options.manifest.source,
      status: options.manifest.status,
      runId: options.manifest.runId,
    },
  });
  return key;
}

export function runPrefix(startedAt: string, runId: string): string {
  const date = startedAt.slice(0, 10).replaceAll("-", "/");
  return `raw/sbi-securities/${date}/${runId}`;
}

function safeDataset(value: string): string {
  if (!/^[a-z0-9-]+$/u.test(value)) {
    throw new Error("SBI artifact dataset contains unsafe characters");
  }
  return value;
}
