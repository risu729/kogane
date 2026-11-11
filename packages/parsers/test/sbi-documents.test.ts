import { expect, test } from "bun:test";
import { sbiDocuments } from "../src/parsers/sbi-documents.ts";
import { sbiDocumentFixture } from "./sbi-documents-fixture.ts";

test("original SBI PDFs supply only evidence coverage and partial parents require independent unit admission", () => {
  const { bytes, meta } = sbiDocumentFixture();
  expect(sbiDocuments.accepts(meta)).toBe(true);
  const result = sbiDocuments.parse(bytes, meta);
  expect(result.observations).toEqual([]);
  expect(result.coverage).toMatchObject([
    {
      mode: "evidence-only",
      completeness: "complete",
      membershipComplete: false,
      observedCount: 1,
      expectedCount: 1,
    },
  ]);
  const partial = { ...meta, runStatus: "partial" as const, runFailureCount: 1 };
  expect(() => sbiDocuments.parse(bytes, partial)).toThrow("sbi_document_run_ineligible");
  expect(
    sbiDocuments.parse(bytes, { ...partial, unitScopeEligibility: "unit-independent-v1" }).coverage,
  ).toHaveLength(1);
  expect(sbiDocuments.accepts({ ...meta, sourceId: "sbi-vc-trade" })).toBe(false);
});

test("refuses digest, calendar, identity, media and original-byte mismatches", () => {
  const { bytes, meta } = sbiDocumentFixture();
  for (const changed of [
    { ...meta, sha256: "0".repeat(64) },
    { ...meta, fetchUnitKey: `mailbox-document-${"c".repeat(64)}` },
    { ...meta, artifactKey: meta.artifactKey!.replace("20990101", "20990230") },
    { ...meta, artifactKey: meta.artifactKey!.replace(".pdf", ".zip") },
  ])
    expect(() => sbiDocuments.parse(bytes, changed)).toThrow("sbi_document_metadata_invalid");
  expect(() => sbiDocuments.parse(new TextEncoder().encode("not a PDF"), meta)).toThrow(
    "sbi_document_metadata_invalid",
  );
  expect(sbiDocuments.accepts({ ...meta, mime: "application/json" })).toBe(false);
});
