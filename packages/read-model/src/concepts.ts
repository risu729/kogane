// Named read concepts for the evidence browser.
//
// Every relation and predicate here is a complete SQL fragment that names the
// sealed Layer A view it reads (raw-evidence migrations 0004 and 0017). Queries
// compose these by name; nothing in this package rewrites SQL text after it is
// written, and no table name is ever substituted. Each concept is one meaning
// of "visible" or "current", kept apart on purpose: showing a failed parse in
// an artifact's history and adopting a parse for the current balance are two
// different read contracts, so they are two different names.

import {
  ARTIFACT_UNITS_RELATION,
  CURRENT_SNAPSHOT,
  snapshotCtes,
  snapshotPolicyComparisonSql,
  SNAPSHOT_POLICIES_TABLE,
  UNIT_INDEPENDENT_POLICY,
  unitScopedEligibilitySql,
  unitScopePolicySql,
  unitScopeSuccessSql,
  type SnapshotRelations,
} from "../../../poc/observation-pipeline/src/snapshot-query";

export type ObservationKind = "transaction" | "balance" | "position" | "valuation";
export type ObservationTable =
  | "transaction_observations"
  | "balance_observations"
  | "position_observations"
  | "valuation_observations";

/** Table names come from this fixed map keyed by a validated union, never from a request. */
export const OBSERVATION_TABLES: Record<ObservationKind, ObservationTable> = {
  transaction: "transaction_observations",
  balance: "balance_observations",
  position: "position_observations",
  valuation: "valuation_observations",
};

export function isObservationKind(value: string): value is ObservationKind {
  return Object.prototype.hasOwnProperty.call(OBSERVATION_TABLES, value);
}

/** successfulParses: the parser ran to completion, whether or not it is still adopted. */
export const successfulParses = {
  predicate: (p: string): string => `${p}.status = 'ok'`,
} as const;

/**
 * publishedParses: adopted for normal display. Since migration 0026 that is
 * membership in `published_parse_runs`, the adoption pointer per (artifact,
 * parser) that the observation-pipeline writer moves in the same transaction
 * that marks a run `ok` (docs/publication-gate.md). A successful run that is
 * not published is not current, whatever its supersession pointer says; that
 * is what keeps a future candidate result out of every normal read.
 */
export const publishedParses = {
  relation: "published_parse_runs",
  predicate: (p: string): string =>
    `EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = ${p}.id)`,
} as const;

/**
 * legacyPublishedParses: the rule readers used before the gate. Kept only so
 * the consistency check and tests can compare the projection with it; no
 * query composes it (scripts/publication-gate-predicates.test.ts enforces).
 */
export const legacyPublishedParses = {
  predicate: (p: string): string =>
    `${p}.superseded_by_parse_run_id IS NULL AND ${p}.status = 'ok'`,
} as const;

/**
 * recordedParses: results a reader may see at all, current or historical: a
 * published run, a run replaced by a later publication (superseded), or a
 * failed run. A `pending` run is not a result. A successful run that is
 * neither published nor superseded is an unadopted result (a future
 * candidate) and is not visible on any normal path, including history,
 * counts and detail lookups by id.
 */
export const recordedParses = {
  predicate: (p: string): string =>
    `${p}.status <> 'pending' AND (${p}.status = 'error' OR ${p}.superseded_by_parse_run_id IS NOT NULL OR ${publishedParses.predicate(p)})`,
} as const;

/**
 * visibleEvidence: what an authenticated reader may see at all.
 *
 * `observation_fetch_runs` is sealed runs of financial sources (not
 * `kogane-synthetic`, not annotated `exclude_from_financial_views`) with a
 * terminal report; `observation_fetch_artifacts` and `observation_sources`
 * follow from it. Raw objects are visible only through a visible artifact.
 * Parse runs are visible once recorded (`recordedParses`) over a visible
 * artifact; a `pending` run or an unadopted successful run is never visible.
 */
export const visibleEvidence = {
  sources: "observation_sources",
  fetchRuns: "observation_fetch_runs",
  fetchArtifacts: "observation_fetch_artifacts",
  rawObjects: `(SELECT o.* FROM observation_raw_objects o
    WHERE EXISTS (SELECT 1 FROM observation_fetch_artifacts a WHERE a.sha256 = o.sha256))`,
  parseRuns: `(SELECT p.* FROM parse_runs p
    JOIN observation_fetch_artifacts a ON a.id = p.fetch_artifact_id
    WHERE ${recordedParses.predicate("p")})`,
  /** Observations of visible parse runs: superseded and failed results included. */
  observations: (table: ObservationTable): string =>
    `(SELECT o.* FROM ${table} o
    JOIN parse_runs p ON p.id = o.parse_run_id
    JOIN observation_fetch_artifacts a ON a.id = p.fetch_artifact_id
    WHERE ${recordedParses.predicate("p")})`,
} as const;

/** A visible fetch run whose collector reported complete success and no failure evidence. */
export const successfulFetchRuns = {
  predicate: (f: string): string => `${f}.status = 'success' AND ${f}.failure_count = 0`,
} as const;

/** The relations the snapshot policy CTEs read on the production schema. */
export const SNAPSHOT_RELATIONS: SnapshotRelations = {
  fetchArtifacts: visibleEvidence.fetchArtifacts,
  fetchRuns: visibleEvidence.fetchRuns,
  parseRuns: "parse_runs",
  publishedParseRuns: publishedParses.relation,
};

/**
 * completeSnapshotCandidates: container datasets whose latest complete
 * capture defines the current snapshot. Built over the visible views; the
 * CTE's own `complete_parse` condition is membership in the publication
 * projection and binds `parse_runs` through a visible artifact, so the base
 * tables are the right relations there. Which parses count as complete is
 * decided per dataset by its row in `dataset_snapshot_policies` (migration
 * 0025): `coverage-v1` reads the stored coverage claim,
 * `legacy-warning-compat-v1` the confined warning-text adapter. Every row is
 * seeded legacy.
 */
export const completeSnapshotCandidates = {
  ctes: snapshotCtes(SNAPSHOT_RELATIONS),
  /** The enclosing query binds `p` = parse run and `fa` = artifact. */
  currentMember: CURRENT_SNAPSHOT,
} as const;

// ── D13: the four predicates behind "usable" ─────────────────────────────
//
// The review asked that "evidence exists", "this unit can be parsed", "this
// parse can be adopted as the current snapshot" and "this number can be
// summed into an economic total" be separate predicates, because they need
// separate guarantees (root view: ownership/seal/integrity; observation:
// unit and parser preconditions; snapshot: every required unit/page/container
// complete; total: overlap removal, semantics, time, currency). Naming them
// here is what lets a later policy relax one without touching the others.

/** evidenceExists: a visible artifact whose raw object is reachable. */
export const evidenceExists = {
  predicate: (artifact: string): string =>
    `EXISTS (SELECT 1 FROM observation_raw_objects o WHERE o.sha256 = ${artifact}.sha256)`,
} as const;

/**
 * unitParseable: the artifact may become observations.
 *
 * Two scopes, chosen per dataset by its `dataset_snapshot_policies.unit_scope`
 * row (migration 0025, read since 0037):
 *
 * - `run` (default, every dataset until an operator says otherwise): the whole
 *   parent fetch run succeeded with no failure evidence. `predicate` is that
 *   rule, byte for byte what the Worker and the reader used before PR-14.
 * - `unit` (`unit-independent-v1`, D13): the artifact's own fetch unit
 *   reported terminal success on a sealed run, even when a sibling unit failed
 *   and the run therefore projects as `partial`. An artifact with no fetch unit
 *   is never rescued and falls back to the run scope.
 *
 * `policyPredicate` is the disjunction the Worker's `artifactSql` and every
 * job-creating lane compose; it degrades to `predicate` exactly when no policy
 * row names the `unit` scope, which is the seeded state.
 */
export interface UnitScopeRelations {
  policies?: string;
  artifactUnits?: string;
}

/**
 * unitScopedDataset: the artifact's dataset has a policy row naming the `unit`
 * scope. Seeded false everywhere; an operator row is the only way to make it
 * true (docs/parser-coverage.md, "Unit-scoped eligibility").
 */
export const unitScopedDataset = {
  relation: SNAPSHOT_POLICIES_TABLE,
  predicate: (artifact: string, policies: string = SNAPSHOT_POLICIES_TABLE): string =>
    unitScopePolicySql(artifact, policies),
} as const;

/** unitSucceeded: the artifact's own fetch unit reported terminal success on a sealed run. */
export const unitSucceeded = {
  relation: ARTIFACT_UNITS_RELATION,
  predicate: (artifact: string, units: string = ARTIFACT_UNITS_RELATION): string =>
    unitScopeSuccessSql(artifact, units),
} as const;

/** The `unit` scope alone: the dataset opted in and this artifact's unit succeeded. */
function unitScopePredicate(artifact: string, relations: UnitScopeRelations = {}): string {
  return `(${unitScopedDataset.predicate(artifact, relations.policies)}
      AND ${unitSucceeded.predicate(artifact, relations.artifactUnits)})`;
}

export const unitParseable = {
  scope: "run",
  policy: "run-success-v1",
  unitPolicy: UNIT_INDEPENDENT_POLICY,
  unitRelation: ARTIFACT_UNITS_RELATION,
  predicate: (fetchRun: string): string => successfulFetchRuns.predicate(fetchRun),
  unitPredicate: unitScopePredicate,
  /** Run scope, or the dataset's unit scope; one definition, shared with the PoC. */
  policyPredicate: (
    fetchRun: string,
    artifact: string,
    relations: UnitScopeRelations = {},
  ): string => unitScopedEligibilitySql(fetchRun, artifact, relations),
} as const;

/**
 * snapshotAdoptable: the parse is the current complete snapshot of its
 * container dataset under the dataset's active policy (or the dataset has no
 * snapshot policy). Same CTEs and membership predicate as
 * completeSnapshotCandidates, named for the D13 stage it answers.
 */
export const snapshotAdoptable = {
  ctes: completeSnapshotCandidates.ctes,
  predicate: completeSnapshotCandidates.currentMember,
} as const;

/**
 * economicallySummable: whether a measure may enter an economic total. No
 * aggregation policy is published (overlap groups, ownership shares, time
 * basis and currency are not yet adjudicated by a stored decision), so this
 * is false for every row. A later PR replaces the constant with a policy;
 * nothing sums observations until then.
 */
export const economicallySummable = {
  policy: null,
  predicate: (): string => "0",
} as const;

/**
 * snapshotPolicyComparison: the A03 shadow comparison, evaluating every
 * container dataset under both policies and listing partitions where the
 * current snapshot artifact differs. Identifiers only.
 */
export const snapshotPolicyComparison = {
  sql: snapshotPolicyComparisonSql(SNAPSHOT_RELATIONS),
} as const;

/**
 * activeStateProjection: the rows a "current" list shows. A published parse
 * of a successful visible fetch run; snapshot datasets additionally require
 * membership in the current complete snapshot. Per-source multi-page
 * contracts (MyJCB, V Point, Vpass, ...) are stated in the queries that need
 * them, next to this predicate rather than folded into one view.
 */
export const activeStateProjection = {
  // The reader's half of `unitParseable`: the same policy-driven scope the
  // Worker uses to decide what may be parsed decides what a "current" list may
  // show, so a parse rescued from a partial run is not written and then hidden.
  // Seeded state is `run` for every dataset, which is the pre-PR-14 text.
  predicate: `${publishedParses.predicate("p")} AND ${unitParseable.policyPredicate("f", "fa")}`,
  /** Parse run → visible artifact → visible fetch run, aliased p, fa, f. */
  parseChain: `parse_runs p
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id`,
  /** One observation table joined to that chain. */
  observationChain: (table: ObservationTable, alias: string): string =>
    `${table} ${alias}
    JOIN parse_runs p ON p.id = ${alias}.parse_run_id
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id`,
} as const;
