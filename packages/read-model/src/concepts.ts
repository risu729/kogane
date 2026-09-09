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
  CURRENT_SNAPSHOT,
  snapshotCtes,
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
    `${p}.superseded_by_parse_run_id IS NULL AND ${p}.status = 'ok'`, // gate:comparison
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

/**
 * completeSnapshotCandidates: container datasets whose latest complete
 * capture defines the current snapshot. Built over the visible views; the
 * CTE's own `complete_parse` condition is membership in the publication
 * projection and binds `parse_runs` through a visible artifact, so the base
 * tables are the right relations there.
 */
export const completeSnapshotCandidates = {
  ctes: snapshotCtes({
    fetchArtifacts: visibleEvidence.fetchArtifacts,
    fetchRuns: visibleEvidence.fetchRuns,
    parseRuns: "parse_runs",
    publishedParseRuns: publishedParses.relation,
  }),
  /** The enclosing query binds `p` = parse run and `fa` = artifact. */
  currentMember: CURRENT_SNAPSHOT,
} as const;

/**
 * activeStateProjection: the rows a "current" list shows. A published parse
 * of a successful visible fetch run; snapshot datasets additionally require
 * membership in the current complete snapshot. Per-source multi-page
 * contracts (MyJCB, V Point, Vpass, ...) are stated in the queries that need
 * them, next to this predicate rather than folded into one view.
 */
export const activeStateProjection = {
  predicate: `${publishedParses.predicate("p")} AND ${successfulFetchRuns.predicate("f")}`,
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
