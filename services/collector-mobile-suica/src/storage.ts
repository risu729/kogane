import type { RawArtifact, StoredArtifact } from "./types";

export async function storeArtifact(options: {
  bucket: R2Bucket;
  prefix: string;
  runId: string;
  artifact: RawArtifact;
}): Promise<StoredArtifact> {
  if (!/^[a-z0-9-]+$/u.test(options.artifact.dataset)) throw new Error("Unsafe dataset name");
  if (!/^[a-z0-9.-]+$/u.test(options.artifact.filename))
    throw new Error("Unsafe artifact filename");
  const bytes =
    typeof options.artifact.body === "string"
      ? new TextEncoder().encode(options.artifact.body)
      : options.artifact.body;
  const sha256 = await sha256Hex(bytes);
  const key = `${options.prefix}/${options.artifact.filename}`;
  await options.bucket.put(key, options.artifact.body, {
    httpMetadata: { contentType: options.artifact.mediaType },
    customMetadata: {
      source: "mobile-suica",
      runId: options.runId,
      dataset: options.artifact.dataset,
      sha256,
    },
  });
  return {
    dataset: options.artifact.dataset,
    key,
    mediaType: options.artifact.mediaType,
    sha256,
    bytes: bytes.byteLength,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
