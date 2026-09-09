// Scope is a structure with a digest, not a concatenated string. Relations
// between scopes are explicit claims; an unknown overlap is never treated as
// disjoint (INV06). The adoption procedure below is deterministic and works
// only from verified relations and explicit preferences; it is not an
// optimiser over arbitrary sets.
import { COVERAGE_MODES, type CoverageMode } from "./coverage.ts";
import { canonicalDigest } from "./context.ts";
import {
  hasExactKeys,
  isOneOf,
  isRecord,
  isRefList,
  isSafeInt,
  isText,
  isTextOrNull,
} from "./guards.ts";
import { validPeriodValue, type PeriodValue } from "./time.ts";
import {
  compareDecimals,
  exactQuantity,
  multiplyByRatio,
  sumDecimals,
  validExactRatio,
  validQuantity,
  type ExactDecimal,
  type ExactRatio,
  type Quantity,
} from "./values.ts";

export const SCOPE_SCHEMA_VERSION = "scope-v1";
export interface ScopeDefinition {
  schemaVersion: typeof SCOPE_SCHEMA_VERSION;
  /** Authorised ownership perimeter the scope belongs to. */
  perimeterRef: string;
  /** Sorted, unique source references. */
  sourceRefs: string[];
  accountRef: string | null;
  productRef: string | null;
  pocketRef: string | null;
  instrumentRef: string | null;
  timeRange: PeriodValue | null;
  membershipEvidence: {
    mode: CoverageMode | "unknown";
    evidenceRefs: string[];
  };
}

export const SCOPE_RELATIONS = ["same", "disjoint", "subset", "overlaps", "unknown"] as const;
export type ScopeRelation = (typeof SCOPE_RELATIONS)[number];

/** `subset` means `left ⊂ right`; the other relations are symmetric. */
export interface ScopeRelationClaim {
  left: string;
  right: string;
  relation: ScopeRelation;
  evidenceRefs: string[];
  decisionRef: string | null;
}

export function validScopeDefinition(value: unknown): value is ScopeDefinition {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "perimeterRef",
      "sourceRefs",
      "accountRef",
      "productRef",
      "pocketRef",
      "instrumentRef",
      "timeRange",
      "membershipEvidence",
    ]) &&
    value.schemaVersion === SCOPE_SCHEMA_VERSION &&
    isText(value.perimeterRef, 256) &&
    isRefList(value.sourceRefs, 1_000) &&
    value.sourceRefs.every((ref, index, all) => index === 0 || all[index - 1]! < ref) &&
    isTextOrNull(value.accountRef, 512) &&
    isTextOrNull(value.productRef, 512) &&
    isTextOrNull(value.pocketRef, 512) &&
    isTextOrNull(value.instrumentRef, 512) &&
    (value.timeRange === null || validPeriodValue(value.timeRange)) &&
    isRecord(value.membershipEvidence) &&
    hasExactKeys(value.membershipEvidence, ["mode", "evidenceRefs"]) &&
    isOneOf([...COVERAGE_MODES, "unknown"] as const)(value.membershipEvidence.mode) &&
    isRefList(value.membershipEvidence.evidenceRefs)
  );
}

export function validScopeRelationClaim(value: unknown): value is ScopeRelationClaim {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["left", "right", "relation", "evidenceRefs", "decisionRef"]) &&
    isText(value.left, 512) &&
    isText(value.right, 512) &&
    value.left !== value.right &&
    isOneOf(SCOPE_RELATIONS)(value.relation) &&
    isRefList(value.evidenceRefs) &&
    isTextOrNull(value.decisionRef, 256)
  );
}

/** Canonical digest of the structure; equal scopes have equal digests regardless of key order. */
export async function scopeDigest(scope: ScopeDefinition): Promise<string> {
  return canonicalDigest(scope);
}

export type Ownership =
  | { kind: "full" }
  | { kind: "share"; ratio: ExactRatio }
  | { kind: "unknown" };

export interface MeasureCandidate {
  ref: string;
  scopeRef: string;
  metricId: string;
  quantity: Quantity;
  coverage: { completeness: "complete" | "partial" | "unknown" };
  ownership: Ownership;
  /**
   * Source authority preference set by the caller's policy (0 = most
   * authoritative). It decides which side of an unresolved overlap stays
   * adopted and, under an explicit rule, which conflicting evidence wins.
   * Equal ranks never break a tie.
   */
  authorityRank: number;
}

export interface AdoptionTarget {
  metricId: string;
  unitRef: string;
}

export interface AdoptionOptions {
  /** When a total and its complete, disjoint breakdown agree, keep the breakdown (default) or the total. */
  preferBreakdown?: boolean;
  /** How conflicting evidence of the same measurement is handled; the default leaves it unresolved. */
  conflictRule?: "unresolved" | "prefer-lowest-rank";
}

export const EXCLUSION_REASONS = [
  "metric_mismatch",
  "unit_mismatch",
  "duplicate_evidence",
  "conflict_resolved_by_rank",
  "covered_by_breakdown",
  "covered_by_total",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
export const UNRESOLVED_REASONS = [
  "value_not_exact",
  "coverage_partial",
  "coverage_unknown",
  "conflicting_evidence",
  "total_breakdown_mismatch",
  "ownership_unknown",
  "ownership_share_inexact",
  "overlap_declared",
  "overlap_unknown",
] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

export interface AdoptionResult {
  policyVersion: "adoption-v1";
  target: AdoptionTarget;
  adopted: { ref: string; quantity: Quantity }[];
  excluded: { ref: string; reasonCode: ExclusionReason }[];
  unresolved: { ref: string; reasonCode: UnresolvedReason }[];
  /** Sum of adopted quantities, or null when nothing was adopted; never a fabricated zero. */
  adoptedTotal: Quantity | null;
  /** `partial` whenever anything is unresolved; a partial subtotal is not a lower bound. */
  completeness: "complete" | "partial" | "unavailable";
  warnings: { code: "total_breakdown_mismatch" | "relation_conflict"; refs: string[] }[];
}

export function validMeasureCandidate(value: unknown): value is MeasureCandidate {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "ref",
      "scopeRef",
      "metricId",
      "quantity",
      "coverage",
      "ownership",
      "authorityRank",
    ]) &&
    isText(value.ref, 512) &&
    isText(value.scopeRef, 512) &&
    isText(value.metricId, 128) &&
    validQuantity(value.quantity) &&
    isRecord(value.coverage) &&
    hasExactKeys(value.coverage, ["completeness"]) &&
    isOneOf(["complete", "partial", "unknown"] as const)(value.coverage.completeness) &&
    validOwnership(value.ownership) &&
    isSafeInt(value.authorityRank, 0, 1_000)
  );
}

function validOwnership(value: unknown): value is Ownership {
  if (!isRecord(value)) return false;
  if (value.kind === "share")
    return hasExactKeys(value, ["kind", "ratio"]) && validExactRatio(value.ratio);
  return (value.kind === "full" || value.kind === "unknown") && hasExactKeys(value, ["kind"]);
}

type PairRelation = ScopeRelation | "superset";

class RelationIndex {
  private readonly pairs = new Map<string, PairRelation>();
  private readonly conflictedPairs = new Set<string>();
  readonly conflictedScopes = new Set<string>();

  constructor(claims: readonly ScopeRelationClaim[]) {
    for (const claim of claims) {
      this.record(claim.left, claim.right, claim.relation);
      this.record(
        claim.right,
        claim.left,
        claim.relation === "subset" ? "superset" : claim.relation,
      );
    }
  }

  /** Contradicting claims for one pair degrade it to unknown; they are never averaged. */
  private record(from: string, to: string, relation: PairRelation): void {
    const key = `${from} ${to}`;
    if (this.conflictedPairs.has(key)) return;
    const existing = this.pairs.get(key);
    if (existing !== undefined && existing !== relation) {
      this.conflictedPairs.add(key);
      this.conflictedScopes.add(from);
      this.conflictedScopes.add(to);
      this.pairs.set(key, "unknown");
      return;
    }
    this.pairs.set(key, relation);
  }

  relation(from: string, to: string): PairRelation {
    if (from === to) return "same";
    return this.pairs.get(`${from} ${to}`) ?? "unknown";
  }

  private neighbours(scopeRef: string, relation: PairRelation): string[] {
    const result: string[] = [];
    for (const [key, value] of this.pairs) {
      const separator = key.indexOf(" ");
      if (key.slice(0, separator) === scopeRef && value === relation)
        result.push(key.slice(separator + 1));
    }
    return result.sort();
  }

  /** Explicit, or one derivation step: `a ⊂ w` and `w ∩ b = ∅` implies `a ∩ b = ∅`. */
  disjoint(a: string, b: string): boolean {
    if (this.relation(a, b) === "disjoint") return true;
    const viaA = this.neighbours(a, "subset").some((w) => this.relation(w, b) === "disjoint");
    const viaB = this.neighbours(b, "subset").some((w) => this.relation(w, a) === "disjoint");
    return viaA || viaB;
  }
}

function exactValue(candidate: MeasureCandidate): ExactDecimal {
  if (candidate.quantity.value.status !== "exact")
    throw new TypeError("exactValue requires an exact candidate");
  return candidate.quantity.value.value;
}

const byRef = <T extends { ref: string }>(a: T, b: T): number =>
  a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;

/**
 * Addendum 05 §5 steps 2–7 for one target measurement:
 * 2. keep candidates of the target metric and unit;
 * 3. move non-exact values and incomplete coverage to unresolved;
 * 4. bundle `same` evidence, leaving disagreements as conflicts unless a rule says otherwise;
 * 5. adopt either a total or its complete disjoint breakdown, never both;
 * 6. apply known ownership shares, leaving unknown shares unresolved;
 * 7. require explicit disjointness between everything adopted and every other contender.
 */
export function selectAdoptedSet(
  target: AdoptionTarget,
  candidates: readonly MeasureCandidate[],
  relations: readonly ScopeRelationClaim[],
  options: AdoptionOptions = {},
): AdoptionResult {
  const preferBreakdown = options.preferBreakdown ?? true;
  const conflictRule = options.conflictRule ?? "unresolved";
  const sorted = [...candidates].sort(byRef);
  if (new Set(sorted.map((c) => c.ref)).size !== sorted.length)
    throw new TypeError("candidate refs must be unique");
  const index = new RelationIndex(relations);
  const excluded: AdoptionResult["excluded"] = [];
  const excludedRefs = new Set<string>();
  const exclude = (ref: string, reasonCode: ExclusionReason) => {
    excluded.push({ ref, reasonCode });
    excludedRefs.add(ref);
  };
  const unresolved: AdoptionResult["unresolved"] = [];
  const warnings: AdoptionResult["warnings"] = [];
  if (index.conflictedScopes.size > 0)
    warnings.push({ code: "relation_conflict", refs: [...index.conflictedScopes].sort() });

  // Steps 2–3.
  const live: MeasureCandidate[] = [];
  for (const candidate of sorted) {
    if (candidate.metricId !== target.metricId) exclude(candidate.ref, "metric_mismatch");
    else if (candidate.quantity.unitRef !== target.unitRef) exclude(candidate.ref, "unit_mismatch");
    else if (candidate.quantity.value.status !== "exact")
      unresolved.push({ ref: candidate.ref, reasonCode: "value_not_exact" });
    else if (candidate.coverage.completeness === "partial")
      unresolved.push({ ref: candidate.ref, reasonCode: "coverage_partial" });
    else if (candidate.coverage.completeness === "unknown")
      unresolved.push({ ref: candidate.ref, reasonCode: "coverage_unknown" });
    else live.push(candidate);
  }

  // Step 4: bundle evidence of the same measurement.
  const groups: MeasureCandidate[][] = [];
  for (const candidate of live) {
    const group = groups.find((members) =>
      members.some((member) => index.relation(member.scopeRef, candidate.scopeRef) === "same"),
    );
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const representatives: MeasureCandidate[] = [];
  for (const group of groups) {
    const ranked = [...group].sort((a, b) => a.authorityRank - b.authorityRank || byRef(a, b));
    const first = ranked[0]!;
    const agree = group.every(
      (member) => compareDecimals(exactValue(member), exactValue(first)) === 0,
    );
    if (agree) {
      representatives.push(first);
      for (const member of ranked.slice(1)) exclude(member.ref, "duplicate_evidence");
      continue;
    }
    const second = ranked[1];
    if (
      conflictRule === "prefer-lowest-rank" &&
      second &&
      second.authorityRank > first.authorityRank
    ) {
      representatives.push(first);
      for (const member of ranked.slice(1)) exclude(member.ref, "conflict_resolved_by_rank");
      continue;
    }
    for (const member of group)
      unresolved.push({ ref: member.ref, reasonCode: "conflicting_evidence" });
  }

  // Step 5: a total or its breakdown, never both.
  const dropped = new Set<string>();
  for (const whole of representatives) {
    if (dropped.has(whole.ref)) continue;
    const parts = representatives.filter(
      (part) =>
        !dropped.has(part.ref) && index.relation(part.scopeRef, whole.scopeRef) === "subset",
    );
    if (parts.length === 0) continue;
    const pairwiseDisjoint = parts.every((a, i) =>
      parts.slice(i + 1).every((b) => index.disjoint(a.scopeRef, b.scopeRef)),
    );
    if (!pairwiseDisjoint) {
      for (const part of parts) {
        dropped.add(part.ref);
        exclude(part.ref, "covered_by_total");
      }
      continue;
    }
    if (compareDecimals(sumDecimals(parts.map(exactValue)), exactValue(whole)) === 0) {
      const losers = preferBreakdown ? [whole] : parts;
      const reason: ExclusionReason = preferBreakdown ? "covered_by_breakdown" : "covered_by_total";
      for (const loser of losers) {
        dropped.add(loser.ref);
        exclude(loser.ref, reason);
      }
      continue;
    }
    // Neither side is adopted silently; the mismatch is reported (SC01 change resistance).
    const involved = [whole, ...parts];
    warnings.push({ code: "total_breakdown_mismatch", refs: involved.map((c) => c.ref).sort() });
    for (const candidate of involved) {
      dropped.add(candidate.ref);
      unresolved.push({ ref: candidate.ref, reasonCode: "total_breakdown_mismatch" });
    }
  }

  // Step 6: ownership shares.
  const owned: { candidate: MeasureCandidate; value: ExactDecimal }[] = [];
  for (const candidate of representatives.filter((c) => !dropped.has(c.ref))) {
    if (candidate.ownership.kind === "unknown") {
      unresolved.push({ ref: candidate.ref, reasonCode: "ownership_unknown" });
      continue;
    }
    if (candidate.ownership.kind === "full") {
      owned.push({ candidate, value: exactValue(candidate) });
      continue;
    }
    const shared = multiplyByRatio(exactValue(candidate), candidate.ownership.ratio);
    if (!shared.ok) unresolved.push({ ref: candidate.ref, reasonCode: "ownership_share_inexact" });
    else owned.push({ candidate, value: shared.value });
  }

  // Step 7: everything adopted must be explicitly disjoint from every other
  // contender still in play (adopted or unresolved). `same`, `subset` and
  // `superset` were settled in steps 4–5; `overlaps` and unknown relations leave
  // the candidate with the worse authority rank unresolved, and equal ranks
  // leave both unresolved. Unknown is never read as disjoint (INV06).
  const contenders = sorted.filter(
    (c) =>
      c.metricId === target.metricId &&
      c.quantity.unitRef === target.unitRef &&
      !excludedRefs.has(c.ref),
  );
  const overlapping = new Map<string, UnresolvedReason>();
  for (const { candidate: a } of owned)
    for (const b of contenders) {
      if (b.ref === a.ref || a.authorityRank < b.authorityRank) continue;
      const relation = index.relation(a.scopeRef, b.scopeRef);
      if (relation !== "unknown" && relation !== "overlaps") continue;
      if (index.disjoint(a.scopeRef, b.scopeRef)) continue;
      if (!overlapping.has(a.ref))
        overlapping.set(a.ref, relation === "overlaps" ? "overlap_declared" : "overlap_unknown");
    }
  for (const [ref, reasonCode] of overlapping) unresolved.push({ ref, reasonCode });
  const adopted = owned
    .filter(({ candidate }) => !overlapping.has(candidate.ref))
    .map(({ candidate, value }) => ({
      ref: candidate.ref,
      quantity: exactQuantity(target.unitRef, value),
    }));

  excluded.sort(byRef);
  unresolved.sort(byRef);
  return {
    policyVersion: "adoption-v1",
    target,
    adopted,
    excluded,
    unresolved,
    adoptedTotal:
      adopted.length === 0
        ? null
        : exactQuantity(
            target.unitRef,
            sumDecimals(
              owned.filter(({ candidate }) => !overlapping.has(candidate.ref)).map((o) => o.value),
            ),
          ),
    completeness:
      unresolved.length === 0 ? "complete" : adopted.length === 0 ? "unavailable" : "partial",
    warnings,
  };
}
