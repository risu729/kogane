import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sbiVcDocuments } from "../src/parsers/sbi-vc-documents.ts";
import type { ArtifactMeta } from "../src/types.ts";

function document(zip = false) {
  const bytes = zip
    ? Uint8Array.from([0x50, 0x4b, 3, 4, 0])
    : new TextEncoder().encode("%PDF-1.7\nSynthetic document\n%%EOF");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const kind = zip ? "pnl-data" : "monthly-report";
  const meta: ArtifactMeta = {
    id: 1,
    sourceId: "sbi-vc-trade",
    runStatus: "success",
    runFailureCount: 0,
    dataset: zip ? "pnl-data-zip" : "monthly-report-pdf",
    artifactKey: `${kind}-20260930-${sha256}.${zip ? "zip" : "pdf"}`,
    fetchUnitKey: `${kind}-20260930`,
    url: null,
    mime: zip ? "application/zip" : "application/pdf",
    fetchedAt: "2026-11-10T00:00:00Z",
    sha256,
  };
  return { bytes, meta };
}

describe("SBI VC immutable document metadata", () => {
  test("publishes evidence-only coverage and no economic rows for either native format", () => {
    for (const zip of [false, true]) {
      const { bytes, meta } = document(zip);
      expect(sbiVcDocuments.accepts(meta)).toBe(true);
      const result = sbiVcDocuments.parse(bytes, meta);
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
      expect(sbiVcDocuments.accepts({ ...meta, sourceId: "sbi-securities" })).toBe(false);
      expect(sbiVcDocuments.accepts({ ...meta, mime: "application/json" })).toBe(false);
    }
  });
  test("partial-parent metadata needs explicit successful-unit admission", () => {
    const { bytes, meta } = document();
    const partial = { ...meta, runStatus: "partial" as const, runFailureCount: 1 };
    expect(() => sbiVcDocuments.parse(bytes, partial)).toThrow("sbi_vc_document_run_ineligible");
    expect(
      sbiVcDocuments.parse(bytes, { ...partial, unitScopeEligibility: "unit-independent-v1" })
        .observations,
    ).toEqual([]);
  });
  test("rejects identity, hash, calendar and native-signature mismatches", () => {
    const { bytes, meta } = document();
    for (const changed of [
      { ...meta, sha256: "0".repeat(64) },
      { ...meta, fetchUnitKey: "monthly-report-20260831" },
      { ...meta, artifactKey: meta.artifactKey!.replace("20260930", "20260931") },
      { ...meta, artifactKey: meta.artifactKey!.replace(".pdf", ".zip") },
    ])
      expect(() => sbiVcDocuments.parse(bytes, changed)).toThrow(
        "sbi_vc_document_metadata_invalid",
      );
    expect(() =>
      sbiVcDocuments.parse(
        new TextEncoder().encode(JSON.stringify({ type: "Buffer", data: [...bytes] })),
        meta,
      ),
    ).toThrow("sbi_vc_document_metadata_invalid");
  });
});
