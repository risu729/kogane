import { describe, expect, test } from "bun:test";
import {
  coverageClaimViolations,
  snapshotEligibility,
  strongestImpact,
  validCoverageClaim,
  validParseIssue,
  type CoverageClaim,
  type ParseIssue,
} from "../src/coverage.ts";

const claim = (overrides: Partial<CoverageClaim>): CoverageClaim => ({
  claimId: "cov:1",
  scopeKey: "broker:positions:container",
  mode: "complete-container",
  completeness: "complete",
  membershipComplete: true,
  observedCount: 3,
  expectedCount: 3,
  evidenceRefs: ["ev:page:1"],
  policyVersion: "coverage-v1",
  failureCause: null,
  absenceMeaning: "not-applicable",
  ...overrides,
});

describe("CoverageClaim", () => {
  test("shape validation rejects unknown keys and inconsistent counts", () => {
    expect(validCoverageClaim(claim({}))).toBe(true);
    expect(validCoverageClaim({ ...claim({}), warnings: [] })).toBe(false);
    expect(validCoverageClaim(claim({ observedCount: -1 }))).toBe(false);
    expect(validCoverageClaim(claim({ failureCause: "network" as never }))).toBe(false);
    expect(coverageClaimViolations(claim({}))).toEqual([]);
    expect(coverageClaimViolations(claim({ observedCount: 5 }))).toEqual([
      "observed_exceeds_expected",
    ]);
    expect(coverageClaimViolations(claim({ observedCount: 2 }))).toEqual([
      "complete_but_count_short",
    ]);
    expect(coverageClaimViolations(claim({ completeness: "partial" }))).toEqual([
      "membership_complete_requires_complete",
    ]);
    expect(coverageClaimViolations(claim({ failureCause: "page_missing" }))).toEqual([
      "membership_complete_with_failure",
      "failure_with_complete_coverage",
    ]);
    expect(
      coverageClaimViolations(
        claim({ observedCount: 0, expectedCount: 0, absenceMeaning: "not-applicable" }),
      ),
    ).toEqual(["absence_meaning_should_be_complete-empty"]);
    expect(coverageClaimViolations(claim({ absenceMeaning: "complete-empty" }))).toEqual([
      "absence_meaning_with_rows",
    ]);
  });

  test("SC15: only a complete container snapshot replaces previous holdings, even when empty", () => {
    expect(
      snapshotEligibility(
        claim({ observedCount: 0, expectedCount: 0, absenceMeaning: "complete-empty" }),
      ),
    ).toEqual({
      replacesPrevious: true,
      reasonCode: "complete_empty_container",
    });
    expect(snapshotEligibility(claim({}))).toEqual({
      replacesPrevious: true,
      reasonCode: "complete_container",
    });
    expect(
      snapshotEligibility(
        claim({
          completeness: "partial",
          membershipComplete: false,
          observedCount: 0,
          expectedCount: null,
          absenceMeaning: "unknown",
        }),
      ),
    ).toEqual({ replacesPrevious: false, reasonCode: "partial_membership" });
    expect(
      snapshotEligibility(
        claim({
          completeness: "unknown",
          membershipComplete: false,
          observedCount: 0,
          expectedCount: null,
          failureCause: "auth_failed",
          absenceMeaning: "not-observed",
        }),
      ),
    ).toEqual({ replacesPrevious: false, reasonCode: "no_new_observation" });
    expect(
      snapshotEligibility(
        claim({
          mode: "window",
          observedCount: 0,
          expectedCount: null,
          absenceMeaning: "window-no-events",
        }),
      ),
    ).toEqual({ replacesPrevious: false, reasonCode: "window_absence_only" });
    expect(snapshotEligibility(claim({ mode: "event-feed" }))).toEqual({
      replacesPrevious: false,
      reasonCode: "event_feed_not_snapshot",
    });
    expect(snapshotEligibility(claim({ mode: "evidence-only" }))).toEqual({
      replacesPrevious: false,
      reasonCode: "evidence_only",
    });
    // A complete claim without membership completeness (e.g. a numerically exact but page-short parse) never replaces.
    expect(snapshotEligibility(claim({ membershipComplete: false }))).toEqual({
      replacesPrevious: false,
      reasonCode: "partial_membership",
    });
    expect(
      snapshotEligibility(
        claim({ completeness: "unknown", membershipComplete: false, expectedCount: null }),
      ),
    ).toEqual({ replacesPrevious: false, reasonCode: "coverage_unknown" });
  });
});

describe("ParseIssue", () => {
  const issue = (overrides: Partial<ParseIssue>): ParseIssue => ({
    code: "unknown_fields_preserved",
    locator: "json:$.rows[3]",
    severity: "warning",
    impact: "none",
    message: "Unknown fields were kept in extra.",
    ...overrides,
  });

  test("severity and impact are independent; the strongest impact wins", () => {
    expect(validParseIssue(issue({}))).toBe(true);
    expect(validParseIssue(issue({ code: "typo" as never }))).toBe(false);
    expect(validParseIssue({ ...issue({}), hint: "x" })).toBe(false);
    expect(strongestImpact([])).toBe("none");
    expect(
      strongestImpact([
        issue({ severity: "error", impact: "field" }),
        issue({ severity: "info", impact: "membership", code: "row_unreadable" }),
      ]),
    ).toBe("membership");
    expect(
      strongestImpact([issue({ impact: "whole-artifact", code: "container_unreadable" })]),
    ).toBe("whole-artifact");
    expect(
      strongestImpact([issue({ code: "exact_decimal_without_minor_units", severity: "info" })]),
    ).toBe("none");
  });
});
