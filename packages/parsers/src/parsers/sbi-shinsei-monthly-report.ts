import type { ArtifactMeta, Parser } from "../types.ts";
import { assertSuccessfulRun } from "./sbi-shinsei-common.ts";
import { containerScopeKey } from "./coverage.ts";

const KEY = /^monthly-report-(\d{4}-(?:0[1-9]|1[0-2]))-([a-f0-9]{64})\.pdf$/u;
/** Metadata validation only. The Processor verifies stored bytes against sha256 before calling a parser. */
export const sbiShinseiMonthlyReport: Parser = {
  name: "sbi-shinsei-monthly-report-metadata",
  version: "1.0.0",
  accepts: (artifact: ArtifactMeta) =>
    artifact.sourceId === "sbi-shinsei-bank" &&
    artifact.dataset === "monthly-report-pdf" &&
    artifact.mime === "application/pdf",
  parse(bytes, artifact) {
    assertSuccessfulRun(artifact);
    const key = artifact.artifactKey?.match(KEY);
    if (
      !key ||
      key[1]!.startsWith("0000-") ||
      key[2] !== artifact.sha256 ||
      artifact.fetchUnitKey !== `monthly-report-${key[1]}` ||
      bytes.byteLength < 5 ||
      bytes.byteLength > 1024 * 1024 ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
    )
      throw new Error("monthly_report_metadata_invalid");
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
          evidenceRefs: ["artifact:pdf", "artifact:sha256", "artifact:month"],
          policyVersion: "coverage-v1",
          failureCause: null,
          absenceMeaning: "not-applicable",
        },
      ],
    };
  },
};
