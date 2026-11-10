import type { CollectorArtifact, StoredArtifact } from "./types";

export function runPrefix(startedAt: string, runId: string): string {
  const date = startedAt.slice(0, 10).replaceAll("-", "/");
  return `raw/sbi-vc-trade/${date}/${runId}`;
}

/**
 * The manifest entry of an artifact — validated, hashed and keyed inside its
 * run — without writing it anywhere. `storeArtifact` is this plus the staging
 * put; no Worker path calls it, and the parity tests keep it as the staged
 * encoding. In shared mode (U09) the bytes go to DATA content-addressed and the
 * staging bucket is not written, so the Worker keeps this entry's dataset,
 * digest and size and replaces its run-prefix key with the content-addressed
 * object key.
 */
export async function describeArtifact(options: {
  prefix: string;
  artifact: CollectorArtifact;
}): Promise<{ record: StoredArtifact; encoded: Uint8Array }> {
  if (!/^[a-z0-9-]+$/u.test(options.artifact.dataset)) throw new Error("invalid_artifact_dataset");
  const document = options.artifact.document;
  if (
    document !== undefined &&
    (!/^\d{8}$/u.test(document.basisDate) || typeof options.artifact.body === "string")
  )
    throw new Error("invalid_document_artifact");
  if (
    document !== undefined &&
    (document.kind === "monthly-report"
      ? document.mediaType !== "application/pdf" ||
        options.artifact.dataset !== "monthly-report-pdf"
      : document.mediaType !== "application/zip" || options.artifact.dataset !== "pnl-data-zip")
  )
    throw new Error("invalid_document_artifact");
  if (document === undefined && typeof options.artifact.body !== "string")
    throw new Error("invalid_json_artifact");
  const encoded =
    typeof options.artifact.body === "string"
      ? new TextEncoder().encode(options.artifact.body)
      : options.artifact.body;
  const sha256 = await sha256Hex(encoded);
  const artifactKey =
    document === undefined
      ? undefined
      : `${document.kind}-${document.basisDate}-${sha256}.${document.mediaType === "application/pdf" ? "pdf" : "zip"}`;
  const key = `${options.prefix}/${artifactKey ?? `${options.artifact.dataset}.json`}`;
  return {
    record: {
      dataset: options.artifact.dataset,
      key,
      sha256,
      bytes: encoded.byteLength,
      ...(artifactKey === undefined ? {} : { artifactKey }),
      ...(document === undefined ? {} : { document }),
    },
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
    httpMetadata: { contentType: options.artifact.document?.mediaType ?? "application/json" },
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

async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
