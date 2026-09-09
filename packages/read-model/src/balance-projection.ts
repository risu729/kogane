// The latest-balance read model (review D10/D11, addendum A07). Pure: no D1,
// no clock, no HTTP. The job in services/observation-pipeline supplies the
// candidates and writes the rows; everything that decides a state lives here
// so it can be tested against the scenario fixtures in packages/domain.
//
// Addendum 05 section 5, steps 2-7, are performed by `selectAdoptedSet` in
// packages/domain. This module does step 1 (which candidates belong to the
// perimeter and the target), turns typed entity relations and the source
// authority policy into scope relations, and records the outcome per
// candidate with its reason code. It never sums across units, never turns a
// missing value into zero, and never reads an unknown overlap as disjoint.

import { fromNormalizedDecimal, type ValueState } from "../../domain/src/values.ts";
import {
  METRIC_REGISTRY,
  METRIC_REGISTRY_RELEASE,
  resolveMetric,
  UNKNOWN_METRIC,
  type MetricDefinition,
} from "../../domain/src/metrics.ts";
import {
  selectAdoptedSet,
  type AdoptionTarget,
  type MeasureCandidate,
  type ScopeRelation,
  type ScopeRelationClaim,
} from "../../domain/src/scope.ts";
import {
  validInstantText,
  validLocalDateText,
  type TemporalReference,
  type TemporalValue,
} from "../../domain/src/time.ts";
import type { NormalizedDecimal } from "../../../poc/observation-pipeline/shared/normalized-decimal.ts";
import { AUTHORITY_POLICY_RELEASE } from "./authority";
import type { MeasureView } from "./scope";

export const BALANCE_PROJECTION_RELEASE = "balance-projection-v1";
export const SCOPE_RELATION_RELEASE = "scope-relations-v1";
/** The disjointness the policy asserts, and the evidence it rests on. */
export const DISJOINT_ACCOUNTS_POLICY = "distinct-identified-accounts-v1";

/**
 * Build budget: distinct measurement scopes considered together for one
 * (metric, unit). Adoption compares scopes pairwise, so an unbounded target
 * would make a rebuild unbounded. A target above the bound is recorded
 * `unresolved`/`adoption_target_oversized` for every candidate: never
 * silently adopted, never silently summed, and visible as a reason code.
 */
export const ADOPTION_SUBJECT_BOUND = 250;

export const PROJECTION_STATES = [
  "adopted",
  "excluded",
  "unresolved",
  "conflict",
  "stale",
] as const;
export type ProjectionState = (typeof PROJECTION_STATES)[number];

/** Identity status of the scope a candidate measures; from the organized read. */
export const SUBJECT_STATUSES = [
  "identified",
  "provider-local",
  "aggregate",
  "unresolved",
] as const;
export type SubjectStatus = (typeof SUBJECT_STATUSES)[number];

export interface CandidateFreshness {
  state: "current" | "stale" | "unknown";
  /** Why the newest fetch did not replace this scope (SC15 reason codes). */
  reasonCode: string | null;
}

/** One candidate measurement, after same-provider-witness bundling. */
export interface ProjectionCandidate {
  /** Unique key of this candidate row: source, unit key, parser family, account, metric, unit. */
  scopeKey: string;
  /** The scope whose relations decide adoption; shared by every route to it. */
  subjectScopeKey: string;
  subjectStatus: SubjectStatus;
  observationId: number;
  parseRunId: number;
  fetchArtifactId: number;
  sourceId: string;
  sourceAccount: string;
  parser: string;
  parserName: string;
  metric: string;
  instrument: string;
  amountMinor: string | null;
  amountText: string | null;
  asOf: string | null;
  observedAt: string | null;
  normalized: NormalizedDecimal;
  /** Every witness bundled into this measurement, the representative included. */
  memberEvidence: EvidenceRef[];
  /** The strict same-provider-witness rule found disagreeing evidence. */
  witnessConflict: boolean;
  coverage: { completeness: "complete" | "partial" | "unknown"; reasonCode: string | null };
  freshness: CandidateFreshness;
  /**
   * Source authority as the caller's policy decides it (0 = most
   * authoritative). It never establishes that two scopes are the same
   * measurement; it only decides which side of an unproven overlap stays
   * adopted. Equal ranks leave both sides unresolved.
   */
  authorityRank: number;
  measureView: MeasureView;
  /** Whether the row is the latest witness of its group; see the view predicate. */
  latestInGroup: boolean;
}

/**
 * One witness of a measurement. The provider metric travels with the
 * reference so a page can say which column each piece of evidence came from
 * without a second read, and so evidence count stays distinct from the number
 * of balances shown (addendum 11 section 4).
 */
export interface EvidenceRef {
  ref: string;
  observationId: number;
  metric: string;
}

export interface ProjectionRow {
  scopeKey: string;
  subjectScopeKey: string;
  rowSeq: number;
  representativeObservationRef: string;
  memberEvidence: EvidenceRef[];
  /** Distinct provider metrics among the witnesses; the metric filter reads this. */
  memberMetrics: string[];
  evidenceCount: number;
  metricId: string;
  definitionRelease: string;
  quantityCoefficient: string | null;
  quantityScale: number | null;
  valueStatus: ValueState["status"];
  unitRef: string;
  state: ProjectionState;
  reasonCode: string | null;
  asOfRole: TemporalReference["role"];
  asOfKind: TemporalValue["kind"];
  asOfValue: string | null;
  temporal: TemporalReference;
  freshness: CandidateFreshness["state"];
  freshnessReason: string | null;
  sortAsOf: string;
  sourceId: string;
  sourceAccount: string;
  metric: string;
  instrument: string;
  parser: string;
  observationId: number;
  parseRunId: number;
  fetchArtifactId: number;
  amountMinor: string | null;
  amountText: string | null;
  asOf: string | null;
  observedAt: string | null;
  measureView: MeasureView;
  latestInGroup: boolean;
}

export interface DerivedScopeRelation {
  fromScopeKey: string;
  toScopeKey: string;
  relation: ScopeRelation;
  source: "policy" | "decision" | "derived";
  decisionRevisionId: string | null;
  release: string;
}

export interface ProjectionBuild {
  rows: ProjectionRow[];
  relations: DerivedScopeRelation[];
  /** Distinct reason codes present, sorted; the page reports them verbatim. */
  reasons: string[];
  completeness: "complete" | "partial" | "unknown";
  stale: boolean;
}

// ── time ─────────────────────────────────────────────────────────────────

/** `+09:00` is the fixed-offset zone `Etc/GMT-9`; the POSIX sign is inverted. */
function offsetZone(text: string): string | null {
  if (text === "Z") return "UTC";
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(text);
  if (!match || match[3] !== "00") return null;
  const hours = Number(match[2]);
  if (hours === 0) return "UTC";
  return `Etc/GMT${match[1] === "+" ? "-" : "+"}${String(hours)}`;
}

/**
 * The stored `as_of` / `observed_at` strings become a role-typed reference.
 * A date-only value stays a date: it is never given a time of day, and a
 * value that is neither a date nor an instant with a whole-hour offset is
 * reported as unknown rather than guessed (root review 07 section 5).
 */
export function temporalReferenceFor(
  asOf: string | null,
  observedAt: string | null,
): TemporalReference {
  const [text, role] =
    asOf !== null && asOf !== ""
      ? ([asOf, "effective"] as const)
      : observedAt !== null && observedAt !== ""
        ? ([observedAt, "observed"] as const)
        : ([null, "effective"] as const);
  if (text === null) return { role, time: { kind: "unknown", reasonCode: "no_recorded_time" } };
  return { role, time: temporalValueFor(text) };
}

function temporalValueFor(candidate: unknown): TemporalValue {
  if (validLocalDateText(candidate))
    return { kind: "local-date", value: candidate, zone: null, basis: "provider" };
  if (validInstantText(candidate)) {
    const zone = offsetZone(candidate.endsWith("Z") ? "Z" : candidate.slice(-6));
    if (zone !== null) return { kind: "instant", value: candidate, zone, basis: "provider" };
    return { kind: "unknown", reasonCode: "offset_zone_unsupported" };
  }
  return { kind: "unknown", reasonCode: "time_text_unrecognised" };
}

/**
 * The paging sort key. This is an ordering, not a semantic time comparison:
 * it is the recorded effective time as text, falling back to the observed
 * time, so a row with no recorded time sorts last under the descending order
 * and never borrows another row's date. The precision and basis of the value
 * travel separately in `temporal`, where a date is still a date.
 */
export function sortKeyFor(asOf: string | null, observedAt: string | null): string {
  return asOf ?? observedAt ?? "";
}

// ── targets ──────────────────────────────────────────────────────────────

/**
 * The measurement a candidate contends for. A metric the registry does not
 * know is targeted per provider metric: unknown meanings are stored and
 * displayed but never pooled with each other, so an unknown column can never
 * become a contender for another unknown column's value.
 */
export function adoptionTargetKey(
  definition: MetricDefinition,
  candidate: ProjectionCandidate,
): string {
  return definition.metricId === UNKNOWN_METRIC.metricId
    ? `unknown:${candidate.sourceId}:${candidate.parserName}:${candidate.metric}|${candidate.instrument}`
    : `${definition.metricId}|${candidate.instrument}`;
}

// ── relations ────────────────────────────────────────────────────────────

/** Typed relation rows of migration 0029, as the projection reads them. */
export interface EntityRelationRow {
  id: string;
  kind: string;
  from_ref: string;
  to_ref: string;
  status: string;
  decision_revision_id: string | null;
}

const CONTAINMENT_KINDS = new Set([
  "connection_contains",
  "account_has_pocket",
  "statement_covers",
]);

/**
 * Adopted typed relations become scope relations. `same_account` is the only
 * kind that makes two scopes one measurement; a containment kind makes the
 * contained scope a subset. A relation that is only proposed contributes
 * nothing, so an unconfirmed correspondence stays an unknown overlap (SC06).
 */
export function scopeRelationsFromEntityRelations(
  rows: readonly EntityRelationRow[],
): DerivedScopeRelation[] {
  const relations: DerivedScopeRelation[] = [];
  for (const row of rows) {
    if (row.status !== "accepted") continue;
    if (row.kind === "same_account")
      relations.push({
        fromScopeKey: row.from_ref,
        toScopeKey: row.to_ref,
        relation: "same",
        source: "decision",
        decisionRevisionId: row.decision_revision_id,
        release: SCOPE_RELATION_RELEASE,
      });
    else if (CONTAINMENT_KINDS.has(row.kind))
      relations.push({
        // `subset` reads left ⊂ right: the contained scope is the left side.
        fromScopeKey: row.to_ref,
        toScopeKey: row.from_ref,
        relation: "subset",
        source: "decision",
        decisionRevisionId: row.decision_revision_id,
        release: SCOPE_RELATION_RELEASE,
      });
  }
  return relations;
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

// ── build ────────────────────────────────────────────────────────────────

const EVIDENCE_REF = (id: number): string => `balance:${String(id)}`;

function valueOf(candidate: ProjectionCandidate): ValueState {
  return fromNormalizedDecimal(candidate.normalized);
}

interface Subject {
  status: SubjectStatus;
  sourceId: string;
}

/**
 * Which scope pairs the policy declares disjoint, and on what evidence.
 *
 * Within one source: two distinct non-aggregate scopes, because the provider
 * itself listed them as separate accounts or pockets. That is the same
 * account-list evidence a bank's own screen gives, written as an explicit
 * relation so it can be inspected and revoked.
 *
 * Across sources: only scopes the identity layer resolved to identified
 * accounts, because only then is there evidence that the two are different
 * accounts rather than two views of one.
 *
 * Everything else is deliberately absent. An aggregate or total scope, an
 * aggregator line with no terminal account, and a provider-local label seen
 * through a second route all keep an unknown overlap, which is what makes
 * SC01 and SC06 come out as possible duplicates rather than as sums (INV06).
 */
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
      if (!listedApart && !bothIdentified) continue;
      relations.push({
        fromScopeKey: left,
        toScopeKey: right,
        relation: "disjoint",
        source: "policy",
        decisionRevisionId: null,
        release: DISJOINT_ACCOUNTS_POLICY,
      });
    }
  return relations;
}

interface Outcome {
  state: ProjectionState;
  reasonCode: string | null;
}

function adoptionOutcomes(
  target: AdoptionTarget,
  candidates: readonly ProjectionCandidate[],
  declared: readonly DerivedScopeRelation[],
): { outcomes: Map<string, Outcome>; relations: DerivedScopeRelation[] } {
  const outcomes = new Map<string, Outcome>();
  const subjects = new Map<string, Subject>();
  for (const candidate of candidates)
    subjects.set(candidate.subjectScopeKey, {
      status: candidate.subjectStatus,
      sourceId: candidate.sourceId,
    });
  if (subjects.size > ADOPTION_SUBJECT_BOUND) {
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
    quantity: { unitRef: candidate.instrument, value: valueOf(candidate) },
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
 * Build the rows of one snapshot. The order is the read contract: the
 * temporal ordering key descending, then the scope key ascending. `rowSeq` is
 * that order made dense, so a cursor is a position rather than a business
 * value.
 */
export function buildBalanceProjection(
  candidates: readonly ProjectionCandidate[],
  declaredRelations: readonly DerivedScopeRelation[],
): ProjectionBuild {
  const byScope = new Set<string>();
  for (const candidate of candidates) {
    if (byScope.has(candidate.scopeKey))
      throw new Error("balance-projection: candidate scope keys must be unique");
    byScope.add(candidate.scopeKey);
  }
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
  const outcomes = new Map<string, Outcome>();
  const policyRelations: DerivedScopeRelation[] = [];
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
    for (const [ref, outcome] of resolved.outcomes) outcomes.set(ref, outcome);
    policyRelations.push(...resolved.relations);
  }

  const rows: Omit<ProjectionRow, "rowSeq">[] = candidates.map((candidate) => {
    const definition = definitions.get(candidate.scopeKey)!;
    const value = valueOf(candidate);
    const adoption = outcomes.get(candidate.scopeKey) ?? {
      state: "unresolved" as const,
      reasonCode: "not_evaluated",
    };
    // Freshness and witness disagreement are stated before the adoption
    // outcome: a row nobody re-observed, or one whose own evidence disagrees,
    // is not described as "excluded because a total covers it".
    const outcome: Outcome =
      candidate.freshness.state === "stale"
        ? { state: "stale", reasonCode: candidate.freshness.reasonCode ?? "no_new_observation" }
        : candidate.witnessConflict
          ? { state: "conflict", reasonCode: "witness_value_conflict" }
          : adoption;
    const temporal = temporalReferenceFor(candidate.asOf, candidate.observedAt);
    const evidence = [
      ...new Map(
        [
          {
            ref: EVIDENCE_REF(candidate.observationId),
            observationId: candidate.observationId,
            metric: candidate.metric,
          },
          ...candidate.memberEvidence,
        ].map((item) => [item.ref, item]),
      ).values(),
    ];
    return {
      scopeKey: candidate.scopeKey,
      subjectScopeKey: candidate.subjectScopeKey,
      representativeObservationRef: EVIDENCE_REF(candidate.observationId),
      memberEvidence: evidence,
      memberMetrics: [...new Set(evidence.map((item) => item.metric))].sort(),
      evidenceCount: evidence.length,
      metricId: definition.metricId,
      definitionRelease: definition.definitionRelease,
      quantityCoefficient: value.status === "exact" ? value.value.coefficient : null,
      quantityScale: value.status === "exact" ? value.value.scale : null,
      valueStatus: value.status,
      unitRef: candidate.instrument,
      state: outcome.state,
      reasonCode: outcome.reasonCode,
      asOfRole: temporal.role,
      asOfKind: temporal.time.kind,
      asOfValue:
        temporal.time.kind === "instant" || temporal.time.kind === "local-date"
          ? temporal.time.value
          : null,
      temporal,
      freshness: candidate.freshness.state,
      freshnessReason: candidate.freshness.reasonCode,
      sortAsOf: sortKeyFor(candidate.asOf, candidate.observedAt),
      sourceId: candidate.sourceId,
      sourceAccount: candidate.sourceAccount,
      metric: candidate.metric,
      instrument: candidate.instrument,
      parser: candidate.parser,
      observationId: candidate.observationId,
      parseRunId: candidate.parseRunId,
      fetchArtifactId: candidate.fetchArtifactId,
      amountMinor: candidate.amountMinor,
      amountText: candidate.amountText,
      asOf: candidate.asOf,
      observedAt: candidate.observedAt,
      measureView: candidate.measureView,
      latestInGroup: candidate.latestInGroup,
    };
  });

  rows.sort((a, b) =>
    a.sortAsOf > b.sortAsOf ? -1 : a.sortAsOf < b.sortAsOf ? 1 : a.scopeKey < b.scopeKey ? -1 : 1,
  );
  const ordered: ProjectionRow[] = rows.map((row, index) => ({ ...row, rowSeq: index }));
  const reasons = [
    ...new Set(
      ordered.flatMap((row) =>
        row.state === "adopted" || row.reasonCode === null
          ? []
          : [`${row.state}:${row.reasonCode}`],
      ),
    ),
  ].sort();
  const stale = ordered.some((row) => row.state === "stale" || row.freshness === "stale");
  const unresolved = ordered.some((row) => row.state === "unresolved" || row.state === "conflict");
  const unknownCoverage = candidates.some(
    (candidate) => candidate.coverage.completeness === "unknown",
  );
  return {
    rows: ordered,
    relations: [...declaredRelations, ...dedupe(policyRelations)],
    reasons,
    completeness: unknownCoverage ? "unknown" : unresolved || stale ? "partial" : "complete",
    stale,
  };
}

function dedupe(relations: readonly DerivedScopeRelation[]): DerivedScopeRelation[] {
  const seen = new Map<string, DerivedScopeRelation>();
  for (const relation of relations)
    seen.set(`${relation.fromScopeKey} ${relation.toScopeKey} ${relation.release}`, relation);
  return [...seen.values()];
}

/**
 * Which metrics may be added into a per-unit subtotal of known assets.
 *
 * Only `sum-disjoint` currency stocks with an asset-positive sign and no
 * overlap group qualify. Aggregates, capacities, statement amounts, period
 * totals and reward units are excluded by their own registry entries, and
 * `select-one` measures (a balance reported after a transaction) are excluded
 * because they restate a balance another metric already carries for the same
 * account (INV06). Nothing here makes a metric net-asset eligible: the
 * registry keeps `netAssetEligible: false` for every entry, and the result is
 * published as a known-assets subtotal with unknown liability coverage.
 */
export const KNOWN_ASSETS_POLICY = "known-assets-subtotal-v1";
export function knownAssetMetricIds(): string[] {
  return [
    ...new Set(
      METRIC_REGISTRY.filter(
        ({ definition }) =>
          definition.measurementKind === "stock" &&
          definition.unitDimension === "currency" &&
          definition.signMeaning === "asset-positive" &&
          definition.aggregationRule === "sum-disjoint" &&
          definition.overlapGroup === null,
      ).map(({ definition }) => definition.metricId),
    ),
  ].sort();
}

/** The releases a snapshot id digests; a change in any of them is a new snapshot. */
export interface ProjectionInputs {
  /** Newest published parse run; a later publication is a new context. */
  publishedHighWaterParseRunId: number;
  /**
   * Visible financial fetch runs. An exclusion annotation or an unsealed run
   * changes what a reader may see without publishing anything, so the count
   * and the high-water id are declared inputs too; otherwise a snapshot could
   * keep serving evidence that has since left the visible set.
   */
  visibleFetchRunCount: number;
  visibleFetchRunHighWater: number;
  identityRelease: string;
  decimalPolicyRelease: string;
}

export interface ProjectionInputManifest extends ProjectionInputs {
  metricRegistryRelease: string;
  projectionRelease: string;
  authorityPolicyRelease: string;
  scopeRelationRelease: string;
}

export function projectionInputManifest(inputs: ProjectionInputs): ProjectionInputManifest {
  return {
    ...inputs,
    metricRegistryRelease: METRIC_REGISTRY_RELEASE,
    projectionRelease: BALANCE_PROJECTION_RELEASE,
    authorityPolicyRelease: AUTHORITY_POLICY_RELEASE,
    scopeRelationRelease: SCOPE_RELATION_RELEASE,
  };
}
