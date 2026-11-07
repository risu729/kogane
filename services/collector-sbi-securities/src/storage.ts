import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Artifact, ArtifactManifest } from "./types";

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

function safeDataset(value: string): string {
  if (!/^[a-z0-9-]+$/u.test(value)) {
    throw new Error("SBI artifact dataset contains unsafe characters");
  }
  return value;
}
