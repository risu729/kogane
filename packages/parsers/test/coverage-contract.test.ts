// Parser contract v2 (design review D01, PR-07): every snapshot-dataset parser
// emits typed issues and one container coverage claim, and its observations
// and warning strings are byte-identical to the pre-change parser output
// frozen in fixtures/coverage-contract/expected.json.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  coverageClaimViolations,
  validCoverageClaim,
  validParseIssue,
  type AbsenceMeaning,
  type Completeness,
  type CoverageFailureCause,
  type ParseIssueCode,
} from "../../domain/src/coverage.ts";
import { containerScopeKey, COVERAGE_POLICY_VERSION } from "../src/parsers/coverage.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import { SNAPSHOT_DATASETS } from "../src/snapshot-query.ts";
import type { Observation } from "../src/types.ts";
import { CONTRACT_PARSERS } from "./coverage-contract-cases.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

type Frozen = { observations: Observation[]; warnings: string[] } | { error: true };
const FROZEN: Record<string, Record<string, Frozen>> = JSON.parse(
  readFileSync(join(FIXTURES_ROOT, "coverage-contract", "expected.json"), "utf8"),
);

interface Expectation {
  completeness: Completeness;
  observed: number;
  expected?: number | null;
  absence: AbsenceMeaning;
  failureCause?: CoverageFailureCause | null;
  codes: ParseIssueCode[];
}
const complete = (observed: number, codes: ParseIssueCode[] = []): Expectation => ({
  completeness: "complete",
  observed,
  absence: observed === 0 ? "complete-empty" : "not-applicable",
  failureCause: null,
  codes,
});
const partial = (
  observed: number,
  failureCause: CoverageFailureCause,
  codes: ParseIssueCode[],
): Expectation => ({
  completeness: "partial",
  observed,
  absence: observed === 0 ? "not-observed" : "not-applicable",
  failureCause,
  codes,
});

/** What each case must claim. A throwing case has no claim and no entry here. */
const CLAIMS: Record<string, Record<string, Expectation>> = {
  "sbi-foreign-cash-balances": {
    "complete-empty": complete(0),
    "complete-rows": complete(2),
    "unreadable-container": partial(0, "container_unreadable", [
      "container_unreadable",
      "container_unreadable",
    ]),
    "partial-empty": partial(0, "container_unreadable", ["container_unreadable"]),
    "unknown-fields": complete(1, ["unknown_fields_preserved"]),
    "minor-units": complete(1, ["exact_decimal_without_minor_units"]),
    "unreadable-field": partial(1, "row_unreadable", ["row_unreadable"]),
  },
  "sbi-foreign-cash-positions": {
    "complete-empty": complete(0),
    "complete-rows": complete(3),
    "minor-units": complete(2, ["exact_decimal_without_minor_units"]),
    "unreadable-row": partial(1, "row_unreadable", ["row_unreadable"]),
    "unreadable-quantity": partial(1, "row_unreadable", ["row_unreadable"]),
    "missing-code": partial(1, "row_unreadable", ["row_unreadable"]),
    "missing-currency": partial(1, "row_unreadable", ["row_unreadable"]),
  },
  "sbi-domestic-cash-positions": {
    "complete-empty": { ...complete(0), expected: 0 },
    "complete-rows": complete(7, ["exact_decimal_without_minor_units"]),
  },
  "sbi-account-assets-current": {
    "complete-empty": complete(0),
    "complete-rows": complete(24),
  },
  "sbi-vc-position-summary": {
    "complete-empty": complete(0),
    "complete-rows": complete(1),
    "unknown-fields": complete(1, ["unknown_fields_preserved"]),
    "non-string-field": complete(1, ["row_unreadable"]),
  },
  "sbi-vc-cash-balances": {
    "complete-empty": complete(0),
    "complete-rows": complete(6),
    "unknown-fields": complete(3, ["unknown_fields_preserved"]),
  },
  "sbi-vc-account-margin": {
    "complete-empty": complete(0),
    "complete-rows": complete(6),
    "unknown-fields": complete(6, ["unknown_fields_preserved"]),
  },
  "sbi-shinsei-top-balances-and-activity": {
    "complete-empty": complete(0),
    "complete-rows": complete(7),
  },
  "sbi-shinsei-yen-deposit-account": {
    "complete-empty": complete(0),
    "complete-rows": complete(2),
  },
  "sony-bank-gross-balance": { "complete-rows": { ...complete(17), expected: 17 } },
  "smbc-direct-balance": { "complete-rows": { ...complete(1), expected: 1 } },
};

describe("coverage contract registry", () => {
  test("every snapshot-dataset parser has contract cases, a frozen expectation and a claim table", () => {
    const covered = new Set(CONTRACT_PARSERS.map(({ parser }) => parser.name));
    for (const [name] of SNAPSHOT_DATASETS) {
      expect(covered.has(name), name).toBe(true);
      expect(Object.keys(FROZEN[name] ?? {}).length, name).toBeGreaterThan(0);
      expect(Object.keys(CLAIMS[name] ?? {}).length, name).toBeGreaterThan(0);
    }
    for (const { parser } of CONTRACT_PARSERS)
      expect(PARSERS.filter((candidate) => candidate === parser)).toHaveLength(1);
  });

  test("a throwing case has no claim and every non-throwing case has one", () => {
    for (const { parser, cases } of CONTRACT_PARSERS)
      for (const entry of cases) {
        const frozen = FROZEN[parser.name]?.[entry.name];
        expect(frozen, `${parser.name}/${entry.name}`).toBeDefined();
        expect("error" in frozen! ? "throws" : "claims", `${parser.name}/${entry.name}`).toBe(
          CLAIMS[parser.name]?.[entry.name] ? "claims" : "throws",
        );
      }
  });
});

for (const { parser, cases } of CONTRACT_PARSERS) {
  describe(parser.name, () => {
    for (const entry of cases) {
      const frozen = FROZEN[parser.name]![entry.name]!;
      const claim = CLAIMS[parser.name]?.[entry.name];
      test(entry.name, () => {
        if ("error" in frozen) {
          expect(() => parser.parse(entry.bytes, entry.artifact)).toThrow();
          return;
        }
        const result = parser.parse(entry.bytes, entry.artifact);
        // Observations and warning text are exactly what the pre-change parser produced.
        expect(JSON.stringify(result.observations)).toBe(JSON.stringify(frozen.observations));
        expect(result.warnings).toEqual(frozen.warnings);
        // Determinism extends to the new fields.
        expect(parser.parse(entry.bytes, entry.artifact)).toEqual(result);

        const issues = result.issues ?? [];
        for (const issue of issues) expect(validParseIssue(issue), issue.message).toBe(true);
        // Every warning is also a typed issue; a typed issue may exist without a warning.
        for (const warning of frozen.warnings)
          expect(
            issues.some((issue) => issue.message === warning),
            warning,
          ).toBe(true);
        expect(issues.map((issue) => issue.code).sort()).toEqual([...claim!.codes].sort());

        expect(result.coverage).toHaveLength(1);
        const coverage = result.coverage![0]!;
        expect(validCoverageClaim(coverage)).toBe(true);
        expect(coverageClaimViolations(coverage)).toEqual([]);
        expect(coverage).toMatchObject({
          claimId: `container:${containerScopeKey(entry.artifact)}`,
          scopeKey: containerScopeKey(entry.artifact),
          mode: "complete-container",
          completeness: claim!.completeness,
          membershipComplete: claim!.completeness === "complete",
          observedCount: claim!.observed,
          expectedCount: claim!.expected ?? null,
          policyVersion: COVERAGE_POLICY_VERSION,
          failureCause: claim!.failureCause ?? null,
          absenceMeaning: claim!.absence,
        });
        expect(coverage.observedCount).toBe(result.observations.length);
        expect(coverage.evidenceRefs.length).toBeGreaterThan(0);
        // Evidence references are locators and page markers, never provider values.
        for (const ref of coverage.evidenceRefs) expect(ref).toMatch(/^(json:\$|mts-shift-jis:)/);
      });
    }
  });
}

describe("scope keys", () => {
  test("bind the claim to source, dataset and Layer A unit without free text", () => {
    const base = {
      id: 1,
      sourceId: "synthetic-source",
      runStatus: "success" as const,
      runFailureCount: 0,
      dataset: "positions",
      url: null,
      mime: "application/json",
      fetchedAt: "2026-09-07T00:00:00.000Z",
      sha256: "0".repeat(64),
    };
    expect(containerScopeKey(base)).toBe("synthetic-source/positions");
    expect(containerScopeKey({ ...base, fetchUnitKey: "card-a" })).toBe(
      "synthetic-source/positions/unit=card-a",
    );
    expect(containerScopeKey({ ...base, fetchUnitKey: null })).toBe("synthetic-source/positions");
  });
});
