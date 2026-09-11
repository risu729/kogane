// `persistRun`: the write half of "write the terminal last" (unified plan 03 §2).
//
//   1. Content-address and put every artifact, awaiting each one.
//   2. Multipart artifacts are completed before anything else continues.
//   3. Verify what R2 actually stored (size + digest) after each put.
//   4. Only then create the terminal, with a create-only conditional put.
//
// The order is the whole point: a terminal that exists means every object it
// names was written and verified. A partial failure therefore writes no
// terminal at all and returns a checkpoint, so the caller resumes from R2
// instead of logging into the bank again.
//
// Idempotency (03 §3): same run + same digest is a resend, not a second run;
// same run + different digest is a conflict and nothing is overwritten. R2's
// `etagDoesNotMatch: "*"` makes the create-only put atomic; the HEAD-then-
// compare path below still runs, so the helper is correct on any R2
// implementation whether or not it honours the wildcard condition.
import {
  hexToBytes,
  type R2BucketLike,
  type R2MultipartUploadLike,
  type R2ObjectLike,
  type R2UploadedPartLike,
} from "./bucket";
import { encodeTerminal, sha256Hex, terminalDigest } from "./digest";
import { objectKey, terminalKey } from "./keys";
import {
  parseTerminalManifest,
  TERMINAL_MANIFEST_VERSION,
  tryParseTerminalManifest,
  type TerminalArtifact,
  type TerminalManifest,
  type TerminalRunFields,
} from "./manifest";
import {
  objectMetadata,
  OBJECT_CONTENT_TYPE,
  TERMINAL_CONTENT_TYPE,
  verifyStoredObject,
} from "./verify";

export type PersistBody =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  /** Parts are uploaded in order and completed before the run continues. */
  | { readonly kind: "multipart"; readonly parts: readonly Uint8Array[] };

export interface PersistArtifact {
  readonly artifactKey: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly role: string;
  readonly unitKey?: string;
  readonly body: PersistBody;
}

export interface PersistRunPlan {
  /** Everything the terminal states about the run except `artifacts`. */
  readonly run: TerminalRunFields;
  readonly artifacts: readonly PersistArtifact[];
}

export interface PersistedObject {
  readonly artifactKey: string;
  readonly key: string;
  readonly sha256: string;
  readonly byteSize: number;
  /** True when the object was already in the bucket and verified rather than written. */
  readonly reused: boolean;
}

/** What a caller needs to resume without re-fetching from the provider. */
export interface PersistCheckpoint {
  readonly source: string;
  readonly runId: string;
  readonly terminalKey: string;
  readonly persistedKeys: readonly string[];
  readonly persistedArtifactKeys: readonly string[];
  readonly pendingArtifactKeys: readonly string[];
}

export type PersistRunResult =
  | {
      readonly outcome: "persisted";
      readonly terminalKey: string;
      readonly terminalDigest: string;
      readonly manifest: TerminalManifest;
      readonly checkpoint: PersistCheckpoint;
      readonly objects: readonly PersistedObject[];
    }
  | {
      readonly outcome: "already_persisted";
      readonly terminalKey: string;
      readonly terminalDigest: string;
      readonly manifest: TerminalManifest;
      readonly checkpoint: PersistCheckpoint;
      readonly objects: readonly PersistedObject[];
    }
  | {
      readonly outcome: "conflict";
      readonly terminalKey: string;
      readonly terminalDigest: string;
      /** Digest of the terminal already in the bucket, or null when it cannot be read. */
      readonly storedDigest: string | null;
      readonly reasonCode: string;
    }
  | {
      readonly outcome: "incomplete";
      readonly terminalKey: string;
      readonly terminalDigest: string;
      readonly reasonCode: string;
      readonly failedArtifactKey: string | null;
      readonly checkpoint: PersistCheckpoint;
      readonly objects: readonly PersistedObject[];
    };

export interface PersistRunOptions {
  /**
   * Hash every body before writing it. On by default: it is the only check
   * that catches a collector whose declared digest does not describe the bytes
   * it is about to store under that digest's key.
   */
  readonly verifyBodyDigest?: boolean;
}

export class PersistRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PersistRunError";
  }
}

/** Build the manifest a plan describes, without writing anything. */
export function planManifest(plan: PersistRunPlan): TerminalManifest {
  const artifacts: TerminalArtifact[] = plan.artifacts.map((artifact) => ({
    artifactKey: artifact.artifactKey,
    storageRef: { store: "DATA", key: objectKey(artifact.sha256) },
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    mediaType: artifact.mediaType,
    role: artifact.role,
    ...(artifact.unitKey === undefined ? {} : { unitKey: artifact.unitKey }),
  }));
  return parseTerminalManifest({
    ...plan.run,
    manifestVersion: TERMINAL_MANIFEST_VERSION,
    artifacts,
  });
}

function bodyBytes(body: PersistBody): Uint8Array {
  if (body.kind === "bytes") return body.bytes;
  const total = body.parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of body.parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function checkpoint(
  manifest: TerminalManifest,
  done: readonly PersistedObject[],
  terminalWritten: boolean,
): PersistCheckpoint {
  const persistedArtifactKeys = done.map((entry) => entry.artifactKey);
  const persisted = new Set(persistedArtifactKeys);
  const key = terminalKey(manifest.source, manifest.runId);
  return {
    source: manifest.source,
    runId: manifest.runId,
    terminalKey: key,
    persistedKeys: [...done.map((entry) => entry.key), ...(terminalWritten ? [key] : [])],
    persistedArtifactKeys,
    pendingArtifactKeys: manifest.artifacts
      .map((artifact) => artifact.artifactKey)
      .filter((artifactKey) => !persisted.has(artifactKey)),
  };
}

async function putArtifact(
  bucket: R2BucketLike,
  artifact: PersistArtifact,
  bytes: Uint8Array,
): Promise<PersistedObject | { readonly error: string }> {
  const key = objectKey(artifact.sha256);
  const expected = { sha256: artifact.sha256, byteSize: artifact.byteSize };
  const persisted = (reused: boolean): PersistedObject => ({
    artifactKey: artifact.artifactKey,
    key,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    reused,
  });

  // A retry after a lost put response finds the object already there. Verify
  // it and reuse; never write different bytes under the same digest key.
  const existing = await bucket.head(key);
  if (existing) {
    const problem = verifyStoredObject(existing, expected);
    return problem === null ? persisted(true) : { error: problem };
  }

  let stored: R2ObjectLike | null;
  if (artifact.body.kind === "multipart") {
    const outcome = await putMultipart(bucket, key, artifact, expected);
    if ("error" in outcome) return outcome;
    stored = outcome.object;
  } else {
    try {
      stored = await bucket.put(key, ownedBuffer(bytes), {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: hexToBytes(artifact.sha256).buffer as ArrayBuffer,
        httpMetadata: { contentType: OBJECT_CONTENT_TYPE },
        customMetadata: objectMetadata(expected),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        error: /sha.?256|checksum|digest/iu.test(message)
          ? "object_checksum_rejected"
          : "object_put_failed",
      };
    }
  }

  if (!stored) {
    // The conditional put lost a race; the winner's bytes decide.
    const winner = await bucket.head(key);
    const problem = verifyStoredObject(winner, expected);
    return problem === null ? persisted(true) : { error: problem };
  }
  const problem = verifyStoredObject(stored, expected);
  return problem === null ? persisted(false) : { error: problem };
}

async function putMultipart(
  bucket: R2BucketLike,
  key: string,
  artifact: PersistArtifact,
  expected: { sha256: string; byteSize: number },
): Promise<{ object: R2ObjectLike } | { error: string }> {
  if (artifact.body.kind !== "multipart") throw new PersistRunError("not_multipart");
  let upload: R2MultipartUploadLike;
  try {
    upload = await bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: OBJECT_CONTENT_TYPE },
      customMetadata: objectMetadata(expected),
    });
  } catch {
    return { error: "multipart_create_failed" };
  }
  const parts: R2UploadedPartLike[] = [];
  try {
    for (const [index, part] of artifact.body.parts.entries()) {
      parts.push(await upload.uploadPart(index + 1, ownedBuffer(part)));
    }
    // `complete` is awaited here, so nothing downstream — least of all the
    // terminal — can observe a half-uploaded object.
    return { object: await upload.complete(parts) };
  } catch {
    try {
      await upload.abort();
    } catch {
      // An abort failure leaves an incomplete upload, which is inert: it has
      // no object key and the run is reported incomplete either way.
    }
    return { error: "multipart_incomplete" };
  }
}

interface StoredTerminal {
  readonly digest: string | null;
  readonly reasonCode: string | null;
}

async function readStoredTerminal(bucket: R2BucketLike, key: string): Promise<StoredTerminal> {
  const body = await bucket.get(key);
  if (!body) return { digest: null, reasonCode: "terminal_vanished" };
  let text: string;
  try {
    text = new TextDecoder().decode(new Uint8Array(await body.arrayBuffer()));
  } catch {
    return { digest: null, reasonCode: "terminal_unreadable" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { digest: null, reasonCode: "terminal_not_json" };
  }
  const parsed = tryParseTerminalManifest(value);
  if (!parsed.ok) return { digest: null, reasonCode: parsed.code };
  return { digest: await terminalDigest(parsed.manifest), reasonCode: null };
}

/**
 * Persist one acquisition run into the shared DATA bucket and finish it with
 * its terminal. See the module comment for the ordering guarantee.
 */
export async function persistRun(
  bucket: R2BucketLike,
  plan: PersistRunPlan,
  options: PersistRunOptions = {},
): Promise<PersistRunResult> {
  const manifest = planManifest(plan);
  const key = terminalKey(manifest.source, manifest.runId);
  const bytes = encodeTerminal(manifest);
  const digest = await sha256Hex(bytes);

  const byArtifactKey = new Map(plan.artifacts.map((artifact) => [artifact.artifactKey, artifact]));
  if (byArtifactKey.size !== plan.artifacts.length)
    throw new PersistRunError("duplicate_artifact_key");

  // Same run written again: compare digests before touching anything.
  const existingTerminal = await bucket.head(key);
  if (existingTerminal) {
    const stored = await readStoredTerminal(bucket, key);
    if (stored.digest === digest) {
      return {
        outcome: "already_persisted",
        terminalKey: key,
        terminalDigest: digest,
        manifest,
        checkpoint: checkpoint(manifest, referencedObjects(manifest), true),
        objects: referencedObjects(manifest),
      };
    }
    return {
      outcome: "conflict",
      terminalKey: key,
      terminalDigest: digest,
      storedDigest: stored.digest,
      reasonCode: stored.reasonCode ?? "terminal_digest_mismatch",
    };
  }

  const done: PersistedObject[] = [];
  for (const artifact of manifest.artifacts) {
    const source = byArtifactKey.get(artifact.artifactKey);
    if (!source) throw new PersistRunError("missing_artifact_body");
    const body = bodyBytes(source.body);
    if (body.byteLength !== artifact.byteSize) {
      return incomplete(
        manifest,
        digest,
        key,
        done,
        "artifact_size_mismatch",
        artifact.artifactKey,
      );
    }
    if (options.verifyBodyDigest !== false && (await sha256Hex(body)) !== artifact.sha256) {
      return incomplete(
        manifest,
        digest,
        key,
        done,
        "artifact_digest_mismatch",
        artifact.artifactKey,
      );
    }
    const result = await putArtifact(bucket, source, body);
    if ("error" in result) {
      return incomplete(manifest, digest, key, done, result.error, artifact.artifactKey);
    }
    done.push(result);
  }

  let stored: R2ObjectLike | null;
  try {
    stored = await bucket.put(key, ownedBuffer(bytes), {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: hexToBytes(digest).buffer as ArrayBuffer,
      httpMetadata: { contentType: TERMINAL_CONTENT_TYPE },
      customMetadata: {
        sha256: digest,
        byteSize: String(bytes.byteLength),
        terminalDigest: digest,
        source: manifest.source,
        runId: manifest.runId,
        providerOutcome: manifest.providerOutcome,
      },
    });
  } catch {
    return incomplete(manifest, digest, key, done, "terminal_put_failed", null);
  }
  if (!stored) {
    // Another writer created the terminal between the HEAD and the put.
    const winner = await readStoredTerminal(bucket, key);
    if (winner.digest === digest) {
      return {
        outcome: "already_persisted",
        terminalKey: key,
        terminalDigest: digest,
        manifest,
        checkpoint: checkpoint(manifest, done, true),
        objects: done,
      };
    }
    return {
      outcome: "conflict",
      terminalKey: key,
      terminalDigest: digest,
      storedDigest: winner.digest,
      reasonCode: winner.reasonCode ?? "terminal_digest_mismatch",
    };
  }
  const problem = verifyStoredObject(stored, { sha256: digest, byteSize: bytes.byteLength });
  if (problem !== null) return incomplete(manifest, digest, key, done, problem, null);

  return {
    outcome: "persisted",
    terminalKey: key,
    terminalDigest: digest,
    manifest,
    checkpoint: checkpoint(manifest, done, true),
    objects: done,
  };
}

function referencedObjects(manifest: TerminalManifest): PersistedObject[] {
  return manifest.artifacts.map((artifact) => ({
    artifactKey: artifact.artifactKey,
    key: artifact.storageRef.key,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    reused: true,
  }));
}

function incomplete(
  manifest: TerminalManifest,
  digest: string,
  key: string,
  done: readonly PersistedObject[],
  reasonCode: string,
  failedArtifactKey: string | null,
): PersistRunResult {
  return {
    outcome: "incomplete",
    terminalKey: key,
    terminalDigest: digest,
    reasonCode,
    failedArtifactKey,
    checkpoint: checkpoint(manifest, done, false),
    objects: done,
  };
}
