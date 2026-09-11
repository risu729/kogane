import type {
  EvidenceArtifactDetail,
  EvidenceArtifactList,
  EvidenceMeta,
  EvidenceRunList,
} from "../../../packages/observation-shared/src/evidence-contract.ts";

// Entirely synthetic DTOs; no captured production data or credentials.
export function evidenceFixture(): {
  meta: EvidenceMeta;
  runs: EvidenceRunList;
  artifacts: EvidenceArtifactList;
  detail: EvidenceArtifactDetail;
} {
  const run = {
    id: "r_42" as const,
    sourceId: "sony-bank",
    producerId: "sony-bank-worker",
    recordedAt: "2026-09-05T01:00:00.000Z",
    sealedAt: "2026-09-05T01:02:00.000Z",
    outcome: "partial" as const,
    startedAt: "2026-09-05T00:59:00.000Z",
    startedAtBasis: "manifest" as const,
    completedAt: null,
    completedAtBasis: null,
    artifactCount: 2,
  };
  const artifact = {
    id: "a_7" as const,
    runId: run.id,
    artifactKey: "test-only-statement",
    role: "provider_response" as const,
    payloadFidelity: "exact" as const,
    dataset: null,
    sha256: "a".repeat(64),
    byteSize: 0,
    recordedAt: run.recordedAt,
  };
  return {
    meta: {
      apiVersion: "evidence-v1",
      source: { kind: "central-raw-store", classification: "financial" },
      capabilities: {
        readOnly: true,
        rawEvidence: true,
        parsedObservations: false,
        liveCollectors: false,
      },
      sources: [{ id: "sony-bank", label: "テスト用の取得元" }],
    },
    runs: {
      apiVersion: "evidence-v1",
      sourceId: run.sourceId,
      coverage: "sealed-only",
      items: [run],
      nextCursor: "c_42",
    },
    artifacts: { apiVersion: "evidence-v1", run, items: [artifact], nextCursor: "c_7" },
    detail: {
      apiVersion: "evidence-v1",
      run,
      artifact: {
        ...artifact,
        descriptorSha256: "b".repeat(64),
        containerKind: "single",
        lineageDisposition: "not_applicable",
        formatId: null,
        formatVersion: null,
        declaredMediaType: null,
      },
    },
  };
}
