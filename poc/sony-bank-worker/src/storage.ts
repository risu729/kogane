import type {
  CollectionManifest,
  RawArtifact,
  StoredArtifact,
} from "./types";

export function runPrefix(startedAt: string, runId: string): string {
  const date = startedAt.slice(0, 10).replaceAll("-", "/");
  return `raw/sony-bank/${date}/${runId}`;
}

export async function storeArtifact(options: {
  bucket: R2Bucket;
  prefix: string;
  runId: string;
  artifact: RawArtifact;
}): Promise<StoredArtifact> {
  if (!/^[a-z0-9-]+$/u.test(options.artifact.dataset)) {
    throw new Error("Sony Bank artifact dataset contains unsafe characters");
  }
  if (!/^[a-z0-9.-]+$/u.test(options.artifact.filename)) {
    throw new Error("Sony Bank artifact filename contains unsafe characters");
  }
  const bytes =
    typeof options.artifact.body === "string"
      ? new TextEncoder().encode(options.artifact.body)
      : new Uint8Array(options.artifact.body);
  const sha256 = await sha256Hex(bytes);
  const key = `${options.prefix}/${options.artifact.filename}`;
  const stored = await options.bucket.put(key, options.artifact.body, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: hexBytes(sha256),
    httpMetadata: { contentType: options.artifact.mediaType },
    customMetadata: {
      source: "sony-bank",
      runId: options.runId,
      dataset: options.artifact.dataset,
      sha256,
    },
  });
  assertStored(stored, bytes.byteLength, sha256);
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
  const bytes = new TextEncoder().encode(JSON.stringify(options.manifest));
  const sha256 = await sha256Hex(bytes);
  const stored = await options.bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: hexBytes(sha256),
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      source: options.manifest.source,
      status: options.manifest.status,
      runId: options.manifest.runId,
      sha256,
    },
  });
  assertStored(stored, bytes.byteLength, sha256);
  return key;
}

function assertStored(object: R2Object | null, bytes: number, sha256: string): void {
  const native = object?.checksums.sha256;
  const nativeHex = native
    ? [...new Uint8Array(native)].map((value) => value.toString(16).padStart(2, "0")).join("")
    : null;
  if (!object || object.size !== bytes || nativeHex !== sha256) {
    throw new Error("Sony Bank immutable R2 write was not confirmed");
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}
