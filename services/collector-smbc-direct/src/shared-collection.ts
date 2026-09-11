// The shared DATA-bucket write path for the SMBC Direct backfill collector (U09).
//
// This source is human-triggered: a person approves a QR challenge, and the
// backfill then runs across many Durable Object alarms, one month chunk at a
// time. The run is finished exactly once — when the last chunk lands, or when
// the run fails — and that is where the `terminal-v1` manifest is written, last
// and only once, so one backfill produces one terminal (plan 03 §2).
//
// Because the chunks are written across alarms, the bytes are re-read from the
// collector's own staging bucket at that point and verified against the
// manifest before anything is planned. That is the same staging bucket the
// importer reads today; it is the collector's outbox, not a second central
// copy, and it goes away with the legacy route in U15.
//
// What is planned is exactly what the importer forwards centrally today: the
// provider's own response bytes and the collector's normalized counterparts,
// verbatim, plus the collector manifest. The SMBC credential, the encrypted
// session envelope, the challenge state and the page cookies are Durable
// Object state and never enter a plan; only the opaque session *generation*
// reference reaches the terminal (12 §4).
import {
  persistRun,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalRange,
  type TerminalRunFields,
  type TerminalTransformation,
} from "../../../packages/collection/src/index";
import { sha256Hex } from "./storage";
import type { BackfillManifest, BackfillProgress, StoredArtifact } from "./types";

/** `runs/<source>/…` in DATA. The Processor maps it to the CORE source `smbc-bank`. */
export const SHARED_SOURCE = "smbc-direct";
const PRODUCER = "collector-smbc-direct";
const MANIFEST_ARTIFACT_KEY = "manifest.json";
const JSON_MEDIA_TYPE = "application/json";
/** The single unit the central descriptors already use for this source. */
const UNIT_KEY = "account";
const UNIT_KIND = "collection";

export const PROVIDER_RESPONSE_ROLE = "provider_response";
export const COLLECTOR_DERIVED_ROLE = "collector_derived";
export const COLLECTOR_MANIFEST_ROLE = "collector_manifest";

/**
 * A run's bytes are held in memory while the terminal is planned. The cap stops
 * a very long backfill from failing on memory in a way that would look like a
 * storage error; exceeding it leaves no terminal and the run stays unfinished,
 * which is the honest outcome.
 */
export const MAX_SHARED_RUN_BYTES = 48 * 1024 * 1024;

/** Resuming this source always needs a fresh human approval, never a retry. */
export const HUMAN_REQUIRED_CODE = "human_required_approval";

export class SharedCollectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SharedCollectionError";
  }
}

const encoder = new TextEncoder();

/** Where the ops API's operation and this attempt enter the terminal (03 §3). */
export interface SharedRunIdentity {
  readonly operationId?: string;
  readonly attemptId: string;
  /**
   * The generation of the authenticated session that opened this backfill. A
   * resumed run keeps the generation it started with; the Durable Object tracks
   * the live one separately. Only the opaque id travels (12 §4).
   */
  readonly acquisitionSessionRef?: string;
}

/**
 * An incomplete backfill can only continue after a person approves a new
 * challenge: this source has no unattended re-authentication at all, and none
 * was added (12 §3, G3-10, G3-11).
 */
export function waitingForHuman(manifest: BackfillManifest): boolean {
  return manifest.status !== "success";
}

/** True while the person who started the backfill still has to act. */
export function progressWaitingForHuman(progress: BackfillProgress): boolean {
  return (
    progress.phase === "waiting_for_approval" ||
    progress.phase === "failed" ||
    progress.phase === "partial" ||
    progress.lastErrorCode === "approval_not_completed_generate_new_qr"
  );
}

/** A `partial` run stays partial and a `failed` run never claims coverage. */
export function sharedOutcome(manifest: BackfillManifest): {
  providerOutcome: ProviderOutcome;
  coverageStatus: CoverageStatus;
  safeErrorCode?: string;
} {
  if (manifest.status === "success") {
    // Every requested month chunk was collected and stored.
    return { providerOutcome: "success", coverageStatus: "complete" };
  }
  const first = manifest.failureCodes[0];
  return {
    providerOutcome: manifest.status === "partial" ? "partial" : "failed",
    coverageStatus: manifest.status === "partial" ? "partial" : "unknown",
    safeErrorCode: first === undefined || first === "session_missing" ? HUMAN_REQUIRED_CODE : first,
  };
}

/** The base media type, without parameters: a terminal names no charset. */
export function baseMediaType(value: string): string {
  const base = (value.split(";")[0] ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(base)) {
    throw new SharedCollectionError("shared_artifact_media_type_invalid");
  }
  return base;
}

/** The artifact's key inside the run, the same relative key central records. */
export function relativeArtifactKey(key: string, prefix: string): string {
  if (!key.startsWith(`${prefix}/`)) {
    throw new SharedCollectionError("shared_artifact_key_outside_run");
  }
  return key.slice(prefix.length + 1);
}

function role(artifact: StoredArtifact): string {
  return artifact.dataset.endsWith("-normalized") ? COLLECTOR_DERIVED_ROLE : PROVIDER_RESPONSE_ROLE;
}

function rangeKey(range: { start: string; end: string }): string {
  return `chunk-${range.start}-${range.end}`;
}

function ranges(manifest: BackfillManifest): TerminalRange[] {
  const entries: TerminalRange[] = [
    {
      rangeKey: "requested",
      rangeKind: "requested",
      precision: "date",
      basis: "request",
      startValue: manifest.requestedRange.start,
      endValue: manifest.requestedRange.end,
      unitKey: UNIT_KEY,
    },
  ];
  const seen = new Set<string>();
  // The raw and normalized artifacts of one month share one declared range.
  for (const artifact of manifest.artifacts) {
    if (!artifact.range) continue;
    const key = rangeKey(artifact.range);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      rangeKey: key,
      rangeKind: "declared_coverage",
      precision: "date",
      basis: "request",
      startValue: artifact.range.start,
      endValue: artifact.range.end,
      unitKey: UNIT_KEY,
    });
  }
  return entries;
}

/** Bytes a caller already read out of the staging bucket, keyed by object key. */
export type SharedArtifactBytes = ReadonlyMap<string, Uint8Array>;

export interface SharedRunInput {
  readonly manifest: BackfillManifest;
  /** The exact manifest bytes written to the staging bucket. */
  readonly manifestBytes: Uint8Array;
  readonly prefix: string;
  readonly bytesByKey: SharedArtifactBytes;
  readonly identity: SharedRunIdentity;
}

async function artifactOf(options: {
  artifactKey: string;
  bytes: Uint8Array;
  mediaType: string;
  role: string;
}): Promise<PersistArtifact> {
  return {
    artifactKey: options.artifactKey,
    sha256: await sha256Hex(options.bytes),
    byteSize: options.bytes.byteLength,
    mediaType: options.mediaType,
    role: options.role,
    unitKey: UNIT_KEY,
    body: { kind: "bytes", bytes: options.bytes },
  };
}

/**
 * The `terminal-v1` plan for one backfill run: the collector manifest plus
 * every stored artifact. A failed run with nothing stored plans the manifest
 * alone, so it stays a failure rather than reading like a complete observation
 * of an empty account (G1-09).
 */
export async function buildSharedRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  const artifacts: PersistArtifact[] = [];
  const transformations: TerminalTransformation[] = [];
  for (const [index, entry] of input.manifest.artifacts.entries()) {
    const bytes = input.bytesByKey.get(entry.key);
    if (!bytes) throw new SharedCollectionError("shared_artifact_bytes_missing");
    if (bytes.byteLength !== entry.bytes || (await sha256Hex(bytes)) !== entry.sha256) {
      throw new SharedCollectionError("shared_artifact_changed");
    }
    const artifactKey = relativeArtifactKey(entry.key, input.prefix);
    artifacts.push(
      await artifactOf({
        artifactKey,
        bytes,
        mediaType: baseMediaType(entry.mediaType),
        role: role(entry),
      }),
    );
    if (entry.dataset.endsWith("-normalized")) {
      const parent = artifactKey
        .replace(".normalized.json", ".raw.json.sjis")
        .replace("balance.normalized.json", "balance.raw.json.sjis");
      transformations.push({
        // Positional, not derived from the key: an artifact key may contain a
        // path separator, which a transformation id may not.
        transformationId: `extracted-${String(index).padStart(4, "0")}`,
        stepKind: "extracted",
        transformerId: "smbc-direct-normalizer",
        transformerVersion: input.manifest.schemaVersion,
        inputArtifactKeys: input.manifest.artifacts.some(
          (candidate) => relativeArtifactKey(candidate.key, input.prefix) === parent,
        )
          ? [parent]
          : [],
        outputArtifactKey: artifactKey,
      });
    }
  }
  artifacts.push(
    await artifactOf({
      artifactKey: MANIFEST_ARTIFACT_KEY,
      bytes: input.manifestBytes,
      mediaType: JSON_MEDIA_TYPE,
      role: COLLECTOR_MANIFEST_ROLE,
    }),
  );

  const outcome = sharedOutcome(input.manifest);
  const run: TerminalRunFields = {
    source: SHARED_SOURCE,
    producer: PRODUCER,
    producerVersion: input.manifest.schemaVersion,
    runId: input.manifest.runId,
    attemptId: input.identity.attemptId,
    ...(input.identity.operationId === undefined
      ? {}
      : { operationId: input.identity.operationId }),
    ...(input.identity.acquisitionSessionRef === undefined
      ? {}
      : { acquisitionSessionRef: input.identity.acquisitionSessionRef }),
    requestedScope: {
      scopeKind: "date_range",
      startValue: input.manifest.requestedRange.start,
      endValue: input.manifest.requestedRange.end,
      unitKeys: [UNIT_KEY],
    },
    startedAt: input.manifest.startedAt,
    completedAt: input.manifest.completedAt ?? input.manifest.startedAt,
    providerOutcome: outcome.providerOutcome,
    coverageStatus: outcome.coverageStatus,
    persistenceComplete: true,
    ...(outcome.safeErrorCode === undefined ? {} : { safeErrorCode: outcome.safeErrorCode }),
    units: [
      {
        unitKey: UNIT_KEY,
        unitKind: UNIT_KIND,
        artifactCount: input.manifest.artifacts.length,
        coverageStatus: outcome.coverageStatus,
        ...(outcome.safeErrorCode === undefined ? {} : { safeErrorCode: outcome.safeErrorCode }),
      },
    ],
    ranges: ranges(input.manifest),
    reports: [],
    transformations,
  };
  return { run, artifacts };
}

export interface SharedRunSummary {
  readonly target: "shared";
  readonly outcome: PersistRunResult["outcome"];
  readonly terminalKey: string;
  readonly terminalDigest: string;
  readonly objectCount: number;
  readonly waitingForHuman: boolean;
  readonly reasonCode?: string;
}

/**
 * Reads a finished run's artifacts back out of the staging bucket. Every object
 * is verified against the manifest before it is planned, so a run whose bytes
 * changed or vanished stops without a terminal.
 */
export async function readStagedArtifacts(
  bucket: R2BucketLike,
  manifest: BackfillManifest,
): Promise<Map<string, Uint8Array>> {
  const total = manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  if (total > MAX_SHARED_RUN_BYTES) throw new SharedCollectionError("shared_run_too_large");
  const bytesByKey = new Map<string, Uint8Array>();
  for (const artifact of manifest.artifacts) {
    const object = await bucket.get(artifact.key);
    if (!object) throw new SharedCollectionError("shared_artifact_bytes_missing");
    bytesByKey.set(artifact.key, new Uint8Array(await object.arrayBuffer()));
  }
  return bytesByKey;
}

/**
 * Persists one backfill run into DATA. Objects first, terminal last: an
 * `incomplete` result means no terminal exists and the run is not reported
 * persisted (G1-01). Nothing here re-authenticates or re-reads the provider.
 */
export async function persistSharedRun(
  bucket: R2BucketLike,
  input: SharedRunInput,
): Promise<SharedRunSummary> {
  const plan = await buildSharedRunPlan(input);
  const result = await persistRun(bucket, plan);
  return {
    target: "shared",
    outcome: result.outcome,
    terminalKey: result.terminalKey,
    terminalDigest: result.terminalDigest,
    objectCount: result.outcome === "conflict" ? 0 : result.objects.length,
    waitingForHuman: waitingForHuman(input.manifest),
    ...(result.outcome === "conflict" || result.outcome === "incomplete"
      ? { reasonCode: result.reasonCode }
      : {}),
  };
}

/** `persisted` and `already_persisted` are the only completion outcomes. */
export function sharedRunPersisted(summary: SharedRunSummary): boolean {
  return summary.outcome === "persisted" || summary.outcome === "already_persisted";
}

/** The exact staging bytes of a manifest, so the terminal names what was stored. */
export function manifestBytes(manifest: BackfillManifest): Uint8Array {
  return encoder.encode(`${JSON.stringify(manifest)}\n`);
}

/**
 * The Workers `R2Bucket` binding seen through the contract's minimal surface.
 * They are the same object: `R2BucketLike` names exactly the five methods
 * `persistRun` and the staged read call.
 */
export function dataBucket(bucket: R2Bucket): R2BucketLike {
  return bucket as unknown as R2BucketLike;
}
