import { expect, test } from "bun:test";
import { findConversionPaths, simulateConversion } from "../src/reward-conversion.ts";
import type { ConversionOffer } from "../src/rewards.ts";
import type { LocalDateValue } from "../src/time.ts";
import { decimalLiteral, decimalToString, exactQuantity, ROUNDING_MODES } from "../src/values.ts";

const day = (value: string): LocalDateValue => ({
  kind: "local-date",
  value,
  zone: "Asia/Tokyo",
  basis: "provider",
});
const quantity = (value: number, unit = "points:a") =>
  exactQuantity(unit, decimalLiteral(String(value)));

function offer(overrides: Partial<ConversionOffer> = {}): ConversionOffer {
  return {
    offerId: "offer:a-b",
    version: "v1",
    sourceProgramRef: "program:a",
    destinationProgramRef: "program:b",
    fromUnitRef: "points:a",
    toUnitRef: "points:b",
    ratio: { numerator: "1", denominator: "1" },
    minimum: decimalLiteral("1"),
    increment: decimalLiteral("1"),
    maximumPerRequest: null,
    sharedQuotaRef: null,
    fixedFees: [],
    variableFeePolicyRef: null,
    eligibilityPolicyRef: "policy:eligibility",
    eligibleBucketKinds: ["regular"],
    eligibleRestrictionRefs: [],
    eligibleTiers: null,
    validTime: {
      kind: "period",
      start: "2026-01-01",
      end: "2026-12-31",
      endExclusive: false,
      zone: "Asia/Tokyo",
      granularity: "day",
    },
    applicationDeadline: day("2026-12-31"),
    processingPolicyRef: "policy:processing",
    processingDays: 0,
    roundingPolicyRef: "policy:rounding",
    rounding: { scale: 0, mode: "down" },
    cancellationPolicyRef: null,
    evidenceRefs: ["evidence:synthetic"],
    verification: "verified",
    ...overrides,
  };
}

// An independent integer lattice oracle: rank the two adjacent representable
// answers by distance, direction and parity rather than running decimal arithmetic.
function rounded(n: number, d: number, mode: (typeof ROUNDING_MODES)[number]): number {
  const lower = Math.floor(n / d);
  const upper = Math.ceil(n / d);
  if (mode === "down" || mode === "floor") return lower;
  if (mode === "up" || mode === "ceiling") return upper;
  const left = n - lower * d;
  const right = upper * d - n;
  if (left < right) return lower;
  if (right < left) return upper;
  return mode === "half-up" ? upper : lower % 2 === 0 ? lower : upper;
}

test("all 24,300 bounded amount-policy combinations match the integer oracle", () => {
  let cases = 0;
  for (let balance = 0; balance <= 8; balance++)
    for (let increment = 1; increment <= 3; increment++)
      for (let minimum = 0; minimum <= 4; minimum++)
        for (const cap of [null, 0, 1, 2, 3, 4, 5, 6, 7, 8])
          for (const [numerator, denominator] of [[1, 1], [1, 2], [2, 3]] as const)
            for (const mode of ROUNDING_MODES) {
              cases++;
              const permitted = Math.min(balance, cap ?? balance);
              // Enumerate admissible whole increments; choose the greatest.
              const uses = Array.from({ length: balance + 1 }, (_, i) => i).filter(
                (i) => i <= permitted && i % increment === 0,
              );
              const use = Math.max(...uses);
              const expectedFeasible = use >= minimum;
              const plan = simulateConversion(
                offer({
                  increment: decimalLiteral(String(increment)),
                  minimum: decimalLiteral(String(minimum)),
                  maximumPerRequest: cap === null ? null : decimalLiteral(String(cap)),
                  ratio: { numerator: String(numerator), denominator: String(denominator) },
                  rounding: { scale: 0, mode },
                }),
                quantity(balance),
              );
              expect(plan.feasible).toBe(expectedFeasible);
              for (const q of [plan.use, plan.receive, plan.remainder])
                expect(q.value.status).toBe("exact");
              if (
                plan.use.value.status !== "exact" ||
                plan.receive.value.status !== "exact" ||
                plan.remainder.value.status !== "exact"
              )
                throw new Error("expected exact plan");
              const expectedUse = expectedFeasible ? use : 0;
              expect(decimalToString(plan.use.value.value)).toBe(String(expectedUse));
              expect(decimalToString(plan.remainder.value.value)).toBe(String(balance - expectedUse));
              expect(decimalToString(plan.receive.value.value)).toBe(
                String(expectedFeasible ? rounded(use * numerator, denominator, mode) : 0),
              );
            }
  expect(cases).toBe(24_300);
});

test("all 64 directed three-unit graphs at depths 1..3 match simple-path enumeration", () => {
  const units = ["points:a", "points:b", "points:c"];
  const edges = units.flatMap((from) =>
    units.filter((to) => to !== from).map((to) => [from, to] as const),
  );
  let cases = 0;
  for (let mask = 0; mask < 64; mask++)
    for (let depth = 1; depth <= 3; depth++) {
      cases++;
      const graph = edges.filter((_, index) => (mask & (1 << index)) !== 0);
      const offers = graph.map(([from, to]) =>
        offer({ offerId: from + "->" + to, fromUnitRef: from, toUnitRef: to }),
      );
      // With three distinct units, a simple a->c path is direct or via b.
      const has = (from: string, to: string) => graph.some(([a, b]) => a === from && b === to);
      const expected: string[] = [];
      if (has(units[0]!, units[2]!)) expected.push("points:a->points:c@v1");
      if (depth >= 2 && has(units[0]!, units[1]!) && has(units[1]!, units[2]!))
        expected.push("points:a->points:b@v1|points:b->points:c@v1");
      const result = findConversionPaths(
        offers,
        { quantity: quantity(4), clock: day("2026-09-09") },
        units[2]!,
        { maxDepth: depth, maxCandidates: 100, maxExpansions: 1000, requiredCompletionBy: null },
      );
      expect(result.paths.map((p) => p.hops.map((h) => h.offerRef).join("|")).sort()).toEqual(
        expected.sort(),
      );
      expect(result.stoppedBy).toEqual([]);
      expect(result.expansions).toBeLessThanOrEqual(1000);
      for (const path of result.paths) {
        expect(path.hops.length).toBeLessThanOrEqual(depth);
        expect(new Set(path.hops.map((h) => h.offerRef)).size).toBe(path.hops.length);
      }
    }
  expect(cases).toBe(192);
});
