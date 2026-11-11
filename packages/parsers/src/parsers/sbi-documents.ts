import type { ArtifactMeta, Parser } from "../types.ts";
import { containerScopeKey } from "./coverage.ts";
import { unitScopeAdmitted } from "./util.ts";

const DOCUMENT_KEY = /^document-([a-f0-9]{64})-(\d{8})-([a-f0-9]{64})-([a-f0-9]{64})\.pdf$/u;

/** Private original PDFs supply evidence-only coverage, never financial facts. */
export const sbiDocuments: Parser = {
  name: "sbi-delivered-document-metadata",
  version: "1.0.0",
  accepts: (artifact: ArtifactMeta) =>
    artifact.sourceId === "sbi-securities" &&
    artifact.dataset === "delivered-document-pdf" &&
    artifact.mime === "application/pdf",
  parse(bytes, artifact) {
    if (
      (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
      !unitScopeAdmitted(artifact)
    )
      throw new Error("sbi_document_run_ineligible");
    const key = DOCUMENT_KEY.exec(artifact.artifactKey ?? "");
    if (
      !key ||
      !validDate(key[2]!) ||
      key[4] !== artifact.sha256 ||
      artifact.fetchUnitKey !== `mailbox-document-${key[3]}` ||
      bytes.byteLength < 5 ||
      bytes.byteLength > 4 * 1024 * 1024 ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
    )
      throw new Error("sbi_document_metadata_invalid");
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
          evidenceRefs: ["artifact:document", "artifact:sha256", "artifact:basis-date"],
          policyVersion: "coverage-v1",
          failureCause: null,
          absenceMeaning: "not-applicable",
        },
      ],
    };
  },
};

function validDate(value: string): boolean {
  if (value.startsWith("0000")) return false;
  const parsed = new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}T00:00:00.000Z`,
  );
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10).replaceAll("-", "") === value
  );
}
