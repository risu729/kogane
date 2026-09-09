// A12: a fixed report artifact is not a rebuildable projection (AR03), and a
// preserved body is not a claim that the calculation can be replayed
// (addendum 06 section 6; UC60/AT60, UC66/AT66).
import { describe, expect, test } from "bun:test";
import {
  replayabilityFor,
  replayCapabilities,
  reportBodyDigest,
  reportStorageRef,
  REPORT_EVENT_KINDS,
  REPORT_OPERATIONS,
  validReportArtifact,
  validReportBody,
  validReportEvent,
  type EvidenceUseRestriction,
  type ReportBody,
} from "../src/reports.ts";
import { integerDecimal } from "../src/values.ts";

const body: ReportBody = {
  schemaVersion: "report-holdings-v1",
  purpose: "holdings-view",
  contextId: "ctx-c1",
  calculationRunId: "run-1",
  policyRefs: ["instrument-valuation-v1", "rounding-jpy-v1"],
  unitRef: "JPY",
  partition: "partial-verified-scope",
  subtotal: integerDecimal(10_000),
  rows: [
    {
      subjectRef: "holding:fund",
      scopeRef: "scope:fund",
      metric: "holdings.valuation",
      unitRef: "JPY",
      valued: true,
      value: integerDecimal(10_000),
    },
    {
      subjectRef: "holding:aud-cash",
      scopeRef: "scope:aud",
      metric: "holdings.valuation",
      unitRef: "JPY",
      valued: false,
      unvaluedReason: "missing-price",
    },
  ],
  coverage: { scopeRef: "perimeter:synthetic", coveredRef: "adopted:synthetic", truncated: false },
};

const restriction: EvidenceUseRestriction = {
  evidenceRef: "claim:nav:1",
  restriction: "no-reuse",
  since: "2026-09-09T00:00:00.000Z",
  affectedManifests: ["ctx-c1"],
  actor: "operator:synthetic",
  reason: "synthetic exclusion drill",
};

describe("report bodies and their digests", () => {
  test("the body validates, carries no locator into the raw store, and digests deterministically", async () => {
    expect(validReportBody(body)).toBe(true);
    const digest = await reportBodyDigest(body);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    // Key order in the body is irrelevant: the canonical form fixes it.
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(body).reverse())),
    ) as ReportBody;
    expect(await reportBodyDigest(reordered)).toBe(digest);
    // Changing one row changes the digest.
    const changed: ReportBody = { ...body, subtotal: integerDecimal(10_001) };
    expect(await reportBodyDigest(changed)).not.toBe(digest);
    expect(JSON.stringify(body)).not.toContain("raw_locator");
  });

  test("a not-computable body cannot carry a subtotal, and an unknown unvalued reason is rejected", () => {
    expect(validReportBody({ ...body, partition: "not-computable" })).toBe(false);
    expect(validReportBody({ ...body, partition: "not-computable", subtotal: null })).toBe(true);
    expect(
      validReportBody({
        ...body,
        rows: [{ ...body.rows[1], unvaluedReason: "we-did-not-look" }],
      }),
    ).toBe(false);
  });

  test("the storage key is the digest under the reports prefix, and the artifact must agree", async () => {
    const contentDigest = await reportBodyDigest(body);
    const artifact = {
      reportId: "R1",
      contextId: "ctx-c1",
      purpose: "holdings-view" as const,
      schemaVersion: "report-holdings-v1",
      contentDigest,
      storageRef: reportStorageRef(contentDigest),
      createdBy: "report-job",
      createdAt: "2026-08-31T15:00:00.000Z",
    };
    expect(artifact.storageRef).toBe(`reports/${contentDigest}`);
    expect(validReportArtifact(artifact)).toBe(true);
    expect(validReportArtifact({ ...artifact, storageRef: "reports/other" })).toBe(false);
  });
});

describe("report events", () => {
  test("generated, confirmed, shared, submitted, corrected and superseded are separate facts", () => {
    expect([...REPORT_EVENT_KINDS]).toEqual([
      "generated",
      "confirmed",
      "shared",
      "submitted",
      "corrected",
      "superseded",
    ]);
    expect(
      validReportEvent({
        reportId: "R1",
        kind: "submitted",
        actor: "person:synthetic",
        relatedReportId: null,
        occurredAt: "2026-08-31T15:00:00.000Z",
      }),
    ).toBe(true);
    // A correction names the report it corrects; a submission does not.
    expect(
      validReportEvent({
        reportId: "R2",
        kind: "corrected",
        actor: "person:synthetic",
        relatedReportId: "R1",
        occurredAt: "2026-09-08T15:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      validReportEvent({
        reportId: "R2",
        kind: "submitted",
        actor: "person:synthetic",
        relatedReportId: "R1",
        occurredAt: "2026-09-08T15:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      validReportEvent({
        reportId: "R1",
        kind: "corrected",
        actor: "person:synthetic",
        relatedReportId: "R1",
        occurredAt: "2026-09-08T15:00:00.000Z",
      }),
    ).toBe(false);
  });

  test("re-display, recompute and share-a-correction are three named operations", () => {
    expect([...REPORT_OPERATIONS]).toEqual([
      "re-display",
      "recompute-under-current-rules",
      "share-corrected-version",
    ]);
  });
});

describe("replayability is derived, not asserted", () => {
  test("inputs present is replayable; only the body left is artifact-preserved; nothing left is unavailable", () => {
    expect(replayabilityFor({ inputsPresent: true, artifactPresent: true, restrictions: [] })).toBe(
      "replayable",
    );
    expect(
      replayabilityFor({ inputsPresent: false, artifactPresent: true, restrictions: [] }),
    ).toBe("artifact-preserved");
    expect(
      replayabilityFor({ inputsPresent: false, artifactPresent: false, restrictions: [] }),
    ).toBe("unavailable");
  });

  test("AT66 a use restriction wins over a preserved digest", () => {
    for (const kind of ["no-reuse", "deleted", "key-destroyed"] as const)
      expect(
        replayabilityFor({
          inputsPresent: true,
          artifactPresent: true,
          restrictions: [{ ...restriction, restriction: kind }],
        }),
      ).toBe("restricted");
  });

  test("AT66 restricted and unavailable refuse explanation and export; restricted also purges cached explanations", () => {
    expect(replayCapabilities("replayable")).toEqual({
      explain: true,
      export: true,
      recompute: true,
      purgeCachedExplanations: false,
    });
    expect(replayCapabilities("artifact-preserved")).toEqual({
      explain: true,
      export: true,
      recompute: false,
      purgeCachedExplanations: false,
    });
    expect(replayCapabilities("restricted")).toEqual({
      explain: false,
      export: false,
      recompute: false,
      purgeCachedExplanations: true,
    });
    expect(replayCapabilities("unavailable")).toEqual({
      explain: false,
      export: false,
      recompute: false,
      purgeCachedExplanations: false,
    });
  });
});
