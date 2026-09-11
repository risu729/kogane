// The shared DATA-bucket write path for the SBI VC Trade collector (U09).
//
// In `shared` mode the session Durable Object persists the run itself: every
// gateway response it already sanitized, plus the collector manifest, written
// content-addressed into DATA with the `terminal-v1` manifest last, by
// `packages/collection`. The upload to `kogane-collector-r2-importer` is then
// skipped, so the Processor reads the collector's own bytes instead of a copy
// (plan 03 §1, G1-15). It also removes the legacy path's deferral: there is no
// service binding in the chain, so a run with many historical pages finishes
// in one invocation instead of being handed to the backfill route.
//
// The bytes are the ones `collectSbiVcTrade` already stripped of `secureKey`
// before the staging write, which is exactly what the importer forwards
// centrally today. The session cookies, the session encryption key, the
// passkey credential and the admin token are never part of a plan: only the
// session *generation* reference reaches the terminal, and that is an opaque
// id minted in the Durable Object, never session material (12 §4).
import {
  persistRun,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalRunFields,
  type TerminalTransformation,
} from "../../../packages/collection/src/index";
import type { CollectionFailure, CollectionManifest, HealthState, SharedRunSummary } from "./types";

export type { SharedRunSummary };

/** `runs/<source>/…` in DATA; the CORE source id is the same string. */
export const SHARED_SOURCE = "sbi-vc-trade";
const PRODUCER = "collector-sbi-vc-trade";
const MANIFEST_ARTIFACT_KEY = "manifest.json";
const JSON_MEDIA_TYPE = "application/json";
/** The single unit the central descriptors already use for this source. */
const UNIT_KEY = "account";
const UNIT_KIND = "collection";

export const COLLECTOR_DERIVED_ROLE = "collector_derived";
export const COLLECTOR_MANIFEST_ROLE = "collector_manifest";

/** The run could not start because the session needs a person, not a retry. */
export const HUMAN_REQUIRED_CODE = "human_required_reauth";
/** The session is unhealthy for a reason re-authentication may still fix. */
export const SESSION_UNHEALTHY_CODE = "session_unhealthy";

const encoder = new TextEncoder();

/** One already-sanitized gateway response, as it was staged. */
export interface SharedCapture {
  readonly dataset: string;
  readonly body: string;
}

/** Where the ops API's operation and this attempt enter the terminal (03 §3). */
export interface SharedRunIdentity {
  readonly operationId?: string;
  readonly attemptId: string;
  /**
   * The generation of the authenticated session this run used. It links the
   * per-source runs of one acquisition session without putting any session
   * material in the terminal (03 §3, 12 §4).
   */
  readonly acquisitionSessionRef?: string;
}

export interface SharedRunInput {
  readonly manifest: CollectionManifest;
  /** The exact manifest bytes written to the staging bucket. */
  readonly manifestJson: string;
  readonly captures: readonly SharedCapture[];
  readonly identity: SharedRunIdentity;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function artifactOf(options: {
  artifactKey: string;
  bytes: Uint8Array;
  role: string;
}): Promise<PersistArtifact> {
  return {
    artifactKey: options.artifactKey,
    sha256: await sha256Hex(options.bytes),
    byteSize: options.bytes.byteLength,
    mediaType: JSON_MEDIA_TYPE,
    role: options.role,
    unitKey: UNIT_KEY,
    body: { kind: "bytes", bytes: options.bytes },
  };
}

/**
 * A revoked or expired session that re-authentication did not restore needs a
 * person: the passkey must be re-registered or the account unblocked. The
 * collector never retries a login past its single cooled-down attempt, so this
 * is reported rather than worked around (12 §3, G3-10, G3-11).
 */
export function waitingForHuman(health: HealthState): boolean {
  if (health.lastReauthErrorCode !== null) return true;
  // Authentication was refused and re-authentication is still in its cooldown,
  // so nothing will try again on its own.
  return (
    (health.lastHttpStatus === 401 || health.lastHttpStatus === 403) &&
    health.lastReauthSuccessAt === null
  );
}

/** The safe code for a run that never started because the session was unusable. */
export function blockedErrorCode(health: HealthState): string {
  return waitingForHuman(health) ? HUMAN_REQUIRED_CODE : SESSION_UNHEALTHY_CODE;
}

/** A `partial` run stays partial and a `failed` run never claims coverage. */
export function sharedOutcome(manifest: CollectionManifest): {
  providerOutcome: ProviderOutcome;
  coverageStatus: CoverageStatus;
  safeErrorCode?: string;
} {
  if (manifest.status === "success") {
    // The collector walks every historical page to exhaustion and verifies the
    // provider's own pagination totals, so the requested snapshot is complete.
    return { providerOutcome: "success", coverageStatus: "complete" };
  }
  return {
    providerOutcome: manifest.status === "partial" ? "partial" : "failed",
    coverageStatus: manifest.status === "partial" ? "partial" : "unknown",
    safeErrorCode: safeFailureCode(manifest.failures[0]),
  };
}

function safeFailureCode(failure: CollectionFailure | undefined): string {
  return failure?.errorCode ?? "collector_run_incomplete";
}

function runFields(input: SharedRunInput, transformations: TerminalTransformation[]) {
  const outcome = sharedOutcome(input.manifest);
  const fields: TerminalRunFields = {
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
      scopeKind: "full_snapshot",
      startValue: null,
      endValue: null,
      unitKeys: [UNIT_KEY],
    },
    startedAt: input.manifest.startedAt,
    completedAt: input.manifest.completedAt,
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
    ranges: [],
    reports: [],
    transformations,
  };
  return fields;
}

/**
 * The `terminal-v1` plan for one run: the manifest plus one artifact per
 * collected dataset. A `failed` run with nothing collected plans the manifest
 * alone, so the failure stays a failure instead of reading downstream like a
 * complete observation of an empty account (G1-09).
 */
export async function buildSharedRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  const staged = new Map(input.captures.map((capture) => [capture.dataset, capture.body]));
  const artifacts: PersistArtifact[] = [];
  const transformations: TerminalTransformation[] = [];
  for (const entry of input.manifest.artifacts) {
    const body = staged.get(entry.dataset);
    if (body === undefined) throw new Error("shared_capture_missing");
    const artifactKey = `${entry.dataset}.json`;
    artifacts.push(
      await artifactOf({
        artifactKey,
        bytes: encoder.encode(body),
        role: COLLECTOR_DERIVED_ROLE,
      }),
    );
    transformations.push({
      transformationId: `${artifactKey}:redacted`,
      stepKind: "redacted",
      transformerId: "sbi-vc-trade-worker",
      transformerVersion: input.manifest.schemaVersion,
      // The unredacted gateway envelope carried the session `secureKey` and is
      // never retained, so it has no artifact key.
      inputArtifactKeys: [],
      outputArtifactKey: artifactKey,
    });
  }
  artifacts.push(
    await artifactOf({
      artifactKey: MANIFEST_ARTIFACT_KEY,
      bytes: encoder.encode(input.manifestJson),
      role: COLLECTOR_MANIFEST_ROLE,
    }),
  );
  return { run: runFields(input, transformations), artifacts };
}

/**
 * Persists one run into DATA. Objects first, terminal last: an `incomplete`
 * result means no terminal exists and the run is not reported persisted
 * (G1-01). Nothing here re-authenticates or re-reads the provider.
 */
export async function persistSharedRun(
  bucket: R2BucketLike,
  input: SharedRunInput,
  options: { readonly waitingForHuman?: boolean } = {},
): Promise<SharedRunSummary> {
  const plan = await buildSharedRunPlan(input);
  const result = await persistRun(bucket, plan);
  return {
    target: "shared",
    outcome: result.outcome,
    terminalKey: result.terminalKey,
    terminalDigest: result.terminalDigest,
    objectCount: result.outcome === "conflict" ? 0 : result.objects.length,
    waitingForHuman: options.waitingForHuman === true,
    ...(result.outcome === "conflict" || result.outcome === "incomplete"
      ? { reasonCode: result.reasonCode }
      : {}),
  };
}

/** `persisted` and `already_persisted` are the only completion outcomes. */
export function sharedRunPersisted(summary: SharedRunSummary): boolean {
  return summary.outcome === "persisted" || summary.outcome === "already_persisted";
}

/**
 * The manifest of a collection that never started because the session was
 * unusable. It is a real run with a real terminal: the operations API has to
 * see that the scheduled collection did not happen and why, and a blocked run
 * must not look like a successful observation of an empty account (G3-10,
 * G3-11). It carries no artifact other than its own manifest.
 */
export function blockedRunManifest(options: {
  schemaVersion: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  errorCode: string;
}): CollectionManifest {
  return {
    schemaVersion: options.schemaVersion,
    source: SHARED_SOURCE,
    runId: options.runId,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    status: "failed",
    artifacts: [],
    failures: [{ operation: "load_session", errorCode: options.errorCode }],
  };
}

/**
 * The Workers `R2Bucket` binding seen through the contract's minimal surface.
 * They are the same object: `R2BucketLike` names exactly the five methods
 * `persistRun` calls.
 */
export function dataBucket(bucket: R2Bucket): R2BucketLike {
  return bucket as unknown as R2BucketLike;
}
