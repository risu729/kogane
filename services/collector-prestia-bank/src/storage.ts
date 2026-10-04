import {
  persistRun,
  sha256Hex,
  type PersistRunPlan,
  type R2BucketLike,
} from "../../../packages/collection/src/index";
import {
  parsePrestiaBankBalancePage,
  sanitizePrestiaBankPage,
} from "../../../packages/parsers/src/parsers/prestia-bank-html";
export interface PrestiaBankRun {
  runId: string;
  startedAt: string;
  completedAt: string;
  version: string;
  body?: string;
}
export const PRESTIA_BANK_SOURCE = "prestia-bank";
export const PRESTIA_BANK_PRODUCER = "collector-prestia-bank";
export async function prestiaBankRunPlan(input: PrestiaBankRun): Promise<PersistRunPlan> {
  const success = input.body !== undefined;
  if (success && (!input.body || sanitizePrestiaBankPage(input.body) !== input.body))
    throw new Error("unsafe-collection-artifact");
  if (input.body !== undefined) parsePrestiaBankBalancePage(input.body);
  const bytes = success ? new TextEncoder().encode(input.body) : undefined;
  const artifacts = bytes
    ? [
        {
          artifactKey: "balance.html",
          unitKey: "balance-summary",
          sha256: await sha256Hex(bytes),
          byteSize: bytes.byteLength,
          mediaType: "text/html",
          role: "sanitized_provider_capture",
          body: { kind: "bytes" as const, bytes },
        },
      ]
    : [];
  return {
    run: {
      source: PRESTIA_BANK_SOURCE,
      producer: PRESTIA_BANK_PRODUCER,
      producerVersion: input.version,
      runId: input.runId,
      attemptId: input.runId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      requestedScope: {
        scopeKind: "unspecified",
        startValue: null,
        endValue: null,
        unitKeys: ["balance-summary"],
      },
      providerOutcome: success ? "success" : "failed",
      coverageStatus: success ? "complete" : "unknown",
      persistenceComplete: true,
      ...(!success ? { safeErrorCode: "collection-failed" } : {}),
      units: [
        {
          unitKey: "balance-summary",
          unitKind: "container",
          artifactCount: artifacts.length,
          coverageStatus: success ? "complete" : "unknown",
          ...(!success ? { safeErrorCode: "collection-failed" } : {}),
        },
      ],
      ranges: [],
      reports: [
        {
          reportRef: "terminal",
          reportKind: "terminal",
          scope: "run",
          outcome: success ? "success" : "failed",
        },
      ],
      transformations: artifacts.map((a) => ({
        transformationId: "sanitize-balance",
        stepKind: "redacted",
        transformerId: PRESTIA_BANK_PRODUCER,
        transformerVersion: input.version,
        inputArtifactKeys: [],
        outputArtifactKey: a.artifactKey,
      })),
    },
    artifacts,
  };
}
export async function persistPrestiaBankRun(bucket: R2BucketLike, input: PrestiaBankRun) {
  return persistRun(bucket, await prestiaBankRunPlan(input));
}
