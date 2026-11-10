import { expect, test } from "bun:test";
import { sbiShinseiMonthlyReport } from "../src/parsers/sbi-shinsei-monthly-report.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { coverageClaimViolations, snapshotEligibility } from "../../domain/src/coverage.ts";
const bytes = new TextEncoder().encode("%PDF-1.7\nsynthetic\n%%EOF");
const artifact: ArtifactMeta = {
  id: 1,
  sourceId: "sbi-shinsei-bank",
  dataset: "monthly-report-pdf",
  runStatus: "success",
  runFailureCount: 0,
  artifactKey: `monthly-report-2099-01-${"a".repeat(64)}.pdf`,
  fetchUnitKey: "monthly-report-2099-01",
  url: null,
  mime: "application/pdf",
  fetchedAt: "2099-02-01T00:00:00.000Z",
  sha256: "a".repeat(64),
};
test("records one document's evidence coverage and creates no financial observations", () => {
  const result = sbiShinseiMonthlyReport.parse(bytes, artifact);
  expect(result.observations).toEqual([]);
  expect(result.coverage).toHaveLength(1);
  expect(result.coverage![0]).toMatchObject({
    mode: "evidence-only",
    completeness: "complete",
    membershipComplete: false,
    observedCount: 1,
    expectedCount: 1,
  });
  expect(coverageClaimViolations(result.coverage![0]!)).toEqual([]);
  expect(snapshotEligibility(result.coverage![0]!).replacesPrevious).toBe(false);
});
test("metadata identity, media, byte bounds and PDF magic fail closed", () => {
  for (const changed of [
    { ...artifact, sha256: "b".repeat(64) },
    { ...artifact, fetchUnitKey: "monthly-report-2099-02" },
    { ...artifact, artifactKey: "provider-private-name.pdf" },
    { ...artifact, runStatus: "partial" as const, runFailureCount: 1 },
  ])
    expect(() => sbiShinseiMonthlyReport.parse(bytes, changed)).toThrow();
  expect(() => sbiShinseiMonthlyReport.parse(new Uint8Array(1024 * 1024 + 1), artifact)).toThrow();
  expect(() =>
    sbiShinseiMonthlyReport.parse(new TextEncoder().encode("<html>"), artifact),
  ).toThrow();
  expect(sbiShinseiMonthlyReport.accepts({ ...artifact, mime: "text/html" })).toBe(false);
  expect(
    sbiShinseiMonthlyReport.parse(bytes, {
      ...artifact,
      runStatus: "partial",
      runFailureCount: 1,
      unitScopeEligibility: "unit-independent-v1",
    }).coverage![0]!.completeness,
  ).toBe("complete");
});
