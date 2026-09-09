// Parser contract v2 helpers: typed issues and container coverage claims.
//
// A parser records what it could not read as a ParseIssue and states what
// scope its output proves as a CoverageClaim (design review D01). The warning
// string a person reads and the issue a policy reads are produced together
// here so they cannot drift apart, but only the issue's code and impact ever
// decide snapshot membership. Everything is deterministic: the same bytes and
// the same artifact metadata produce the same issues and the same claim.

import {
  COVERAGE_FAILURE_CAUSES,
  strongestImpact,
  type AbsenceMeaning,
  type CoverageClaim,
  type CoverageFailureCause,
  type ParseIssue,
} from "../../../../packages/domain/src/coverage.ts";
import type { ArtifactMeta } from "../types.ts";

/** The coverage contract version every claim built here carries. */
export const COVERAGE_POLICY_VERSION = "coverage-v1";

// Bounds of the domain validators (packages/domain/src/guards.ts). A provider
// value that overflows them is cut in the typed record only; the warning
// string keeps the full text for people.
const TEXT_LIMIT = 1024;
const REF_LIMIT = 512;
const CLAIM_ID_LIMIT = 256;
const clip = (text: string, limit = TEXT_LIMIT): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/**
 * Collects the warnings and issues of one parse. `report` records a typed
 * issue and its message as the warning; `note` records an issue that has no
 * warning because nothing was lost (a representation limit worth knowing).
 */
export class ParseDiagnostics {
  readonly warnings: string[] = [];
  readonly issues: ParseIssue[] = [];

  report(issue: ParseIssue): void {
    this.warnings.push(issue.message);
    this.note(issue);
  }

  note(issue: ParseIssue): void {
    this.issues.push({
      ...issue,
      locator: clip(issue.locator),
      message: clip(issue.message),
    });
  }
}

/**
 * Scope key of the complete container an artifact carries. The same key is
 * derived in SQL by `coverageV1Membership` in snapshot-query.ts, so a claim
 * can be matched to the artifact's dataset without free text.
 */
export function containerScopeKey(artifact: ArtifactMeta): string {
  const unit =
    artifact.fetchUnitKey === undefined || artifact.fetchUnitKey === null
      ? ""
      : `/unit=${artifact.fetchUnitKey}`;
  return `${artifact.sourceId}/${artifact.dataset ?? ""}${unit}`;
}

function failureCause(issues: readonly ParseIssue[]): CoverageFailureCause | null {
  for (const issue of issues) {
    if (issue.impact !== "membership" && issue.impact !== "whole-artifact") continue;
    if ((COVERAGE_FAILURE_CAUSES as readonly string[]).includes(issue.code))
      return issue.code as CoverageFailureCause;
  }
  return null;
}

/**
 * The claim of a parser that reads one complete container per artifact. The
 * container is complete exactly when no issue reaches `membership` impact; a
 * field-level or informational issue never demotes it, and a zero-row
 * complete container is a real observation of nothing (`complete-empty`).
 */
export function containerClaim(options: {
  artifact: ArtifactMeta;
  issues: readonly ParseIssue[];
  observedCount: number;
  /** The cardinality the provider or its audited contract states, if any. */
  expectedCount?: number | null;
  /** Locators or page markers that support the claim; never provider values. */
  evidenceRefs: readonly string[];
}): CoverageClaim {
  const impact = strongestImpact(options.issues);
  const complete = impact !== "membership" && impact !== "whole-artifact";
  const cause = complete ? null : failureCause(options.issues);
  const absenceMeaning: AbsenceMeaning =
    options.observedCount > 0
      ? "not-applicable"
      : cause !== null
        ? "not-observed"
        : complete
          ? "complete-empty"
          : "unknown";
  const scopeKey = containerScopeKey(options.artifact);
  return {
    claimId: clip(`container:${scopeKey}`, CLAIM_ID_LIMIT),
    scopeKey,
    mode: "complete-container",
    completeness: complete ? "complete" : "partial",
    membershipComplete: complete,
    observedCount: options.observedCount,
    expectedCount: options.expectedCount ?? null,
    evidenceRefs: [...new Set(options.evidenceRefs.map((ref) => clip(ref, REF_LIMIT)))],
    policyVersion: COVERAGE_POLICY_VERSION,
    failureCause: cause,
    absenceMeaning,
  };
}
