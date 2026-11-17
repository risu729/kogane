import { expect, test } from "bun:test";
import { sonyBankDocumentMetadata } from "../src/parsers/sony-document-metadata";
import type { ArtifactMeta } from "../src/types";
const meta: ArtifactMeta = {
  id: 1,
  sourceId: "sony-bank",
  runStatus: "partial",
  runFailureCount: 1,
  unitScopeEligibility: "unit-independent-v1",
  dataset: "delivered-document-pdf",
  artifactKey: "delivered-document-0001.pdf",
  fetchUnitKey: "delivered-document-0001",
  url: null,
  mime: "application/pdf",
  fetchedAt: "2099-01-01T00:00:00Z",
  sha256: "a".repeat(64),
};
test("a validated PDF records evidence-only coverage without financial observations", () => {
  const result = sonyBankDocumentMetadata.parse(new TextEncoder().encode("%PDF-synthetic"), meta);
  expect(result.observations).toEqual([]);
  expect(result.coverage?.[0]).toMatchObject({
    mode: "evidence-only",
    membershipComplete: false,
    observedCount: 1,
    absenceMeaning: "not-applicable",
  });
  expect(() => sonyBankDocumentMetadata.parse(new TextEncoder().encode("<html>"), meta)).toThrow();
  expect(() =>
    sonyBankDocumentMetadata.parse(new TextEncoder().encode("%PDF-"), {
      ...meta,
      unitScopeEligibility: null,
    }),
  ).toThrow();
  expect(() =>
    sonyBankDocumentMetadata.parse(new TextEncoder().encode("%PDF-"), {
      ...meta,
      fetchUnitKey: "account",
    }),
  ).toThrow();
});
