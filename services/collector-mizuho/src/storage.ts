import {
  persistRun,
  sha256Hex,
  type PersistRunPlan,
  type R2BucketLike,
  type TerminalUnit,
} from "../../../packages/collection/src/index";
import { sanitizeMizuhoPage } from "../../../packages/parsers/src/parsers/mizuho-html";
import type { MizuhoArtifact } from "./client";

/** The terminal's source (the collector id) and its producer, `collector-<collector id>` (ADR 0014). */
export const MIZUHO_SOURCE = "mizuho-bank";
export const MIZUHO_PRODUCER = "collector-mizuho-bank";

export interface MizuhoRun {
  runId: string;
  startedAt: string;
  completedAt: string;
  version: string;
  artifacts: readonly MizuhoArtifact[];
  failedUnits: readonly string[];
  /** Incomplete coverage; actual acquisition failures are separately listed. */
  partial: boolean;
  failed: boolean;
}

/** Retain only validated, sanitized provider DOM; the terminal is written last. */
export async function mizuhoRunPlan(input: MizuhoRun): Promise<PersistRunPlan> {
  const artifacts = [];
  const units: TerminalUnit[] = [];
  const seen = new Set<string>();
  for (const artifact of input.artifacts) {
    if (seen.has(artifact.unitKey)) throw new Error("duplicate-collection-unit");
    seen.add(artifact.unitKey);
    if (sanitizeMizuhoPage(artifact.body) !== artifact.body)
      throw new Error("unsafe-collection-artifact");
    const bytes = new TextEncoder().encode(artifact.body);
    artifacts.push({
      artifactKey: artifact.artifactKey,
      unitKey: artifact.unitKey,
      sha256: await sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: "text/html",
      role: "sanitized_provider_capture",
      body: { kind: "bytes" as const, bytes },
    });
    units.push({
      unitKey: artifact.unitKey,
      unitKind: "container",
      artifactCount: 1,
      coverageStatus: artifact.partial ? "partial" : "complete",
    });
  }
  for (const unitKey of input.failedUnits) {
    if (seen.has(unitKey)) throw new Error("duplicate-collection-unit");
    seen.add(unitKey);
    units.push({
      unitKey,
      unitKind: "container",
      artifactCount: 0,
      coverageStatus: "unknown",
      safeErrorCode: "collection-unit-failed",
    });
  }
  if (input.failed && artifacts.length > 0) throw new Error("inconsistent-collection-outcome");
  if (!input.failed && artifacts.length === 0) throw new Error("empty-collection-success");
  // Fetching the requested first page can succeed while total history coverage
  // remains partial. A failed requested unit is an acquisition failure instead.
  const providerOutcome = input.failed
    ? "failed"
    : input.failedUnits.length
      ? "partial"
      : "success";
  return {
    run: {
      source: MIZUHO_SOURCE,
      producer: MIZUHO_PRODUCER,
      producerVersion: input.version,
      runId: input.runId,
      attemptId: input.runId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      requestedScope: {
        scopeKind: "unspecified",
        startValue: null,
        endValue: null,
        unitKeys: units.map((u) => u.unitKey),
      },
      providerOutcome,
      coverageStatus: input.partial ? "partial" : "unknown",
      persistenceComplete: true,
      // A run that is not a success must name why (the manifest refuses it
      // otherwise); a partial run carries its failed units' code.
      ...(providerOutcome === "success"
        ? {}
        : {
            safeErrorCode:
              providerOutcome === "failed" ? "collection-failed" : "collection-unit-failed",
          }),
      units,
      ranges: [],
      reports: [
        { reportRef: "terminal", reportKind: "terminal", scope: "run", outcome: providerOutcome },
      ],
      transformations: artifacts.map((a, index) => ({
        transformationId: `sanitize-${index}`,
        stepKind: "redacted",
        transformerId: "collector-mizuho-bank",
        transformerVersion: input.version,
        inputArtifactKeys: [],
        outputArtifactKey: a.artifactKey,
      })),
    },
    artifacts,
  };
}

export async function persistMizuhoRun(bucket: R2BucketLike, input: MizuhoRun) {
  return persistRun(bucket, await mizuhoRunPlan(input));
}
