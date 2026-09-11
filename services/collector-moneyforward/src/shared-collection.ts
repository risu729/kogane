// Money Forward ME → the shared DATA bucket (unified plan 03, U09).
//
// The legacy path stores each captured page in the per-source bucket and the
// importer forwards those bytes to central storage unchanged; only the
// collector manifest is normalized on the way (free-text failure messages are
// replaced by their codes). Shared mode therefore stores the same page bytes
// under content-addressed keys and writes the same normalization into the
// manifest artifact, so the evidence is identical and no response that
// carried a session ever reaches the shared bucket unredacted — the pages the
// collector keeps are the logged-in HTML it already considered safe to store,
// and request headers and credentials are never part of an artifact.
//
// Nothing here contacts a provider: it maps a finished run onto a persist
// plan and lets `persistRun` write the terminal last.
import type { CollectionFailure, CollectionManifest, RawArtifact, StoredArtifact } from "./types";
import {
  objectKey,
  persistRun,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalRange,
  type TerminalReport,
  type TerminalUnit,
} from "../../../packages/collection/src/index";

const SOURCE = "moneyforward-me";
const PRODUCER = "moneyforward-worker";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
/** `account-NN-month-YYYY-MM.html`, the collector's own filename grammar. */
const MONTHLY_FRAGMENT = /^account-(\d{2})-month-(\d{4}-\d{2})\.html$/u;
const ACCOUNT_DETAIL = /^account-detail-(\d{2})\.html$/u;

export interface SharedRunInput {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: CollectionManifest["status"];
  readonly accountDetailCount: number;
  readonly monthlyFragmentCount: number;
  readonly artifacts: readonly RawArtifact[];
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

/** The account a captured page belongs to, or null for the run-wide index. */
export function artifactUnitKey(filename: string): string | null {
  const monthly = MONTHLY_FRAGMENT.exec(filename);
  if (monthly) return `account-${monthly[1]!}`;
  const detail = ACCOUNT_DETAIL.exec(filename);
  return detail ? `account-${detail[1]!}` : null;
}

function artifactMonth(filename: string): string | null {
  return MONTHLY_FRAGMENT.exec(filename)?.[2] ?? null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function coverage(status: CollectionManifest["status"]): CoverageStatus {
  if (status === "success") return "complete";
  return status === "partial" ? "partial" : "unknown";
}

function safeErrorCode(status: CollectionManifest["status"]): string | undefined {
  if (status === "success") return undefined;
  return status === "partial" ? "collector_partial" : "collector_failed";
}

function identifier(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (!IDENTIFIER.test(value)) throw new Error(code);
  return value;
}

/**
 * The collector manifest as central storage receives it: the failure message
 * is the failure code (`normalizeMoneyForwardManifestForCentral`), and each
 * artifact names the content-addressed object that was written rather than a
 * per-source bucket path that shared mode never creates.
 */
function manifestBytes(input: SharedRunInput, stored: readonly StoredArtifact[]): Uint8Array {
  const manifest: CollectionManifest = {
    schemaVersion: input.schemaVersion,
    source: "moneyforward-me",
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: input.status,
    accountDetailCount: input.accountDetailCount,
    monthlyFragmentCount: input.monthlyFragmentCount,
    artifacts: [...stored],
    failures: input.failures.map((failure) => ({
      ...failure,
      message: failure.failureCode ?? failure.message,
    })),
  };
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/** Build the persist plan for a finished run. Pure apart from hashing. */
export async function moneyForwardRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  const outcome: ProviderOutcome = input.status;
  const coverageStatus = coverage(input.status);
  const errorCode = safeErrorCode(input.status);
  // A failed run keeps no artifact: there is nothing whose persistence could
  // be claimed, and the terminal states the failure on its own (G1-09).
  const sources = outcome === "failed" ? [] : input.artifacts;

  const artifacts: PersistArtifact[] = [];
  const stored: StoredArtifact[] = [];
  const unitKeys = new Set<string>();
  const monthsByUnit = new Map<string, string[]>();
  for (const artifact of sources) {
    const bytes = new TextEncoder().encode(artifact.body);
    const sha256 = await sha256Hex(bytes);
    const unitKey = artifactUnitKey(artifact.filename);
    if (unitKey !== null) unitKeys.add(unitKey);
    const month = artifactMonth(artifact.filename);
    if (unitKey !== null && month !== null) {
      monthsByUnit.set(unitKey, [...(monthsByUnit.get(unitKey) ?? []), month]);
    }
    artifacts.push({
      artifactKey: artifact.filename,
      sha256,
      byteSize: bytes.byteLength,
      mediaType: artifact.mediaType.split(";", 1)[0]!.trim(),
      // Every captured page is the provider's own response; the collector
      // derives nothing and stores no session material with it.
      role: "provider_response",
      ...(unitKey === null ? {} : { unitKey }),
      body: { kind: "bytes", bytes },
    });
    stored.push({
      dataset: artifact.dataset,
      key: objectKey(sha256),
      mediaType: artifact.mediaType,
      sha256,
      bytes: bytes.byteLength,
    });
  }
  if (artifacts.length > 0) {
    const bytes = manifestBytes(input, stored);
    artifacts.push({
      artifactKey: "manifest.json",
      sha256: await sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: "application/json",
      role: "collector_manifest",
      body: { kind: "bytes", bytes },
    });
  }

  const sortedUnits = [...unitKeys].sort();
  const units: TerminalUnit[] = sortedUnits.map((unitKey) => ({
    unitKey,
    unitKind: "account",
    artifactCount: artifacts.filter((artifact) => artifact.unitKey === unitKey).length,
    coverageStatus,
    ...(errorCode === undefined ? {} : { safeErrorCode: errorCode }),
  }));
  // The months a unit actually returned, as the collector saw them: a
  // declaration of what was captured, never of what the provider holds.
  const ranges: TerminalRange[] = sortedUnits.flatMap((unitKey) => {
    const months = [...(monthsByUnit.get(unitKey) ?? [])].sort();
    if (months.length === 0) return [];
    return [
      {
        rangeKey: `months-${unitKey}`,
        rangeKind: "declared_coverage",
        precision: "month",
        basis: "manifest",
        startValue: months[0]!,
        endValue: months.at(-1)!,
        unitKey,
      } satisfies TerminalRange,
    ];
  });
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
      // The run asks for whatever the aggregator currently shows; there is no
      // requested window to state.
      requestedScope: {
        scopeKind: "full_snapshot",
        startValue: null,
        endValue: null,
        unitKeys: sortedUnits,
      },
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      providerOutcome: outcome,
      coverageStatus,
      persistenceComplete: true,
      ...(errorCode === undefined ? {} : { safeErrorCode: errorCode }),
      units,
      ranges,
      reports,
      transformations: [],
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
  const plan = await moneyForwardRunPlan(input);
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
    event: "moneyforward-shared-collection",
    runId: input.runId,
    status: input.status,
    persistence: result.outcome,
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
