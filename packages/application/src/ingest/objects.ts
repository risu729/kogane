// Raw objects: storing the bytes and verifying that they are still there.
//
// The bytes go to the object store and the row goes to CORE, in that order:
// a row that names bytes nobody stored would be a false completeness claim.
// The store write is conditional (`etagDoesNotMatch: "*"`) and the result is
// verified against the declared digest and size, so two producers uploading
// the same bytes converge and a producer uploading different bytes under the
// same name is refused rather than silently winning.
//
// Extracted from `services/raw-evidence/src/store.ts` by U05.
import {
  insertRawObjectIfAbsent,
  insertVerificationEvent,
  readRawObjectLocation,
  readRawObjectRecord,
  readRecentVerification,
  runCataloguesObject,
} from "../../../storage-d1/src/core/raw-objects.ts";
import { loadRun } from "./access.ts";
import {
  assertSame,
  IngestError,
  SHA256,
  type EvidenceBucketLike,
  type IngestEnv,
  type StoredObjectLike,
} from "./contract.ts";

const DEFAULT_MAX_OBJECT_BYTES = 50 * 1024 * 1024;
/** A verification this client made less than five minutes ago is reused. */
const VERIFICATION_REUSE_MS = 300_000;

/** The object-store key of a content-addressed object. */
export function blobKeyFor(sha256: string): string {
  return `objects/${sha256.slice(0, 2)}/${sha256}`;
}

/** The 32 bytes a hex sha256 denotes, for the store's own checksum check. */
export function hexBytes(value: string): Uint8Array {
  if (!SHA256.test(value)) {
    throw new TypeError("invalid sha256");
  }
  return Uint8Array.from(value.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}

/** What the caller hands over with the bytes; both sizes are compared. */
export interface ObjectUpload {
  /** `x-kogane-byte-size`: the size the producer declares. */
  declaredByteSize: string | null;
  /** `content-length`: the size the transport reports. */
  transportByteSize: string | null;
  body: ReadableStream | ArrayBuffer | ArrayBufferView | null;
}

export interface StoredObject {
  sha256: string;
  byteSize: number;
  reused: boolean;
  recordedBy: string;
  authorizedByRunId: number;
}

export async function putObject(
  env: IngestEnv,
  clientId: string,
  runId: number,
  sha256: string,
  upload: ObjectUpload,
): Promise<StoredObject> {
  await loadRun(env, clientId, runId);
  if (!SHA256.test(sha256)) throw new IngestError(400, "invalid_sha256");
  const sizeHeader = upload.declaredByteSize;
  const contentLength = upload.transportByteSize;
  if (!sizeHeader || !contentLength || !/^\d+$/.test(sizeHeader) || !/^\d+$/.test(contentLength)) {
    throw new IngestError(411, "byte_size_required");
  }
  const byteSize = Number(sizeHeader);
  const maxObjectBytes = Number(env.MAX_OBJECT_BYTES ?? DEFAULT_MAX_OBJECT_BYTES);
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0) {
    throw new IngestError(503, "object_limit_configuration_invalid");
  }
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maxObjectBytes) {
    throw new IngestError(413, "object_too_large");
  }
  if (Number(contentLength) !== byteSize) {
    throw new IngestError(400, "byte_size_mismatch");
  }

  const blobKey = blobKeyFor(sha256);
  let reused = false;
  const existing = await env.EVIDENCE.head(blobKey);
  if (existing) {
    verifyStoredObject(existing, sha256, byteSize);
    reused = true;
  } else {
    let stored: StoredObjectLike | null;
    try {
      stored = await env.EVIDENCE.put(blobKey, upload.body ?? new Uint8Array(), {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: hexBytes(sha256),
        customMetadata: { sha256, byteSize: String(byteSize) },
        httpMetadata: { contentType: "application/octet-stream" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/sha.?256|checksum|digest/i.test(message)) {
        throw new IngestError(422, "object_checksum_mismatch");
      }
      throw error;
    }
    if (!stored) {
      const winner = await env.EVIDENCE.head(blobKey);
      if (!winner) throw new IngestError(409, "r2_object_race_conflict");
      verifyStoredObject(winner, sha256, byteSize);
      reused = true;
    } else {
      verifyStoredObject(stored, sha256, byteSize, 422, "object_checksum_mismatch");
    }
  }

  const now = Date.now();
  await insertRawObjectIfAbsent(env.DB, sha256, byteSize, blobKey, now);
  const row = await readRawObjectRecord(env.DB, sha256);
  assertSame(row, { sha256, byte_size: byteSize, blob_key: blobKey }, "raw_object_conflict");
  return { sha256, byteSize, reused, recordedBy: clientId, authorizedByRunId: runId };
}

function verifyStoredObject(
  object: StoredObjectLike,
  sha256: string,
  byteSize: number,
  status = 409,
  code = "r2_object_conflict",
): void {
  const nativeSha256 = object.checksums.sha256;
  const nativeHex = nativeSha256 ? hex(nativeSha256) : null;
  if (
    object.size !== byteSize ||
    object.customMetadata?.sha256 !== sha256 ||
    object.customMetadata?.byteSize !== String(byteSize) ||
    nativeHex !== sha256 ||
    object.httpMetadata?.contentType !== "application/octet-stream"
  ) {
    throw new IngestError(status, code);
  }
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface VerificationOutcome {
  verificationEventId: number;
  sha256: string;
  result: string;
  reused: boolean;
}

/**
 * Re-reads the stored bytes and appends the outcome. The event is recorded
 * whatever the outcome is: "we looked and it was gone" is exactly the fact
 * that must survive, so nothing here deletes or rewrites the row it found.
 */
export async function verifyObject(
  env: IngestEnv,
  clientId: string,
  runId: number,
  sha256: string,
): Promise<VerificationOutcome> {
  await loadRun(env, clientId, runId);
  if (!SHA256.test(sha256)) throw new IngestError(400, "invalid_sha256");
  if (!(await runCataloguesObject(env.DB, runId, sha256)))
    throw new IngestError(404, "raw_object_not_found");
  const row = await readRawObjectLocation(env.DB, sha256);
  if (!row) throw new IngestError(404, "raw_object_not_found");
  const recent = await readRecentVerification(
    env.DB,
    sha256,
    clientId,
    Date.now() - VERIFICATION_REUSE_MS,
  );
  if (recent) {
    return { verificationEventId: recent.id, sha256, result: recent.result, reused: true };
  }
  let result: "ok" | "missing" | "size_mismatch" | "hash_mismatch" | "read_error";
  let observedSize: number | null = null;
  let observedSha256: string | null = null;
  let detailCode: string | null = null;
  try {
    const stored = await env.EVIDENCE.head(row.blob_key);
    if (!stored) {
      result = "missing";
    } else {
      observedSize = stored.size;
      const native = stored.checksums.sha256;
      observedSha256 = native ? hex(native) : null;
      if (observedSize !== row.byte_size) result = "size_mismatch";
      else if (observedSha256 === null) {
        result = "read_error";
        detailCode = "native_checksum_unavailable";
      } else if (observedSha256 !== sha256) result = "hash_mismatch";
      else if (
        stored.customMetadata?.sha256 !== sha256 ||
        stored.customMetadata?.byteSize !== String(row.byte_size) ||
        stored.httpMetadata?.contentType !== "application/octet-stream"
      ) {
        result = "read_error";
        detailCode = "metadata_mismatch";
      } else result = "ok";
    }
  } catch {
    result = "read_error";
    detailCode = "r2_head_failed";
  }
  const now = Date.now();
  const inserted = await insertVerificationEvent(env.DB, {
    sha256,
    now,
    result,
    observedSize,
    observedSha256,
    detailCode,
    clientId,
  });
  return { verificationEventId: inserted!.id, sha256, result, reused: false };
}

/** The bucket type the adapter must satisfy, re-exported for the adapters. */
export type { EvidenceBucketLike };
