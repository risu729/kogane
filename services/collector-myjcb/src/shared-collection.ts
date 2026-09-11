// MyJCB → the shared DATA bucket (unified plan 03, U09).
//
// The collector already redacts every statement page it keeps
// (`redactedStatementHtml`): scripts, styles, textareas, link and form targets
// and every `value=` attribute are gone and card numbers in text are replaced
// before anything is written. Those are the bytes the central path stores, so
// shared mode stores exactly them — and re-checks the redaction invariants the
// central path enforces before a byte goes into the shared bucket, because a
// collector regression must fail the run rather than publish a session token
// or a card number (G3-08).
//
// The collector manifest is written in the shape central storage receives:
// connection blockers and failure messages become coarse codes, so the free
// text of an upstream error never reaches the shared bucket either.
import { assertRedactedHtml } from "./parsers";
import type {
  CollectionFailure,
  CollectionManifest,
  ConnectionSummary,
  RawArtifact,
  StoredArtifact,
} from "./types";
import {
  objectKey,
  persistRun,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalReport,
  type TerminalTransformation,
  type TerminalUnit,
} from "../../../packages/collection/src/index";

const SOURCE = "myjcb";
const PRODUCER = "myjcb-worker";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

/** One connection's finished collection, as the worker saw it. */
export interface SharedConnectionRun {
  readonly summary: ConnectionSummary;
  readonly artifacts: readonly RawArtifact[];
}

export interface SharedRunInput {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: CollectionManifest["status"];
  readonly trigger: CollectionManifest["trigger"];
  readonly connections: readonly SharedConnectionRun[];
  readonly failures: readonly CollectionFailure[];
  /**
   * Set when an operation requested this run (unified plan 02 §5). U08
   * dispatches collection operations; the cron and the admin trigger leave
   * both undefined.
   */
  readonly operationId?: string;
  readonly attemptId?: string;
  /** Shared by the per-source runs of one multi-source session (03 §3). */
  readonly acquisitionSessionRef?: string;
}

export interface SharedRunOutcome {
  readonly result: PersistRunResult;
  readonly artifactCount: number;
}

/**
 * The Workers `R2Bucket` provides everything `R2BucketLike` names; the two
 * declarations differ only in how the optional `onlyIf` put option is written
 * under `exactOptionalPropertyTypes`, so the binding is narrowed here once
 * rather than at every call site.
 */
export function sharedBucket(binding: R2Bucket): R2BucketLike {
  return binding as unknown as R2BucketLike;
}

/**
 * The artifact role vocabulary the central contract already uses for MyJCB,
 * so a terminal registers the same way the importer registered the same
 * bytes.
 */
export function artifactRole(artifact: RawArtifact): string {
  if (artifact.mediaType.startsWith("text/html")) return "sanitized_provider_capture";
  if (artifact.dataset === "credit-past-months") return "provider_response";
  if (
    artifact.dataset === "credit-csv" ||
    artifact.dataset === "credit-pdf" ||
    artifact.dataset === "credit-ofx"
  ) {
    return "provider_export";
  }
  return "collector_derived";
}

function bodyBytes(body: string | ArrayBuffer): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function coverage(
  status: ConnectionSummary["status"] | CollectionManifest["status"],
): CoverageStatus {
  if (status === "success") return "complete";
  return status === "partial" ? "partial" : "unknown";
}

/** A blocked connection is a state to report, never a reason to retry a login
 * (source policy, G3-10/G3-11). */
function connectionErrorCode(status: ConnectionSummary["status"]): string | undefined {
  if (status === "success") return undefined;
  if (status === "human-required") return "human_required";
  return status === "partial" ? "collector_partial" : "collector_failed";
}

function runErrorCode(input: SharedRunInput): string | undefined {
  if (input.status === "success") return undefined;
  const blocked = input.connections.filter((connection) => connection.summary.status !== "success");
  if (blocked.length > 0 && blocked.every((c) => c.summary.status === "human-required")) {
    return "human_required";
  }
  return input.status === "partial" ? "collector_partial" : "collector_failed";
}

function identifier(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (!IDENTIFIER.test(value)) throw new Error(code);
  return value;
}

/**
 * The collector manifest as central storage receives it
 * (`normalizeMyJcbManifestForCentral`): a connection blocker and a failure
 * message become coarse codes, and each artifact names the content-addressed
 * object that was written rather than a bucket path shared mode never
 * creates.
 */
function manifestBytes(
  input: SharedRunInput,
  connections: readonly ConnectionSummary[],
  stored: readonly StoredArtifact[],
): Uint8Array {
  const statusByConnection = new Map(
    connections.map((connection) => [connection.connectionId, connection.status]),
  );
  const manifest: CollectionManifest = {
    schemaVersion: input.schemaVersion,
    source: "myjcb",
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: input.status,
    trigger: input.trigger,
    connections: connections.map((connection) => ({
      ...connection,
      ...(connection.blocker === undefined
        ? {}
        : {
            blocker:
              connection.status === "human-required" ? "human-required" : "collector-failure",
          }),
    })),
    artifacts: stored,
    failures: input.failures.map((failure) => ({
      ...failure,
      message: failure.operation.startsWith("r2:")
        ? "r2-write-failure"
        : statusByConnection.get(failure.connectionId) === "human-required"
          ? "human-required"
          : "collector-failure",
    })),
  };
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/** Build the persist plan for a finished run. Pure apart from hashing. */
export async function myJcbRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  const outcome: ProviderOutcome = input.status;
  const errorCode = runErrorCode(input);
  // A failed run keeps no artifact: there is nothing whose persistence could
  // be claimed, and the terminal states the failure on its own (G1-09).
  const sources = outcome === "failed" ? [] : input.connections;

  const artifacts: PersistArtifact[] = [];
  const stored: StoredArtifact[] = [];
  const transformations: TerminalTransformation[] = [];
  const units: TerminalUnit[] = [];
  for (const connection of sources) {
    const unitKey = connection.summary.connectionId;
    for (const artifact of connection.artifacts) {
      const bytes = bodyBytes(artifact.body);
      const role = artifactRole(artifact);
      if (role === "sanitized_provider_capture") {
        // The redaction the collector applied is re-checked here, against the
        // same invariants the central path enforces, before the bytes leave
        // the Worker.
        assertRedactedHtml(new TextDecoder().decode(bytes));
      }
      const sha256 = await sha256Hex(bytes);
      const artifactKey = `${unitKey}/${artifact.filename}`;
      artifacts.push({
        artifactKey,
        sha256,
        byteSize: bytes.byteLength,
        mediaType: artifact.mediaType.split(";", 1)[0]!.trim(),
        role,
        unitKey,
        body: { kind: "bytes", bytes },
      });
      stored.push({
        dataset: artifact.dataset,
        key: objectKey(sha256),
        mediaType: artifact.mediaType,
        sha256,
        bytes: bytes.byteLength,
        ...(artifact.statementState ? { statementState: artifact.statementState } : {}),
        ...(artifact.period ? { period: artifact.period } : {}),
      });
      if (role === "sanitized_provider_capture") {
        transformations.push({
          transformationId: `redacted:${artifactKey.replaceAll("/", ":")}`,
          stepKind: "redacted",
          transformerId: "myjcb-sanitizer",
          transformerVersion: "v1",
          // The provider HTML was deliberately not retained.
          inputArtifactKeys: [],
          outputArtifactKey: artifactKey,
        });
      }
    }
    const connectionCode = connectionErrorCode(connection.summary.status);
    units.push({
      unitKey,
      unitKind: "connection",
      artifactCount: connection.artifacts.length,
      coverageStatus: coverage(connection.summary.status),
      ...(connectionCode === undefined ? {} : { safeErrorCode: connectionCode }),
    });
  }

  const summaries = sources.map((connection) => connection.summary);
  if (artifacts.length > 0) {
    const bytes = manifestBytes(input, summaries, stored);
    artifacts.push({
      artifactKey: "manifest.json",
      sha256: await sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: "application/json",
      role: "collector_manifest",
      body: { kind: "bytes", bytes },
    });
  }

  const reports: TerminalReport[] = [
    {
      reportRef: "terminal",
      reportKind: "terminal",
      scope: "run",
      outcome,
      ...(errorCode === undefined ? {} : { safeErrorCode: errorCode }),
    },
  ];
  const operationId = identifier(input.operationId, "shared_operation_id_invalid");
  const sessionRef = identifier(input.acquisitionSessionRef, "shared_session_ref_invalid");
  return {
    run: {
      source: SOURCE,
      producer: PRODUCER,
      producerVersion: input.schemaVersion,
      runId: input.runId,
      attemptId: identifier(input.attemptId, "shared_attempt_id_invalid") ?? input.runId,
      ...(operationId === undefined ? {} : { operationId }),
      ...(sessionRef === undefined ? {} : { acquisitionSessionRef: sessionRef }),
      // A run takes whatever statement periods the card currently exposes, so
      // it is a snapshot of the connections, not a requested window.
      requestedScope: {
        scopeKind: "full_snapshot",
        startValue: null,
        endValue: null,
        unitKeys: units.map((unit) => unit.unitKey),
      },
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      providerOutcome: outcome,
      // A MyJCB card exposes a rolling set of statement periods, so even a
      // fully successful run is not a claim about the card's whole history.
      coverageStatus: input.status === "success" ? "partial" : coverage(input.status),
      persistenceComplete: true,
      ...(errorCode === undefined ? {} : { safeErrorCode: errorCode }),
      units: units.map((unit) => ({
        ...unit,
        coverageStatus: unit.coverageStatus === "complete" ? "partial" : unit.coverageStatus,
      })),
      // The statement periods are provider labels, not machine ranges; they
      // stay in the collector manifest rather than becoming terminal ranges.
      ranges: [],
      reports,
      transformations,
    },
    artifacts,
  };
}

/**
 * Persist a finished run into the shared bucket. The terminal is written last
 * by the helper; a failed put returns `incomplete` with a checkpoint and no
 * terminal, which the caller must not report as a completed run (G1-01).
 */
export async function persistSharedRun(
  bucket: R2BucketLike,
  input: SharedRunInput,
): Promise<SharedRunOutcome> {
  const plan = await myJcbRunPlan(input);
  const result = await persistRun(bucket, plan);
  return { result, artifactCount: plan.artifacts.length };
}

/** Safe, code-only diagnostics for a persist attempt: no provider text, no
 * amounts, no bodies. */
export function sharedRunDiagnostic(
  input: SharedRunInput,
  outcome: SharedRunOutcome,
): Record<string, unknown> {
  const result = outcome.result;
  return {
    event: "myjcb-shared-collection",
    runId: input.runId,
    status: input.status,
    persistence: result.outcome,
    connectionCount: input.connections.length,
    artifactCount: outcome.artifactCount,
    ...(result.outcome === "incomplete"
      ? {
          reasonCode: result.reasonCode,
          persistedCount: result.checkpoint.persistedArtifactKeys.length,
          pendingCount: result.checkpoint.pendingArtifactKeys.length,
        }
      : {}),
    ...(result.outcome === "conflict" ? { reasonCode: result.reasonCode } : {}),
  };
}
