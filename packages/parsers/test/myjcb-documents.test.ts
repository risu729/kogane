import { expect, test } from "bun:test";
import { creditExportBytes } from "./myjcb-document-fixture.ts";
import { myJcbDocuments } from "../src/parsers/myjcb-documents.ts";
import { validateMyJcbCreditExport } from "../../domain/src/myjcb-statement-export.ts";
import type { ArtifactMeta } from "../src/types.ts";
const artifact = (kind: "csv" | "pdf" | "ofx"): ArtifactMeta => ({
  id: 1,
  sourceId: "myjcb",
  dataset: `credit-${kind}`,
  artifactKey: `synthetic/credit-document-2098-01.${kind}`,
  fetchUnitKey: `synthetic:document:credit:2098-01:${kind}`,
  period: "2098-01",
  statementState: "confirmed",
  mime: kind === "csv" ? "text/csv" : kind === "pdf" ? "application/pdf" : "application/x-ofx",
  runStatus: "partial",
  runFailureCount: 1,
  unitScopeEligibility: "unit-independent-v1",
  fetchedAt: "2098-02-01T00:00:00Z",
  sha256: "a".repeat(64),
  url: null,
});
test("each observed original envelope yields evidence only under its independent successful unit", () => {
  for (const kind of ["csv", "pdf", "ofx"] as const) {
    const meta = artifact(kind);
    expect(myJcbDocuments.accepts(meta)).toBe(true);
    const result = myJcbDocuments.parse(creditExportBytes(kind), meta);
    expect(result.observations).toEqual([]);
    expect(result.coverage?.[0]).toMatchObject({
      mode: "evidence-only",
      completeness: "complete",
      membershipComplete: false,
    });
    expect(() =>
      myJcbDocuments.parse(creditExportBytes(kind), { ...meta, unitScopeEligibility: null }),
    ).toThrow("run_ineligible");
    for (const change of [
      { period: "2098-02" },
      { statementState: "unconfirmed" },
      { fetchUnitKey: "synthetic" },
      { dataset: "credit-other" },
    ])
      expect(() => myJcbDocuments.parse(creditExportBytes(kind), { ...meta, ...change })).toThrow(
        "metadata_invalid",
      );
  }
});
test("file HTML, missing PDF EOF, changed OFX envelope and malformed CSV remain unavailable", () => {
  const text = (value: string) => new TextEncoder().encode(value);
  for (const kind of ["csv", "pdf", "ofx"] as const)
    expect(() => validateMyJcbCreditExport(kind, text("<html>login</html>"))).toThrow();
  expect(() => validateMyJcbCreditExport("pdf", text("%PDF-1.4\ntruncated"))).toThrow();
  const ofx = new TextDecoder().decode(creditExportBytes("ofx"));
  for (const changed of [
    ofx.replace("VERSION:102", "VERSION:103"),
    ofx.replace("</OFX>", ""),
    ofx.replace("<OFX>", "<HTML>"),
  ])
    expect(() => validateMyJcbCreditExport("ofx", text(changed))).toThrow();
  const csv = new TextDecoder("shift_jis").decode(creditExportBytes("csv"));
  // UTF-8 bytes are not accepted as the observed Windows-31j export.
  expect(() => validateMyJcbCreditExport("csv", text(csv))).toThrow();
});

test("CSV requires the observed nonempty opaque preamble before its header", () => {
  const bytes = creditExportBytes("csv");
  const firstLineEnd = bytes.indexOf(10) + 1;
  expect(() => validateMyJcbCreditExport("csv", bytes.subarray(firstLineEnd))).toThrow();
  const blankPreamble = new Uint8Array([13, 10, ...bytes.subarray(firstLineEnd)]);
  expect(() => validateMyJcbCreditExport("csv", blankPreamble)).toThrow();
});
