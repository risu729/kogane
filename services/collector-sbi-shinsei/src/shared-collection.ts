// The shared DATA-bucket write path for the SBI Shinsei collector (U09).
//
// In `shared` mode the Worker — never the container — persists the run itself:
// every artifact it would have handed to `kogane-collector-r2-importer` is
// written content-addressed into DATA and the `terminal-v1` manifest is
// written last, by `packages/collection`. The central importer upload is then
// skipped, so the Processor reads the collector's own bytes instead of a copy
// (plan 03 §1, G1-15).
//
// What reaches DATA is the *sanitized* artifact set, not the staging bytes:
// the provider responses rotate a CSRF token in `header.newToken` and the
// collector manifest carries diagnostic failure text. Both are stripped here
// with the same rules `services/collector-r2-importer/src/sbi-shinsei.ts`
// applies before anything reaches central storage today, so the shared path
// cannot store a credential the legacy path removed. Credentials, the relay
// token and the container handoff envelope never enter a plan at all.
import {
  persistRun,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type CoverageStatus,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalRunFields,
  type TerminalTransformation,
} from "../../../packages/collection/src/index";
import type { CollectionFailure, CollectionManifest, RawArtifact } from "./types";

/** `runs/<source>/…` in DATA. The CORE source id (`sbi-shinsei-bank`) is the
 * Processor's business; a terminal names the collector's own source. */
export const SHARED_SOURCE = "sbi-shinsei";
const PRODUCER = "collector-sbi-shinsei";
const NORMALIZED_DATASET = "normalized";
const TOP_BALANCES_ARTIFACT_KEY = "raw-top-accounts-balance-and-activity.json";
const MANIFEST_ARTIFACT_KEY = "manifest.json";
const JSON_MEDIA_TYPE = "application/json";

/** The two artifact roles the central descriptors already use for this source. */
export const PROVIDER_CAPTURE_ROLE = "sanitized_provider_capture";
export const COLLECTOR_DERIVED_ROLE = "collector_derived";

/**
 * Stages at which the run stopped because a person has to act: the stored
 * credential was rejected or the login was refused. The collector never
 * retries a login and never attempts an unattended second authentication
 * (G3-10, G3-11); the run ends `failed` and says so.
 */
const HUMAN_REQUIRED_STAGES = new Set([
  "credential-shape",
  "credential-validation",
  "login-rejected",
  "login-failed",
]);
export const HUMAN_REQUIRED_CODE = "human_required_credentials";

export class SharedCollectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SharedCollectionError";
  }
}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strips the rotating CSRF token, exactly as the importer's sanitizer does. */
export function sanitizeProviderCapture(body: string | ArrayBuffer): Uint8Array {
  const text =
    typeof body === "string"
      ? body
      : new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(body));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SharedCollectionError("shared_artifact_json_invalid");
  }
  if (!isRecord(parsed)) throw new SharedCollectionError("shared_artifact_json_invalid");
  const clean: Record<string, unknown> = { ...parsed };
  if (isRecord(parsed.header)) {
    const { newToken: _newToken, ...header } = parsed.header;
    clean.header = header;
  }
  return encoder.encode(JSON.stringify(clean));
}

/** Bytes of an artifact as they are stored in DATA. */
export function sharedArtifactBytes(artifact: RawArtifact): Uint8Array {
  if (artifact.dataset === NORMALIZED_DATASET) {
    return typeof artifact.body === "string"
      ? encoder.encode(artifact.body)
      : new Uint8Array(artifact.body.slice(0));
  }
  return sanitizeProviderCapture(artifact.body);
}

/** The importer's failure-message allowlist, so no diagnostic text is stored. */
export function safeFailureMessage(failure: CollectionFailure): string {
  if (failure.operation === "collect") return "collector_request_failed";
  if (failure.operation.startsWith("r2:")) return "staging_write_failed";
  if (failure.operation === "derive:normalized") {
    return failure.errorType === "DependencyInvalid"
      ? "normalized_source_invalid"
      : "normalized_derivation_failed";
  }
  if (failure.errorType === "ResponseSchemaError") return "provider_response_invalid";
  if (failure.errorType === "NotAttempted") return "provider_read_not_attempted";
  return "provider_read_failed";
}

/** The collector manifest as central sees it: no diagnostics, no free text. */
export function sharedManifestBytes(manifest: CollectionManifest): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      source: manifest.source,
      runId: manifest.runId,
      startedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      status: manifest.status,
      liveReadsEnabled: manifest.liveReadsEnabled,
      artifacts: manifest.artifacts,
      failures: manifest.failures.map((failure) => ({
        operation: failure.operation,
        errorType: failure.errorType,
        message: safeFailureMessage(failure),
      })),
    }),
  );
}

/** True when the run stopped on something only a person can clear. */
export function waitingForHuman(failures: readonly CollectionFailure[]): boolean {
  return failures.some(
    (failure) =>
      failure.diagnostics !== undefined && HUMAN_REQUIRED_STAGES.has(failure.diagnostics.stage),
  );
}

/** A `partial` run stays partial and a `failed` run never claims coverage. */
export function sharedOutcome(manifest: CollectionManifest): {
  providerOutcome: ProviderOutcome;
  coverageStatus: CoverageStatus;
  safeErrorCode?: string;
} {
  if (manifest.status === "success") {
    return { providerOutcome: "success", coverageStatus: "complete" };
  }
  const humanRequired = waitingForHuman(manifest.failures);
  const safeErrorCode = humanRequired
    ? HUMAN_REQUIRED_CODE
    : (manifest.failures.map(safeFailureMessage)[0] ?? "collector_run_incomplete");
  return {
    providerOutcome: manifest.status === "partial" ? "partial" : "failed",
    coverageStatus: manifest.status === "partial" ? "partial" : "unknown",
    safeErrorCode,
  };
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
    body: { kind: "bytes", bytes: options.bytes },
  };
}

/** Where the ops API's operation and this attempt enter the terminal (03 §3). */
export interface SharedRunIdentity {
  readonly operationId?: string;
  readonly attemptId: string;
}

export interface SharedRunInput {
  readonly manifest: CollectionManifest;
  /** The in-memory artifacts of this run, in the order they were collected. */
  readonly artifacts: readonly RawArtifact[];
  readonly identity: SharedRunIdentity;
}

/**
 * The `terminal-v1` plan for one run: the sanitized collector manifest plus one
 * artifact per collected dataset. A `failed` run with nothing collected plans
 * the manifest alone, so the failure is recorded as a failure rather than as a
 * complete observation of nothing (G1-09).
 */
export async function buildSharedRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  const artifacts: PersistArtifact[] = [];
  const transformations: TerminalTransformation[] = [];
  const collected = new Set<string>();
  for (const artifact of input.artifacts) {
    const normalized = artifact.dataset === NORMALIZED_DATASET;
    const entry = await artifactOf({
      artifactKey: artifact.filename,
      bytes: sharedArtifactBytes(artifact),
      role: normalized ? COLLECTOR_DERIVED_ROLE : PROVIDER_CAPTURE_ROLE,
    });
    artifacts.push(entry);
    collected.add(artifact.filename);
    transformations.push(
      normalized
        ? {
            transformationId: `${artifact.filename}:extracted`,
            stepKind: "extracted",
            transformerId: "sbi-shinsei-normalizer",
            transformerVersion: "sbi-shinsei-v1",
            // Empty when the source capture failed: the manifest states the
            // lineage it has rather than inventing a parent.
            inputArtifactKeys: input.artifacts.some(
              (candidate) => candidate.filename === TOP_BALANCES_ARTIFACT_KEY,
            )
              ? [TOP_BALANCES_ARTIFACT_KEY]
              : [],
            outputArtifactKey: artifact.filename,
          }
        : {
            transformationId: `${artifact.filename}:redacted`,
            stepKind: "redacted",
            transformerId: "sbi-shinsei-token-sanitizer",
            transformerVersion: "v1",
            // The provider response is not retained: only its redaction is.
            inputArtifactKeys: [],
            outputArtifactKey: artifact.filename,
          },
    );
  }
  if (collected.size !== input.artifacts.length) {
    throw new SharedCollectionError("shared_duplicate_artifact_key");
  }
  artifacts.push(
    await artifactOf({
      artifactKey: MANIFEST_ARTIFACT_KEY,
      bytes: sharedManifestBytes(input.manifest),
      role: COLLECTOR_DERIVED_ROLE,
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
    // No acquisition session ref: this collector authenticates once per run in
    // its own container and keeps no session across runs (plan 12 §4).
    requestedScope: {
      scopeKind: "full_snapshot",
      startValue: null,
      endValue: null,
      unitKeys: [],
    },
    startedAt: input.manifest.startedAt,
    completedAt: input.manifest.completedAt,
    providerOutcome: outcome.providerOutcome,
    coverageStatus: outcome.coverageStatus,
    persistenceComplete: true,
    ...(outcome.safeErrorCode === undefined ? {} : { safeErrorCode: outcome.safeErrorCode }),
    units: [],
    ranges: [],
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
  /**
   * Where the collector manifest is in DATA (`objects/<2 hex>/<sha256>`). It
   * takes the place of the staging manifest key in shared mode, where nothing
   * is staged. Empty until a terminal exists.
   */
  readonly manifestObjectKey: string;
  readonly waitingForHuman: boolean;
  readonly reasonCode?: string;
}

/**
 * Persists one run into DATA. Objects first, terminal last: an `incomplete`
 * result means no terminal exists and the run is not reported as persisted
 * (G1-01). Nothing here retries a login or re-reads the provider.
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
    manifestObjectKey:
      result.outcome === "persisted" || result.outcome === "already_persisted"
        ? (result.objects.find((object) => object.artifactKey === MANIFEST_ARTIFACT_KEY)?.key ?? "")
        : "",
    waitingForHuman: waitingForHuman(input.manifest.failures),
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
 * The Workers `R2Bucket` binding seen through the contract's minimal surface.
 * They are the same object: `R2BucketLike` names exactly the five methods
 * `persistRun` calls. The cast only drops R2's extra `put` overload, whose
 * required `onlyIf` this package's optional one cannot satisfy under
 * `exactOptionalPropertyTypes`. It is the single place that conversion happens.
 */
export function dataBucket(bucket: R2Bucket): R2BucketLike {
  return bucket as unknown as R2BucketLike;
}
