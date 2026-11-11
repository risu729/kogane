import type { ArtifactMeta, Parser } from "../types.ts";
import { containerScopeKey } from "./coverage.ts";
import { unitScopeAdmitted } from "./util.ts";

/** Documents are immutable evidence, never a second publication of CSV trades. */
export const sbiVcDocuments: Parser = {
  name: "sbi-vc-document-metadata",
  version: "1.0.0",
  accepts: (artifact: ArtifactMeta) =>
    artifact.sourceId === "sbi-vc-trade" &&
    ((artifact.dataset === "monthly-report-pdf" && artifact.mime === "application/pdf") ||
      (artifact.dataset === "pnl-data-zip" && artifact.mime === "application/zip")),
  parse(bytes, artifact) {
    if (
      (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
      !unitScopeAdmitted(artifact)
    )
      throw new Error("sbi_vc_document_run_ineligible");
    const match = /^(monthly-report|pnl-data)-(\d{8})-([a-f0-9]{64})\.(pdf|zip)$/u.exec(
      artifact.artifactKey ?? "",
    );
    const pdf = artifact.dataset === "monthly-report-pdf";
    if (
      !match ||
      !validBasis(match[2]!) ||
      match[3] !== artifact.sha256 ||
      match[1] !== (pdf ? "monthly-report" : "pnl-data") ||
      match[4] !== (pdf ? "pdf" : "zip") ||
      artifact.fetchUnitKey !== `${match[1]}-${match[2]}` ||
      bytes.length > 4 * 1024 * 1024 ||
      (pdf
        ? new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
        : bytes.length < 4 ||
          bytes[0] !== 0x50 ||
          bytes[1] !== 0x4b ||
          bytes[2] !== 3 ||
          bytes[3] !== 4)
    )
      throw new Error("sbi_vc_document_metadata_invalid");
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

function validBasis(text: string): boolean {
  const year = Number(text.slice(0, 4));
  if (year < 2018) return false;
  const date = new Date(Date.UTC(year, Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8))));
  return date.toISOString().slice(0, 10).replaceAll("-", "") === text;
}
