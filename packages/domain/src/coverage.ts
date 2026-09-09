// Coverage is a claim about a scope, separate from parser diagnostics and
// from whether a run succeeded. A successful run with a 30-day window is not
// full history; a complete empty container is a real observation of nothing.
import { hasExactKeys, isOneOf, isRecord, isRefList, isSafeInt, isText } from "./guards.ts";

export const COVERAGE_MODES = [
  "complete-container",
  "window",
  "event-feed",
  "evidence-only",
] as const;
export type CoverageMode = (typeof COVERAGE_MODES)[number];
export const COMPLETENESS = ["complete", "partial", "unknown"] as const;
export type Completeness = (typeof COMPLETENESS)[number];
export const ABSENCE_MEANINGS = [
  "complete-empty",
  "window-no-events",
  "not-observed",
  "unknown",
  "not-applicable",
] as const;
export type AbsenceMeaning = (typeof ABSENCE_MEANINGS)[number];
export const COVERAGE_FAILURE_CAUSES = [
  "auth_failed",
  "fetch_failed",
  "page_missing",
  "container_unreadable",
  "row_unreadable",
  "collector_error",
] as const;
export type CoverageFailureCause = (typeof COVERAGE_FAILURE_CAUSES)[number];

export interface CoverageClaim {
  claimId: string;
  /** Key derived from the dataset / unit / window / container contract, not free text. */
  scopeKey: string;
  mode: CoverageMode;
  completeness: Completeness;
  membershipComplete: boolean;
  observedCount: number;
  expectedCount: number | null;
  /** Manifest, page, or empty-display evidence supporting the claim. */
  evidenceRefs: string[];
  policyVersion: string;
  failureCause: CoverageFailureCause | null;
  /** What zero rows mean for this claim. */
  absenceMeaning: AbsenceMeaning;
}

export const PARSE_ISSUE_CODES = [
  "container_unreadable",
  "row_unreadable",
  "unknown_fields_preserved",
  "exact_decimal_without_minor_units",
] as const;
export type ParseIssueCode = (typeof PARSE_ISSUE_CODES)[number];
export const ISSUE_SEVERITIES = ["info", "warning", "error"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];
export const ISSUE_IMPACTS = ["none", "field", "membership", "whole-artifact"] as const;
export type IssueImpact = (typeof ISSUE_IMPACTS)[number];

export interface ParseIssue {
  code: ParseIssueCode;
  locator: string;
  severity: IssueSeverity;
  impact: IssueImpact;
  /** For people and monitoring; never a machine adoption condition. */
  message: string;
}

export const SNAPSHOT_ELIGIBILITY_REASONS = [
  "complete_container",
  "complete_empty_container",
  "no_new_observation",
  "partial_membership",
  "coverage_unknown",
  "window_absence_only",
  "event_feed_not_snapshot",
  "evidence_only",
] as const;
export type SnapshotEligibilityReason = (typeof SNAPSHOT_ELIGIBILITY_REASONS)[number];
export interface SnapshotEligibility {
  /** True only when the claim may replace the previous holdings membership for its scope. */
  replacesPrevious: boolean;
  reasonCode: SnapshotEligibilityReason;
}

export function validCoverageClaim(value: unknown): value is CoverageClaim {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "claimId",
      "scopeKey",
      "mode",
      "completeness",
      "membershipComplete",
      "observedCount",
      "expectedCount",
      "evidenceRefs",
      "policyVersion",
      "failureCause",
      "absenceMeaning",
    ]) &&
    isText(value.claimId, 256) &&
    isText(value.scopeKey, 1024) &&
    isOneOf(COVERAGE_MODES)(value.mode) &&
    isOneOf(COMPLETENESS)(value.completeness) &&
    typeof value.membershipComplete === "boolean" &&
    isSafeInt(value.observedCount, 0) &&
    (value.expectedCount === null || isSafeInt(value.expectedCount, 0)) &&
    isRefList(value.evidenceRefs) &&
    isText(value.policyVersion, 64) &&
    (value.failureCause === null || isOneOf(COVERAGE_FAILURE_CAUSES)(value.failureCause)) &&
    isOneOf(ABSENCE_MEANINGS)(value.absenceMeaning)
  );
}

export function validParseIssue(value: unknown): value is ParseIssue {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "locator", "severity", "impact", "message"]) &&
    isOneOf(PARSE_ISSUE_CODES)(value.code) &&
    isText(value.locator, 1024) &&
    isOneOf(ISSUE_SEVERITIES)(value.severity) &&
    isOneOf(ISSUE_IMPACTS)(value.impact) &&
    isText(value.message, 1024)
  );
}

/** Cross-field rules that the shape check cannot express; an empty list means consistent. */
export function coverageClaimViolations(claim: CoverageClaim): string[] {
  const violations: string[] = [];
  if (claim.membershipComplete && claim.completeness !== "complete")
    violations.push("membership_complete_requires_complete");
  if (claim.membershipComplete && claim.failureCause !== null)
    violations.push("membership_complete_with_failure");
  if (claim.failureCause !== null && claim.completeness === "complete")
    violations.push("failure_with_complete_coverage");
  if (claim.expectedCount !== null && claim.observedCount > claim.expectedCount)
    violations.push("observed_exceeds_expected");
  if (
    claim.completeness === "complete" &&
    claim.expectedCount !== null &&
    claim.observedCount < claim.expectedCount
  )
    violations.push("complete_but_count_short");
  if (claim.observedCount === 0) {
    const expected: AbsenceMeaning | null =
      claim.failureCause !== null
        ? "not-observed"
        : claim.completeness !== "complete"
          ? "unknown"
          : claim.mode === "complete-container"
            ? "complete-empty"
            : claim.mode === "window"
              ? "window-no-events"
              : null;
    if (expected !== null && claim.absenceMeaning !== expected)
      violations.push(`absence_meaning_should_be_${expected}`);
  } else if (claim.absenceMeaning !== "not-applicable")
    violations.push("absence_meaning_with_rows");
  return violations;
}

/**
 * SC15: only a complete, membership-complete container snapshot replaces the
 * previous holdings for its scope, even when it is empty. Partial pages, a
 * failed fetch, and a complete-but-empty history window never do.
 */
export function snapshotEligibility(claim: CoverageClaim): SnapshotEligibility {
  if (claim.failureCause !== null)
    return { replacesPrevious: false, reasonCode: "no_new_observation" };
  if (
    claim.completeness === "partial" ||
    (claim.completeness === "complete" && !claim.membershipComplete)
  )
    return { replacesPrevious: false, reasonCode: "partial_membership" };
  if (claim.completeness === "unknown")
    return { replacesPrevious: false, reasonCode: "coverage_unknown" };
  switch (claim.mode) {
    case "complete-container":
      return {
        replacesPrevious: true,
        reasonCode: claim.observedCount === 0 ? "complete_empty_container" : "complete_container",
      };
    case "window":
      return { replacesPrevious: false, reasonCode: "window_absence_only" };
    case "event-feed":
      return { replacesPrevious: false, reasonCode: "event_feed_not_snapshot" };
    case "evidence-only":
      return { replacesPrevious: false, reasonCode: "evidence_only" };
  }
}

const IMPACT_RANK: Record<IssueImpact, number> = {
  none: 0,
  field: 1,
  membership: 2,
  "whole-artifact": 3,
};

/** Strongest impact among issues; severity is deliberately ignored (a warning can still break membership). */
export function strongestImpact(issues: readonly ParseIssue[]): IssueImpact {
  let strongest: IssueImpact = "none";
  for (const issue of issues)
    if (IMPACT_RANK[issue.impact] > IMPACT_RANK[strongest]) strongest = issue.impact;
  return strongest;
}
