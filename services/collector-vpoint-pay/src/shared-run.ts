// Shared DATA-bucket persistence for the V Point Pay app collector (unified
// plan U09, chapter 03, decisions D7/D12).
//
// With `COLLECTION_TARGET=shared` the Durable Object writes the run through
// `packages/collection` — every artifact content-addressed under `objects/`,
// the `terminal-v1` manifest last — instead of writing artifacts and a
// collector manifest into the per-source bucket. The bytes are identical: the
// same decoded API response text the legacy path stores.
//
// The app collector is stopped (`/trigger`, `/probe` and `/reset-credentials`
// answer 410 and there is no cron), so this is the target a future re-enable
// writes to; the exclusion that keeps one collection in flight per Durable
// Object is unchanged by it.
//
// Nothing here logs. The refresh token, the device UUID and the access token
// stay in the Durable Object and in the request headers `collectVPointPay`
// builds; none of them is an artifact and none reaches this module.
import {
  persistRun,
  sha256Hex,
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
import type { RawArtifact } from "./types";

export const VPOINT_PAY_SOURCE = "v-point-pay";
/** `collector-<collector id>`: the producer the Processor's route for this source names (ADR 0014). */
export const SHARED_PRODUCER = "collector-v-point-pay";
/**
 * What turns an app API response into a stored artifact: this collector,
 * named by its collector id (ADR 0021).
 */
const TRANSFORMER_ID = SHARED_PRODUCER;
const UNIT_KEY = "account";
const UNIT_KIND = "collection";
const FALLBACK_ERROR_CODE = "collector_failed";
/** The manifest's own machine-code charset; a code that fails it is replaced. */
const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,99}$/u;
const MONTH = /^\d{4}(0[1-9]|1[0-2])$/u;

export interface VPointPaySharedRun {
  readonly runId: string;
  readonly producerVersion: string;
  readonly attemptId: string;
  readonly operationId?: string;
  readonly acquisitionSessionRef?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "success" | "partial" | "failed";
  /** The artifacts `collectVPointPay` produced, in collection order. */
  readonly artifacts: readonly RawArtifact[];
  /** First and last statement month the run asked for, `yyyyMM`, when known. */
  readonly earliestMonth: string | null;
  readonly latestMonth: string | null;
  /** Safe failure codes of the run, most significant first; never provider text. */
  readonly failureCodes: readonly string[];
}

/** Builds the plan without writing anything, so a test can read the manifest. */
export async function vPointPayRunPlan(run: VPointPaySharedRun): Promise<PersistRunPlan> {
  const artifacts = await Promise.all(
    run.artifacts.map((artifact) => plannedArtifact(artifact, role(artifact.dataset))),
  );
  const providerOutcome: ProviderOutcome = run.status;
  const coverageStatus = coverageFor(providerOutcome);
  const safeErrorCode = providerOutcome === "success" ? undefined : failureCode(run.failureCodes);
  // The month window the provider itself declares (`inquiry_period`) through
  // the current JST month; a range is only stated when both ends are known.
  const startValue = month(run.earliestMonth);
  const endValue = month(run.latestMonth);
  const ranges: TerminalRange[] =
    startValue === null || endValue === null
      ? []
      : [
          {
            rangeKey: "requested-months",
            rangeKind: "requested",
            precision: "month",
            basis: "source",
            startValue,
            endValue,
            unitKey: UNIT_KEY,
          },
        ];
  const fields: TerminalRunFields = {
    source: VPOINT_PAY_SOURCE,
    producer: SHARED_PRODUCER,
    producerVersion: run.producerVersion,
    runId: run.runId,
    attemptId: run.attemptId,
    ...(run.operationId === undefined ? {} : { operationId: run.operationId }),
    ...(run.acquisitionSessionRef === undefined
      ? {}
      : { acquisitionSessionRef: run.acquisitionSessionRef }),
    requestedScope: {
      scopeKind: startValue === null || endValue === null ? "unspecified" : "month_range",
      startValue,
      endValue,
      unitKeys: [UNIT_KEY],
    },
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    providerOutcome,
    coverageStatus,
    persistenceComplete: true,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    units: [
      {
        unitKey: UNIT_KEY,
        unitKind: UNIT_KIND,
        artifactCount: artifacts.length,
        coverageStatus,
        ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
      },
    ],
    ranges,
    reports: [],
    transformations: artifacts
      .filter((artifact) => artifact.role === "collector_derived")
      .map((artifact) => reencoding(artifact.artifactKey, run.producerVersion)),
  };
  return { run: fields, artifacts };
}

/**
 * The lineage a stored response states (ADR 0021). Its bytes are the API
 * response text as `fetch` decoded it (`Response.text()`), encoded again as
 * UTF-8: the same content, but not provably the provider's bytes, so it is a
 * `reencoded` derivation and not a provider capture. The response itself is
 * not stored, so the step names no input and the Processor records
 * `source_bytes_not_available`.
 */
function reencoding(artifactKey: string, producerVersion: string): TerminalTransformation {
  return {
    transformationId: `${artifactKey}:reencoded`,
    stepKind: "reencoded",
    transformerId: TRANSFORMER_ID,
    transformerVersion: producerVersion,
    inputArtifactKeys: [],
    outputArtifactKey: artifactKey,
  };
}

export async function persistVPointPayRun(
  bucket: R2BucketLike,
  run: VPointPaySharedRun,
): Promise<PersistRunResult> {
  return await persistRun(bucket, await vPointPayRunPlan(run));
}

/** `collection-summary` is generated by the collector; the rest is re-encoded provider data. */
function role(dataset: string): string {
  return dataset === "collection-summary" ? "collector_summary" : "collector_derived";
}

function coverageFor(outcome: ProviderOutcome): CoverageStatus {
  return outcome === "success" ? "complete" : outcome === "partial" ? "partial" : "unknown";
}

/**
 * The collector's `yyyyMM` month as the terminal states a month: `YYYY-MM`,
 * the only month form the ingest range contract accepts. A range stated as
 * `yyyyMM` was refused at registration (`invalid_start_value`), found by the
 * run-plan registration test of ADR 0021.
 */
function month(value: string | null): string | null {
  return value !== null && MONTH.test(value) ? `${value.slice(0, 4)}-${value.slice(4)}` : null;
}

function failureCode(codes: readonly string[]): string {
  return codes.find((candidate) => SAFE_CODE.test(candidate)) ?? FALLBACK_ERROR_CODE;
}

async function plannedArtifact(
  artifact: RawArtifact,
  artifactRole: string,
): Promise<PersistArtifact> {
  const bytes = new TextEncoder().encode(artifact.body);
  return {
    artifactKey: artifact.filename,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: artifact.mediaType,
    role: artifactRole,
    unitKey: UNIT_KEY,
    body: { kind: "bytes", bytes },
  };
}
