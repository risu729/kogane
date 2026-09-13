import {
  persistRun,
  sha256Hex,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type R2BucketLike,
} from "../../../packages/collection/src/index";
import {
  parseStGeorgeSnapshot,
  type StGeorgeSnapshot,
} from "../../../packages/parsers/src/st-george-contract";
import { safeFailureCode, type FailureCode } from "./result";

export interface SharedRunInput {
  runId: string;
  attemptId: string;
  startedAt: string;
  completedAt: string;
  snapshot?: StGeorgeSnapshot;
  reason?: FailureCode;
}

const encoder = new TextEncoder();
async function artifactOf(
  artifactKey: string,
  value: unknown,
  role: string,
): Promise<PersistArtifact> {
  const bytes = encoder.encode(JSON.stringify(value));
  return {
    artifactKey,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: "application/json",
    role,
    body: { kind: "bytes", bytes },
  };
}

/** Only a validated DOM projection crosses this boundary; session material is never an input. */
export async function buildSharedRunPlan(input: SharedRunInput): Promise<PersistRunPlan> {
  if ((input.snapshot === undefined) === (input.reason === undefined)) {
    throw new Error("invalid_collection_result");
  }
  const artifacts: PersistArtifact[] = [];
  if (input.snapshot !== undefined) {
    artifacts.push(
      await artifactOf(
        "account-snapshot.json",
        parseStGeorgeSnapshot(input.snapshot),
        "sanitized_provider_capture",
      ),
    );
  }
  const reason = input.reason === undefined ? undefined : safeFailureCode(input.reason);
  const status = input.snapshot === undefined ? "failed" : "success";
  artifacts.push(
    await artifactOf(
      "manifest.json",
      {
        schemaVersion: "st-george-browser-v1",
        source: "st-george",
        runId: input.runId,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        status,
        artifacts: artifacts.map((artifact) => ({
          dataset: "account-snapshot",
          key: artifact.artifactKey,
          mediaType: artifact.mediaType,
          sha256: artifact.sha256,
          bytes: artifact.byteSize,
        })),
        failures: reason === undefined ? [] : [{ operation: "collect", message: reason }],
      },
      "collector_manifest",
    ),
  );
  return {
    run: {
      source: "st-george",
      producer: "collector-st-george",
      producerVersion: "st-george-browser-v1",
      runId: input.runId,
      attemptId: input.attemptId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      requestedScope: {
        scopeKind: "full_snapshot",
        startValue: null,
        endValue: null,
        unitKeys: [],
      },
      providerOutcome: status,
      coverageStatus: input.snapshot === undefined ? "unknown" : "partial",
      persistenceComplete: true,
      ...(reason === undefined ? {} : { safeErrorCode: reason }),
      units: [],
      ranges: [],
      reports: [],
      transformations:
        input.snapshot === undefined
          ? []
          : [
              {
                transformationId: "account-snapshot:extracted",
                stepKind: "extracted",
                transformerId: "st-george-dom-projection",
                transformerVersion: "v1",
                inputArtifactKeys: [],
                outputArtifactKey: "account-snapshot.json",
              },
              {
                transformationId: "account-snapshot:redacted",
                stepKind: "redacted",
                transformerId: "st-george-dom-projection",
                transformerVersion: "v1",
                inputArtifactKeys: [],
                outputArtifactKey: "account-snapshot.json",
              },
            ],
    },
    artifacts,
  };
}

export async function persistSharedRun(
  bucket: R2BucketLike,
  input: SharedRunInput,
): Promise<PersistRunResult> {
  return persistRun(bucket, await buildSharedRunPlan(input));
}

export function sharedRunPersisted(result: PersistRunResult): boolean {
  return result.outcome === "persisted" || result.outcome === "already_persisted";
}
