import type { Parser } from "../types.ts";
import { containerScopeKey } from "./coverage.ts";
import { unitScopeAdmitted } from "./util.ts";
/** Validate the archived PDF envelope; never infer its financial contents. */
export const sonyBankDocumentMetadata: Parser = {
  name: "sony-bank-document-metadata",
  version: "1.0.0",
  accepts: (artifact) =>
    artifact.sourceId === "sony-bank" && artifact.dataset === "delivered-document-pdf",
  parse(bytes, artifact) {
    const key = /^delivered-document-(\d{4})\.pdf$/u.exec(artifact.artifactKey ?? "");
    if (
      ((artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
        !unitScopeAdmitted(artifact)) ||
      !key ||
      artifact.fetchUnitKey !== `delivered-document-${key[1]}` ||
      artifact.mime !== "application/pdf" ||
      bytes.byteLength < 5 ||
      bytes.byteLength > 1024 * 1024 ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
    )
      throw new Error("sony_document_metadata_invalid");
    const scopeKey = containerScopeKey(artifact);
    return {
      observations: [],
      warnings: [],
      issues: [],
      coverage: [
        {
          claimId: `document:${scopeKey}`,
          scopeKey,
          mode: "evidence-only",
          completeness: "complete",
          membershipComplete: false,
          observedCount: 1,
          expectedCount: 1,
          evidenceRefs: ["artifact:pdf", "artifact:sha256", "artifact:document-list"],
          policyVersion: "coverage-v1",
          failureCause: null,
          absenceMeaning: "not-applicable",
        },
      ],
    };
  },
};
