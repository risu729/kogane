import type { CollectionManifest, RawArtifact, StoredArtifact } from "./types";

export function runPrefix(startedAt: string, runId: string): string {
  const date = startedAt.slice(0, 10).replaceAll("-", "/");
  return `raw/myjcb/${date}/${runId}`;
}

export async function storeArtifact(options: {
  bucket: R2Bucket;
  prefix: string;
  connectionId: string;
  artifact: RawArtifact;
}): Promise<StoredArtifact> {
  assertSegment(options.connectionId, "connection ID");
  assertSegment(options.artifact.dataset, "dataset");
  if (!/^[a-z0-9.-]+$/u.test(options.artifact.filename)) {
    throw new Error("MyJCB artifact filename contains unsafe characters");
  }
  const bytes =
    typeof options.artifact.body === "string"
      ? new TextEncoder().encode(options.artifact.body)
      : new Uint8Array(options.artifact.body);
  const sha256 = await sha256Hex(bytes);
  const key = `${options.prefix}/${options.connectionId}/${options.artifact.filename}`;
  await options.bucket.put(key, options.artifact.body, {
    httpMetadata: { contentType: options.artifact.mediaType },
    customMetadata: {
      source: "myjcb",
      dataset: options.artifact.dataset,
      sha256,
      ...(options.artifact.statementState
        ? { statementState: options.artifact.statementState }
        : {}),
      ...(options.artifact.period ? { period: options.artifact.period } : {}),
    },
  });
  return {
    dataset: options.artifact.dataset,
    key,
    mediaType: options.artifact.mediaType,
    sha256,
    bytes: bytes.byteLength,
    ...(options.artifact.statementState ? { statementState: options.artifact.statementState } : {}),
    ...(options.artifact.period ? { period: options.artifact.period } : {}),
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
      source: "myjcb",
      status: options.manifest.status,
      runId: options.manifest.runId,
    },
  });
  return key;
}

function assertSegment(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) {
    throw new Error(`MyJCB ${label} contains unsafe characters`);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
