import { describe, expect, test } from "bun:test";
import {
  evidenceRequest,
  isEvidenceArtifactId,
  isEvidenceRunId,
  validEvidenceResponse,
} from "../../../packages/observation-shared/src/evidence-validation.ts";
import { evidenceFixture } from "./evidence-client-fixture.ts";

const base = "/api/evidence/v1";
const runPath = `${base}/sources/sony-bank/runs`;
const artifactPath = `${base}/runs/r_42/artifacts`;
const detailPath = `${artifactPath}/a_7`;

describe("production evidence contract", () => {
  test("validates financial raw-store metadata separately from the local API", () => {
    const { meta } = evidenceFixture();
    expect(validEvidenceResponse(`${base}/meta`, meta)).toBe(true);
    for (const value of [
      { ...meta, apiVersion: 1 },
      { ...meta, source: { kind: "local-store", classification: "synthetic" } },
      { ...meta, capabilities: { ...meta.capabilities, parsedObservations: "true" } },
      { ...meta, capabilities: { ...meta.capabilities, liveCollectors: true } },
      { ...meta, sources: [meta.sources[0], meta.sources[0]] },
      { ...meta, sources: [] },
    ])
      expect(validEvidenceResponse(`${base}/meta`, value)).toBe(false);
    expect(validEvidenceResponse("/api/meta", meta)).toBe(false);
  });
  test("sealing never turns partial, failed or unclassified collection outcomes into success", () => {
    const { runs } = evidenceFixture();
    for (const outcome of [
      "success",
      "partial",
      "failed",
      "human_required",
      "cancelled",
      "unknown",
    ]) {
      const value = { ...runs, items: [{ ...runs.items[0], outcome }] };
      expect(validEvidenceResponse(runPath, value)).toBe(true);
      expect(value.items[0]!.outcome).toBe(outcome);
    }
    expect(
      validEvidenceResponse(runPath, {
        ...runs,
        items: [{ ...runs.items[0], outcome: "running" }],
      }),
    ).toBe(false);
    expect(validEvidenceResponse(runPath, { ...runs, coverage: "complete" })).toBe(false);
  });
  test("opaque IDs retain exact safe positive integer identity", () => {
    for (const value of [1, Number.MAX_SAFE_INTEGER]) {
      expect(isEvidenceRunId(`r_${value}`)).toBe(true);
      expect(isEvidenceArtifactId(`a_${value}`)).toBe(true);
    }
    for (const value of ["0", "01", "-1", "1.5", "1e3", "9007199254740992", "1\n", "1/../2"]) {
      expect(isEvidenceRunId(`r_${value}`)).toBe(false);
      expect(isEvidenceArtifactId(`a_${value}`)).toBe(false);
    }
    expect(isEvidenceRunId("a_1")).toBe(false);
  });
  test("rejects cross-source, cross-run and wrong-artifact responses", () => {
    const { runs, artifacts, detail } = evidenceFixture();
    expect(validEvidenceResponse(runPath, runs)).toBe(true);
    expect(validEvidenceResponse(artifactPath, artifacts)).toBe(true);
    expect(validEvidenceResponse(detailPath, detail)).toBe(true);
    expect(validEvidenceResponse(runPath, { ...runs, sourceId: "other-bank" })).toBe(false);
    expect(
      validEvidenceResponse(runPath, {
        ...runs,
        items: [{ ...runs.items[0], sourceId: "other-bank" }],
      }),
    ).toBe(false);
    expect(
      validEvidenceResponse(artifactPath, { ...artifacts, run: { ...artifacts.run, id: "r_43" } }),
    ).toBe(false);
    expect(
      validEvidenceResponse(artifactPath, {
        ...artifacts,
        items: [{ ...artifacts.items[0], runId: "r_43" }],
      }),
    ).toBe(false);
    expect(
      validEvidenceResponse(detailPath, { ...detail, artifact: { ...detail.artifact, id: "a_8" } }),
    ).toBe(false);
    expect(
      validEvidenceResponse(detailPath, {
        ...detail,
        artifact: { ...detail.artifact, runId: "r_43" },
      }),
    ).toBe(false);
  });
  test("preserves genuine empty pages and rejects repeated cursors or duplicate identities", () => {
    const { runs, artifacts } = evidenceFixture();
    expect(validEvidenceResponse(runPath, { ...runs, items: [], nextCursor: null })).toBe(true);
    expect(validEvidenceResponse(runPath, { ...runs, items: [] })).toBe(false);
    expect(validEvidenceResponse(`${runPath}?cursor=c_42`, runs)).toBe(false);
    expect(validEvidenceResponse(`${artifactPath}?cursor=c_7`, artifacts)).toBe(false);
    expect(validEvidenceResponse(runPath, { ...runs, items: [runs.items[0], runs.items[0]] })).toBe(
      false,
    );
    expect(
      validEvidenceResponse(artifactPath, {
        ...artifacts,
        items: [artifacts.items[0], artifacts.items[0]],
      }),
    ).toBe(false);
    expect(
      validEvidenceResponse(artifactPath, {
        ...artifacts,
        run: { ...artifacts.run, artifactCount: 0 },
      }),
    ).toBe(false);
  });
  test("validates timestamp provenance, exact digests and byte counts", () => {
    const { runs, detail } = evidenceFixture();
    for (const recordedAt of ["2026-02-30T00:00:00.000Z", "2026-09-05", "not-a-date"])
      expect(
        validEvidenceResponse(runPath, { ...runs, items: [{ ...runs.items[0], recordedAt }] }),
      ).toBe(false);
    expect(
      validEvidenceResponse(runPath, {
        ...runs,
        items: [{ ...runs.items[0], startedAtBasis: "collector" }],
      }),
    ).toBe(false);
    for (const sha256 of ["", "A".repeat(64), "../raw", "a".repeat(63)])
      expect(
        validEvidenceResponse(detailPath, { ...detail, artifact: { ...detail.artifact, sha256 } }),
      ).toBe(false);
    for (const byteSize of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "10"])
      expect(
        validEvidenceResponse(detailPath, {
          ...detail,
          artifact: { ...detail.artifact, byteSize },
        }),
      ).toBe(false);
    expect(
      validEvidenceResponse(detailPath, {
        ...detail,
        artifact: { ...detail.artifact, descriptorSha256: null },
      }),
    ).toBe(false);
    expect(
      validEvidenceResponse(detailPath, {
        ...detail,
        artifact: { ...detail.artifact, containerKind: "invented" },
      }),
    ).toBe(false);
  });
  test("timestamp bases must accompany values and completion cannot precede start", () => {
    const { runs } = evidenceFixture();
    for (const fields of [
      { startedAt: null },
      { startedAtBasis: null },
      { completedAtBasis: "manifest" },
      { completedAt: "2026-09-05T01:00:00.000Z" },
      { completedAt: "2026-09-05T00:58:00.000Z", completedAtBasis: "manifest" },
    ])
      expect(
        validEvidenceResponse(runPath, { ...runs, items: [{ ...runs.items[0], ...fields }] }),
      ).toBe(false);
    expect(
      validEvidenceResponse(runPath, {
        ...runs,
        items: [{ ...runs.items[0], startedAt: null, startedAtBasis: null }],
      }),
    ).toBe(true);
    expect(
      validEvidenceResponse(runPath, {
        ...runs,
        items: [
          { ...runs.items[0], completedAt: runs.items[0]!.startedAt, completedAtBasis: "manifest" },
        ],
      }),
    ).toBe(true);
  });
  test("pages cannot exceed the versioned 50-item limit", () => {
    const { runs, artifacts } = evidenceFixture();
    const runItems = Array.from({ length: 51 }, (_, index) => ({
      ...runs.items[0],
      id: `r_${index + 1}`,
    }));
    const artifactItems = Array.from({ length: 51 }, (_, index) => ({
      ...artifacts.items[0],
      id: `a_${index + 1}`,
    }));
    expect(validEvidenceResponse(runPath, { ...runs, items: runItems })).toBe(false);
    expect(validEvidenceResponse(runPath, { ...runs, items: runItems.slice(0, 50) })).toBe(true);
    expect(
      validEvidenceResponse(artifactPath, {
        ...artifacts,
        run: { ...artifacts.run, artifactCount: 51 },
        items: artifactItems,
      }),
    ).toBe(false);
    expect(
      validEvidenceResponse(artifactPath, {
        ...artifacts,
        run: { ...artifacts.run, artifactCount: 51 },
        items: artifactItems.slice(0, 50),
      }),
    ).toBe(true);
  });
  test("only the versioned same-origin JSON routes accept cursor parameters", () => {
    for (const path of [
      "https://outside.test/api/evidence/v1/meta",
      `${base}/meta?cursor=c_1`,
      `${runPath}?cursor=`,
      `${runPath}?cursor=c_1&cursor=c_2`,
      `${runPath}?other=1`,
      `${detailPath}/raw`,
      `${detailPath}?cursor=c_1`,
      `${base}/runs/r_0/artifacts`,
    ])
      expect(evidenceRequest(path)).toBeUndefined();
    expect(evidenceRequest(`${runPath}?cursor=c_99`)).toEqual({
      kind: "runs",
      sourceId: "sony-bank",
      cursor: "c_99",
    });
  });
});
