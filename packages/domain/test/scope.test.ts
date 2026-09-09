import { describe, expect, test } from "bun:test";
import {
  scopeDigest,
  selectAdoptedSet,
  validMeasureCandidate,
  validScopeDefinition,
  validScopeRelationClaim,
  type MeasureCandidate,
  type ScopeDefinition,
  type ScopeRelationClaim,
} from "../src/scope.ts";
import { q, quantityText } from "./helpers.ts";

const target = { metricId: "deposit.balance", unitRef: "JPY" };
const candidate = (
  ref: string,
  scopeRef: string,
  amount: string,
  overrides: Partial<MeasureCandidate> = {},
): MeasureCandidate => ({
  ref,
  scopeRef,
  metricId: "deposit.balance",
  quantity: q("JPY", amount),
  coverage: { completeness: "complete" },
  ownership: { kind: "full" },
  authorityRank: 0,
  ...overrides,
});
const relation = (
  left: string,
  right: string,
  rel: ScopeRelationClaim["relation"],
): ScopeRelationClaim => ({ left, right, relation: rel, evidenceRefs: [], decisionRef: null });

describe("scope definitions", () => {
  const scope: ScopeDefinition = {
    schemaVersion: "scope-v1",
    perimeterRef: "perimeter:self",
    sourceRefs: ["source:bank", "source:mf"],
    accountRef: "account:1",
    productRef: null,
    pocketRef: null,
    instrumentRef: "JPY",
    timeRange: null,
    membershipEvidence: { mode: "complete-container", evidenceRefs: ["ev:1"] },
  };

  test("validate structure, sorted sources and unknown keys", () => {
    expect(validScopeDefinition(scope)).toBe(true);
    expect(validScopeDefinition({ ...scope, sourceRefs: ["source:mf", "source:bank"] })).toBe(
      false,
    );
    expect(validScopeDefinition({ ...scope, sourceRefs: ["source:bank", "source:bank"] })).toBe(
      false,
    );
    expect(validScopeDefinition({ ...scope, label: "x" })).toBe(false);
    expect(
      validScopeDefinition({ ...scope, membershipEvidence: { mode: "complete-container" } }),
    ).toBe(false);
    expect(validScopeRelationClaim(relation("a", "b", "subset"))).toBe(true);
    expect(validScopeRelationClaim(relation("a", "a", "same"))).toBe(false);
    expect(validScopeRelationClaim({ ...relation("a", "b", "same"), weight: 1 })).toBe(false);
  });

  test("digest is stable across key order and changes with content", async () => {
    const reordered = JSON.parse(
      JSON.stringify({
        membershipEvidence: scope.membershipEvidence,
        instrumentRef: scope.instrumentRef,
        timeRange: null,
        pocketRef: null,
        productRef: null,
        accountRef: scope.accountRef,
        sourceRefs: scope.sourceRefs,
        perimeterRef: scope.perimeterRef,
        schemaVersion: scope.schemaVersion,
      }),
    ) as ScopeDefinition;
    expect(await scopeDigest(reordered)).toBe(await scopeDigest(scope));
    expect(await scopeDigest({ ...scope, accountRef: "account:2" })).not.toBe(
      await scopeDigest(scope),
    );
  });
});

describe("selectAdoptedSet", () => {
  test("unknown overlap is unresolved, never disjoint (INV06); equal ranks leave both unresolved", () => {
    const result = selectAdoptedSet(
      target,
      [candidate("a", "s:a", "10"), candidate("b", "s:b", "20")],
      [],
    );
    expect(result.adopted).toEqual([]);
    expect(result.unresolved).toEqual([
      { ref: "a", reasonCode: "overlap_unknown" },
      { ref: "b", reasonCode: "overlap_unknown" },
    ]);
    expect(result.adoptedTotal).toBeNull();
    expect(result.completeness).toBe("unavailable");
  });

  test("explicit disjointness adopts both; declared overlap keeps the better rank only", () => {
    const disjoint = selectAdoptedSet(
      target,
      [candidate("a", "s:a", "10"), candidate("b", "s:b", "20")],
      [relation("s:a", "s:b", "disjoint")],
    );
    expect(quantityText(disjoint.adoptedTotal)).toBe("30");
    expect(disjoint.completeness).toBe("complete");
    const overlapping = selectAdoptedSet(
      target,
      [candidate("a", "s:a", "10"), candidate("b", "s:b", "20", { authorityRank: 1 })],
      [relation("s:a", "s:b", "overlaps")],
    );
    expect(overlapping.adopted.map((a) => a.ref)).toEqual(["a"]);
    expect(overlapping.unresolved).toEqual([{ ref: "b", reasonCode: "overlap_declared" }]);
    expect(overlapping.completeness).toBe("partial");
  });

  test("same measurement: agreeing evidence is bundled, disagreeing evidence stays a conflict", () => {
    const agree = selectAdoptedSet(
      target,
      [
        candidate("direct", "s:direct", "100"),
        candidate("mf", "s:mf", "100", { authorityRank: 1 }),
      ],
      [relation("s:direct", "s:mf", "same")],
    );
    expect(agree.adopted.map((a) => a.ref)).toEqual(["direct"]);
    expect(agree.excluded).toEqual([{ ref: "mf", reasonCode: "duplicate_evidence" }]);
    const conflict = selectAdoptedSet(
      target,
      [candidate("direct", "s:direct", "100"), candidate("mf", "s:mf", "90", { authorityRank: 1 })],
      [relation("s:direct", "s:mf", "same")],
    );
    expect(conflict.adopted).toEqual([]);
    expect(conflict.unresolved).toEqual([
      { ref: "direct", reasonCode: "conflicting_evidence" },
      { ref: "mf", reasonCode: "conflicting_evidence" },
    ]);
    const byRule = selectAdoptedSet(
      target,
      [candidate("direct", "s:direct", "100"), candidate("mf", "s:mf", "90", { authorityRank: 1 })],
      [relation("s:direct", "s:mf", "same")],
      { conflictRule: "prefer-lowest-rank" },
    );
    expect(byRule.adopted.map((a) => a.ref)).toEqual(["direct"]);
    expect(byRule.excluded).toEqual([{ ref: "mf", reasonCode: "conflict_resolved_by_rank" }]);
    const tie = selectAdoptedSet(
      target,
      [candidate("direct", "s:direct", "100"), candidate("mf", "s:mf", "90")],
      [relation("s:direct", "s:mf", "same")],
      { conflictRule: "prefer-lowest-rank" },
    );
    expect(tie.adopted).toEqual([]);
  });

  test("a total and its breakdown are alternatives; preference chooses, mismatch adopts neither", () => {
    const candidates = [
      candidate("p1", "s:p1", "60"),
      candidate("p2", "s:p2", "40"),
      candidate("total", "s:total", "100"),
    ];
    const relations = [
      relation("s:p1", "s:total", "subset"),
      relation("s:p2", "s:total", "subset"),
      relation("s:p1", "s:p2", "disjoint"),
    ];
    const breakdown = selectAdoptedSet(target, candidates, relations);
    expect(breakdown.adopted.map((a) => a.ref)).toEqual(["p1", "p2"]);
    expect(breakdown.excluded).toEqual([{ ref: "total", reasonCode: "covered_by_breakdown" }]);
    expect(quantityText(breakdown.adoptedTotal)).toBe("100");
    const total = selectAdoptedSet(target, candidates, relations, { preferBreakdown: false });
    expect(total.adopted.map((a) => a.ref)).toEqual(["total"]);
    expect(total.excluded.map((e) => e.reasonCode)).toEqual([
      "covered_by_total",
      "covered_by_total",
    ]);
    const mismatch = selectAdoptedSet(
      target,
      [candidates[0]!, candidates[1]!, candidate("total", "s:total", "90")],
      relations,
    );
    expect(mismatch.adopted).toEqual([]);
    expect(mismatch.warnings).toEqual([
      { code: "total_breakdown_mismatch", refs: ["p1", "p2", "total"] },
    ]);
    expect(mismatch.unresolved.every((u) => u.reasonCode === "total_breakdown_mismatch")).toBe(
      true,
    );
    // Parts that are not known to be disjoint cannot replace the total.
    const overlappingParts = selectAdoptedSet(target, candidates, relations.slice(0, 2));
    expect(overlappingParts.adopted.map((a) => a.ref)).toEqual(["total"]);
    expect(overlappingParts.excluded.map((e) => e.reasonCode)).toEqual([
      "covered_by_total",
      "covered_by_total",
    ]);
  });

  test("non-exact values, partial coverage and wrong metric or unit never enter the sum", () => {
    const result = selectAdoptedSet(
      target,
      [
        candidate("ok", "s:ok", "10"),
        candidate("missing", "s:missing", "0", {
          quantity: {
            unitRef: "JPY",
            value: { status: "missing", reasonCode: "decimal-v1:missing" },
          },
        }),
        candidate("partial", "s:partial", "5", { coverage: { completeness: "partial" } }),
        candidate("unknown", "s:unknown", "5", { coverage: { completeness: "unknown" } }),
        candidate("capacity", "s:capacity", "99", { metricId: "broker.buying-power" }),
        candidate("usd", "s:usd", "99", { quantity: q("USD", "99") }),
      ],
      [
        relation("s:ok", "s:missing", "disjoint"),
        relation("s:ok", "s:partial", "disjoint"),
        relation("s:ok", "s:unknown", "disjoint"),
      ],
    );
    expect(result.adopted.map((a) => a.ref)).toEqual(["ok"]);
    expect(result.excluded).toEqual([
      { ref: "capacity", reasonCode: "metric_mismatch" },
      { ref: "usd", reasonCode: "unit_mismatch" },
    ]);
    expect(result.unresolved).toEqual([
      { ref: "missing", reasonCode: "value_not_exact" },
      { ref: "partial", reasonCode: "coverage_partial" },
      { ref: "unknown", reasonCode: "coverage_unknown" },
    ]);
    expect(quantityText(result.adoptedTotal)).toBe("10");
    expect(result.completeness).toBe("partial");
  });

  test("ownership shares apply exactly; unknown shares are never assumed to be half", () => {
    const result = selectAdoptedSet(
      target,
      [
        candidate("joint", "s:joint", "1000", {
          ownership: { kind: "share", ratio: { numerator: "1", denominator: "4" } },
        }),
        candidate("unknown", "s:unknown", "1000", { ownership: { kind: "unknown" } }),
        candidate("thirds", "s:thirds", "1000", {
          ownership: { kind: "share", ratio: { numerator: "1", denominator: "3" } },
        }),
      ],
      [
        relation("s:joint", "s:unknown", "disjoint"),
        relation("s:joint", "s:thirds", "disjoint"),
        relation("s:unknown", "s:thirds", "disjoint"),
      ],
    );
    expect(result.adopted).toEqual([{ ref: "joint", quantity: q("JPY", "250") }]);
    expect(result.unresolved).toEqual([
      { ref: "thirds", reasonCode: "ownership_share_inexact" },
      { ref: "unknown", reasonCode: "ownership_unknown" },
    ]);
  });

  test("contradicting relation claims degrade to unknown with a warning; results are order-independent", () => {
    const candidates = [candidate("a", "s:a", "10"), candidate("b", "s:b", "20")];
    const contradiction = selectAdoptedSet(target, candidates, [
      relation("s:a", "s:b", "disjoint"),
      relation("s:b", "s:a", "overlaps"),
    ]);
    expect(contradiction.warnings).toEqual([{ code: "relation_conflict", refs: ["s:a", "s:b"] }]);
    expect(contradiction.adopted).toEqual([]);
    const forward = selectAdoptedSet(target, candidates, [relation("s:a", "s:b", "disjoint")]);
    const reversed = selectAdoptedSet(target, [...candidates].reverse(), [
      relation("s:b", "s:a", "disjoint"),
    ]);
    expect(reversed).toEqual(forward);
    expect(() => selectAdoptedSet(target, [candidates[0]!, candidates[0]!], [])).toThrow(TypeError);
  });

  test("candidate validator rejects unknown keys and unsafe ranks", () => {
    expect(validMeasureCandidate(candidate("a", "s:a", "1"))).toBe(true);
    expect(validMeasureCandidate({ ...candidate("a", "s:a", "1"), note: "x" })).toBe(false);
    expect(validMeasureCandidate(candidate("a", "s:a", "1", { authorityRank: -1 }))).toBe(false);
    expect(
      validMeasureCandidate({ ...candidate("a", "s:a", "1"), ownership: { kind: "share" } }),
    ).toBe(false);
  });
});
