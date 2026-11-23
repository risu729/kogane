// The balance projection's adoption exactly as it shipped under
// `distinct-identified-accounts-v2` (`adoptionTargetKey`, `policyDisjointness`
// and `adoptionOutcomes` in packages/read-model/src/balance-projection.ts at
// commit cb6edd41, the newest on main before ADR 0001's amendment of
// 2026-11-20), frozen so balance-projection-entity-closure.test.ts can prove
// that the v3 build equals it wherever no account entity is involved. Only
// the module's own imports and names changed; it reads no entity. Never edit
// its logic, and never import it outside tests.
import { resolveMetric, UNKNOWN_METRIC, type MetricDefinition } from "../../domain/src/metrics.ts";
import {
  selectAdoptedSet,
  type AdoptionTarget,
  type MeasureCandidate,
  type ScopeRelationClaim,
} from "../../domain/src/scope.ts";
import { fromNormalizedDecimal } from "../../domain/src/values.ts";
import { AUTHORITY_RANKS } from "../src/authority";
import type {
  DerivedScopeRelation,
  ProjectionCandidate,
  ProjectionState,
  SubjectStatus,
} from "../src/balance-projection";

function adoptionTargetKey(definition: MetricDefinition, candidate: ProjectionCandidate): string {
  return definition.metricId === UNKNOWN_METRIC.metricId
    ? `unknown:${candidate.sourceId}:${candidate.parserName}:${candidate.metric}|${candidate.instrument}`
    : `${definition.metricId}|${candidate.instrument}`;
}

function claim(relation: DerivedScopeRelation): ScopeRelationClaim {
  return {
    left: relation.fromScopeKey,
    right: relation.toScopeKey,
    relation: relation.relation,
    evidenceRefs: [],
    decisionRef: relation.decisionRevisionId,
  };
}

interface Subject {
  status: SubjectStatus;
  sourceId: string;
  depositInstitution: string | null;
}

const DEPOSIT_INSTITUTIONS = new Map([
  ["sbi-shinsei-bank", "sbi-shinsei"],
  ["smbc-bank", "smbc"],
  ["mizuho-bank", "mizuho"],
]);

function policyDisjointness(subjects: Map<string, Subject>): DerivedScopeRelation[] {
  const entries = [...subjects.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const relations: DerivedScopeRelation[] = [];
  for (const [index, [left, leftSubject]] of entries.entries())
    for (const [right, rightSubject] of entries.slice(index + 1)) {
      const sameSource = leftSubject.sourceId === rightSubject.sourceId;
      const listedApart =
        sameSource && leftSubject.status !== "aggregate" && rightSubject.status !== "aggregate";
      const bothIdentified =
        leftSubject.status === "identified" && rightSubject.status === "identified";
      const differentDepositInstitutions =
        leftSubject.depositInstitution !== null &&
        rightSubject.depositInstitution !== null &&
        leftSubject.depositInstitution !== rightSubject.depositInstitution;
      if (!listedApart && !bothIdentified && !differentDepositInstitutions) continue;
      relations.push({
        fromScopeKey: left,
        toScopeKey: right,
        relation: "disjoint",
        source: "policy",
        decisionRevisionId: null,
        release: "distinct-identified-accounts-v2",
      });
    }
  return relations;
}

export interface LegacyOutcome {
  state: ProjectionState;
  reasonCode: string | null;
}

function adoptionOutcomes(
  target: AdoptionTarget,
  candidates: readonly ProjectionCandidate[],
  declared: readonly DerivedScopeRelation[],
): { outcomes: Map<string, LegacyOutcome>; relations: DerivedScopeRelation[] } {
  const outcomes = new Map<string, LegacyOutcome>();
  const subjects = new Map<string, Subject>();
  for (const candidate of candidates) {
    const institution =
      target.metricId === "deposit.balance" &&
      candidate.authorityRank === AUTHORITY_RANKS.direct &&
      candidate.subjectStatus !== "aggregate" &&
      candidate.subjectStatus !== "unresolved"
        ? (DEPOSIT_INSTITUTIONS.get(candidate.sourceId) ?? null)
        : null;
    const previous = subjects.get(candidate.subjectScopeKey);
    subjects.set(candidate.subjectScopeKey, {
      status: candidate.subjectStatus,
      sourceId: candidate.sourceId,
      depositInstitution:
        previous === undefined || previous.depositInstitution === institution ? institution : null,
    });
  }
  if (subjects.size > 250) {
    for (const candidate of candidates)
      outcomes.set(candidate.scopeKey, {
        state: "unresolved",
        reasonCode: "adoption_target_oversized",
      });
    return { outcomes, relations: [] };
  }
  const policy = policyDisjointness(subjects);
  const claims = [...declared.map(claim), ...policy.map(claim)];
  const measures: MeasureCandidate[] = candidates.map((candidate) => ({
    ref: candidate.scopeKey,
    scopeRef: candidate.subjectScopeKey,
    metricId: target.metricId,
    quantity: { unitRef: candidate.instrument, value: fromNormalizedDecimal(candidate.normalized) },
    coverage: { completeness: candidate.coverage.completeness },
    ownership: { kind: "full" },
    authorityRank: candidate.authorityRank,
  }));
  const result = selectAdoptedSet(target, measures, claims);
  for (const adopted of result.adopted)
    outcomes.set(adopted.ref, { state: "adopted", reasonCode: null });
  for (const excluded of result.excluded)
    outcomes.set(excluded.ref, { state: "excluded", reasonCode: excluded.reasonCode });
  for (const unresolved of result.unresolved)
    outcomes.set(unresolved.ref, {
      state: unresolved.reasonCode === "conflicting_evidence" ? "conflict" : "unresolved",
      reasonCode: unresolved.reasonCode,
    });
  return { outcomes, relations: policy };
}

/**
 * Each candidate's state and reason as the v2 build recorded them (the
 * freshness and witness overrides of `buildBalanceProjection` included), and
 * the scope pairs its policy declared disjoint.
 */
export function legacyV2Adoption(
  candidates: readonly ProjectionCandidate[],
  declaredRelations: readonly DerivedScopeRelation[],
): { outcomes: Map<string, LegacyOutcome>; policyPairs: Set<string> } {
  const definitions = new Map<string, MetricDefinition>();
  const targets = new Map<string, ProjectionCandidate[]>();
  for (const candidate of candidates) {
    const definition = resolveMetric({
      family: "balance",
      sourceId: candidate.sourceId,
      parserName: candidate.parserName,
      metric: candidate.metric,
      sourceAccount: candidate.sourceAccount,
      amountBasis: null,
    });
    definitions.set(candidate.scopeKey, definition);
    const key = adoptionTargetKey(definition, candidate);
    const bucket = targets.get(key);
    if (bucket) bucket.push(candidate);
    else targets.set(key, [candidate]);
  }
  const adoption = new Map<string, LegacyOutcome>();
  const policyPairs = new Set<string>();
  for (const [, bucket] of [...targets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = bucket[0]!;
    const target: AdoptionTarget = {
      metricId: definitions.get(first.scopeKey)!.metricId,
      unitRef: first.instrument,
    };
    const relevant = declaredRelations.filter((relation) =>
      bucket.some(
        (candidate) =>
          candidate.subjectScopeKey === relation.fromScopeKey ||
          candidate.subjectScopeKey === relation.toScopeKey,
      ),
    );
    const resolved = adoptionOutcomes(target, bucket, relevant);
    for (const [ref, outcome] of resolved.outcomes) adoption.set(ref, outcome);
    for (const relation of resolved.relations)
      policyPairs.add(JSON.stringify([relation.fromScopeKey, relation.toScopeKey].sort()));
  }
  const outcomes = new Map<string, LegacyOutcome>();
  for (const candidate of candidates)
    outcomes.set(
      candidate.scopeKey,
      candidate.freshness.state === "stale"
        ? { state: "stale", reasonCode: candidate.freshness.reasonCode ?? "no_new_observation" }
        : candidate.witnessConflict
          ? { state: "conflict", reasonCode: "witness_value_conflict" }
          : (adoption.get(candidate.scopeKey) ?? {
              state: "unresolved",
              reasonCode: "not_evaluated",
            }),
    );
  return { outcomes, policyPairs };
}
