// Shared DATA-bucket persistence for the SBI Securities collector (unified
// plan U09, chapter 03, decisions D7/D12).
//
// With `COLLECTION_TARGET=shared` the run is written through
// `packages/collection` — every artifact content-addressed under `objects/`,
// the `terminal-v1` manifest last — instead of per-artifact writes into the
// per-source bucket followed by the central importer call. The bytes are the
// same `JSON.stringify(artifact.body)` the legacy path stores and the importer
// forwards centrally today.
//
// The passkey credential, the handshake key and the session ids stay in the
// secrets and in `src/sbi.ts`; none of them is an artifact, and a failure
// becomes a machine code here rather than the redacted provider message the
// legacy manifest keeps (12 §6).
import { safeErrorDetails } from "../../../packages/collector-diagnostics/src/index";
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
  type TerminalUnit,
} from "../../../packages/collection/src/index";
import type { Artifact, CollectionScope } from "./types";

export const SBI_SECURITIES_SOURCE = "sbi-securities";
export const SHARED_PRODUCER = "collector-sbi-securities";
const UNIT_KIND = "scope";
const FALLBACK_ERROR_CODE = "collector_failed";
/** The manifest's own machine-code charset; a code that fails it is replaced. */
const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,99}$/u;

export type UnitScope = "domestic" | "foreign";

/** One failure, reduced to what a terminal may state. */
export interface SharedFailure {
  readonly scope: UnitScope;
  readonly code: string;
}

export interface SbiSharedRun {
  readonly runId: string;
  readonly producerVersion: string;
  readonly attemptId: string;
  readonly operationId?: string;
  readonly acquisitionSessionRef?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "success" | "partial" | "failed";
  /** What the trigger asked for: `all`, `domestic` or `foreign`. */
  readonly scope: CollectionScope;
  /** The trade-history window the trigger asked for, when it named one. */
  readonly window?: { readonly from: string; readonly to: string };
  readonly artifacts: readonly Artifact[];
  readonly failures: readonly SharedFailure[];
}

/** The same split the central importer uses to attribute an artifact. */
export function datasetScope(dataset: string): UnitScope {
  return dataset.startsWith("foreign-") ? "foreign" : "domestic";
}

export function scopesFor(scope: CollectionScope): UnitScope[] {
  return scope === "all" ? ["domestic", "foreign"] : [scope];
}

/**
 * The machine code a terminal may carry for one failure. `safeErrorDetails`
 * already refuses to expose a provider message; this maps what is left to a
 * stable code, so no free-text ever reaches the manifest.
 */
export function safeFailureCode(error: unknown): string {
  const details = safeErrorDetails(error);
  if (details.code !== undefined && SAFE_CODE.test(details.code)) return details.code;
  switch (details.category) {
    case "http":
      return "provider_http_failed";
    case "timeout":
      return "provider_timeout";
    case "network":
      return "provider_network_failed";
    case "configuration":
      return "credential_configuration_required";
    case "authentication":
      return "authentication_required";
    case "response":
      return "provider_response_invalid";
    default:
      return "operation_failed";
  }
}

/** Builds the plan without writing anything, so a test can read the manifest. */
export async function sbiRunPlan(run: SbiSharedRun): Promise<PersistRunPlan> {
  const artifacts = await Promise.all(run.artifacts.map((artifact) => plannedArtifact(artifact)));
  const scopes = scopesFor(run.scope);
  const providerOutcome: ProviderOutcome = run.status;
  const coverageStatus = coverageFor(providerOutcome);
  const safeErrorCode =
    providerOutcome === "success"
      ? undefined
      : failureCode(run.failures.map((entry) => entry.code));
  // Per scope, exactly as the central unit report is built today: a scope with
  // no failure succeeded, a scope that produced nothing failed, anything else
  // is partial.
  const units: TerminalUnit[] = scopes.map((scope) => {
    const failures = run.failures.filter((entry) => entry.scope === scope);
    const count = artifacts.filter((artifact) => artifact.unitKey === scope).length;
    const unitCoverage: CoverageStatus =
      failures.length === 0 ? "complete" : count === 0 ? "unknown" : "partial";
    const unitCode = failures.length === 0 ? undefined : failureCode(failures.map((e) => e.code));
    return {
      unitKey: scope,
      unitKind: UNIT_KIND,
      artifactCount: count,
      coverageStatus: unitCoverage,
      ...(unitCode === undefined ? {} : { safeErrorCode: unitCode }),
    };
  });
  const ranges: TerminalRange[] =
    run.window === undefined
      ? []
      : [
          {
            rangeKey: "requested-window",
            rangeKind: "requested",
            precision: "date",
            basis: "request",
            startValue: run.window.from,
            endValue: run.window.to,
          },
        ];
  const fields: TerminalRunFields = {
    source: SBI_SECURITIES_SOURCE,
    producer: SHARED_PRODUCER,
    producerVersion: run.producerVersion,
    runId: run.runId,
    attemptId: run.attemptId,
    ...(run.operationId === undefined ? {} : { operationId: run.operationId }),
    ...(run.acquisitionSessionRef === undefined
      ? {}
      : { acquisitionSessionRef: run.acquisitionSessionRef }),
    // Positions are a snapshot whatever the trigger said; the window only
    // bounds the trade histories, so it is a requested range and the scope is
    // a date range only when one was asked for.
    requestedScope: {
      scopeKind: run.window === undefined ? "full_snapshot" : "date_range",
      startValue: run.window?.from ?? null,
      endValue: run.window?.to ?? null,
      unitKeys: scopes,
    },
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    providerOutcome,
    coverageStatus,
    persistenceComplete: true,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    units,
    ranges,
    reports: [],
    transformations: [],
  };
  return { run: fields, artifacts };
}

export async function persistSbiRun(
  bucket: R2BucketLike,
  run: SbiSharedRun,
): Promise<PersistRunResult> {
  return await persistRun(bucket, await sbiRunPlan(run));
}

function coverageFor(outcome: ProviderOutcome): CoverageStatus {
  return outcome === "success" ? "complete" : outcome === "partial" ? "partial" : "unknown";
}

function failureCode(codes: readonly string[]): string {
  return codes.find((candidate) => SAFE_CODE.test(candidate)) ?? FALLBACK_ERROR_CODE;
}

async function plannedArtifact(artifact: Artifact): Promise<PersistArtifact> {
  const bytes = new TextEncoder().encode(JSON.stringify(artifact.body));
  return {
    artifactKey: `${artifact.dataset}.json`,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: artifact.mediaType,
    // Every dataset is the collector's re-encoded view of a provider response,
    // which is the role the central descriptor gives them today.
    role: "collector_derived",
    unitKey: datasetScope(artifact.dataset),
    body: { kind: "bytes", bytes },
  };
}
