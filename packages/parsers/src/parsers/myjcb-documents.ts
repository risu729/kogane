import {
  validateMyJcbCreditExport,
  type MyJcbExportKind,
} from "../../../domain/src/myjcb-statement-export.ts";
import type { ArtifactMeta, Parser } from "../types.ts";
import { containerScopeKey } from "./coverage.ts";
import { unitScopeAdmitted } from "./util.ts";

/** Original exports are evidence; their CSV/OFX rows never duplicate HTML observations. */
export const myJcbDocuments: Parser = {
  name: "myjcb-statement-document-metadata",
  version: "1.0.0",
  accepts: (artifact: ArtifactMeta) =>
    artifact.sourceId === "myjcb" &&
    ((artifact.dataset === "credit-csv" && artifact.mime === "text/csv") ||
      (artifact.dataset === "credit-pdf" && artifact.mime === "application/pdf") ||
      (artifact.dataset === "credit-ofx" && artifact.mime === "application/x-ofx")),
  parse(bytes, artifact) {
    if (
      (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
      !unitScopeAdmitted(artifact)
    )
      throw new Error("myjcb_document_run_ineligible");
    const match =
      /^([a-z0-9][a-z0-9-]{0,63})\/credit-document-(\d{4}-(?:0[1-9]|1[0-2]))\.(csv|pdf|ofx)$/u.exec(
        artifact.artifactKey ?? "",
      );
    if (
      !match ||
      artifact.dataset !== `credit-${match[3]}` ||
      artifact.period !== match[2] ||
      artifact.statementState !== "confirmed" ||
      artifact.fetchUnitKey !== `${match[1]}:document:credit:${match[2]}:${match[3]}`
    )
      throw new Error("myjcb_document_metadata_invalid");
    validateMyJcbCreditExport(match[3] as MyJcbExportKind, bytes);
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
          evidenceRefs: [
            "artifact:original-export",
            "artifact:sha256",
            "artifact:page-period-provenance",
          ],
          policyVersion: "coverage-v1",
          failureCause: null,
          absenceMeaning: "not-applicable",
        },
      ],
    };
  },
};
