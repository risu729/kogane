// What the current card usage reads may and may not do on a store without
// table statistics (D1 is never analyzed), read from `EXPLAIN QUERY PLAN`.
// Shared by the read-model and application scale tests.
import type { Database, SQLQueryBindings } from "bun:sqlite";

export interface PlanStep {
  id: number;
  parent: number;
  detail: string;
}

export function explain(db: Database, sql: string, args: readonly unknown[]): PlanStep[] {
  return db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as SQLQueryBindings[])) as PlanStep[];
}

/** The details of every step enclosing `step`, innermost first. */
function ancestors(steps: readonly PlanStep[], step: PlanStep): string[] {
  const byId = new Map(steps.map((entry) => [entry.id, entry]));
  const found: string[] = [];
  for (let at = byId.get(step.parent); at !== undefined; at = byId.get(at.parent))
    found.push(at.detail);
  return found;
}

/**
 * Relations a card usage plan may scan whole: its own CTEs and subqueries
 * (each bounded by the current captures, never by the store), the
 * `dataset_snapshot_policies` rows (`unit_policy`, a handful of configuration
 * rows) and, for the stale-key read, the live recognition keys it checks.
 */
const BOUNDED = new Set([
  "candidate",
  "current_rows",
  "parses",
  "representations",
  "keyed",
  "eligible_vpass_snapshots",
  "ranked_vpass_snapshots",
  "ranked_myjcb_snapshots",
  "current_keys",
  "held_current",
  "unit_policy",
]);

/**
 * The snapshot CTEs shared with the Transactions page read every artifact
 * once per call to find each card-month's newest complete capture; the cost
 * is per artifact, not per observation, and is documented in
 * docs/read-model.md (Cost). Nothing else may scan an artifact.
 */
const SNAPSHOT_ARTIFACT_SCANS = [
  "MATERIALIZE eligible_vpass_snapshots",
  "MATERIALIZE ranked_myjcb_snapshots",
];

/**
 * Every whole-relation scan the plan makes that grows with the store rather
 * than with the current captures: a base table (observations, parses, runs,
 * reports, artifacts, identity rows) read from end to end. `allowed` names the
 * caller's own bounded relations (a wrapper's CTE, the stale read's key loop).
 */
export function unboundedScans(
  steps: readonly PlanStep[],
  allowed: readonly string[] = [],
): string[] {
  const bounded = new Set([...BOUNDED, ...allowed]);
  return steps
    .filter((step) => step.detail.startsWith("SCAN "))
    .filter((step) => {
      const name = step.detail.slice(5).split(" ")[0]!;
      if (bounded.has(name) || /^\(subquery-\d+\)$/u.test(name)) return false;
      if (
        name === "a" &&
        ancestors(steps, step).some((detail) =>
          SNAPSHOT_ARTIFACT_SCANS.some((snapshot) => detail === snapshot),
        )
      )
        return false;
      return true;
    })
    .map((step) => step.detail);
}

/** The first loop of `current_rows`: the relation every observation is reached from. */
export function currentRowsDriver(steps: readonly PlanStep[]): string | undefined {
  const materialize = steps.find((step) => step.detail === "MATERIALIZE current_rows");
  if (materialize === undefined) return undefined;
  return steps.find(
    (step) =>
      step.parent === materialize.id &&
      (step.detail.startsWith("SCAN ") || step.detail.startsWith("SEARCH ")),
  )?.detail;
}

/**
 * Steps inside a correlated subquery that read the current keys or probe a
 * recognition key: a per-row loop over the whole current set.
 */
export function perRowKeyProbes(steps: readonly PlanStep[]): string[] {
  return steps
    .filter((step) => ancestors(steps, step).some((detail) => detail.startsWith("CORRELATED ")))
    .filter(
      (step) =>
        step.detail.includes("current_keys") ||
        (step.detail.startsWith("SEARCH held") && step.detail.includes("recognition_key=?")),
    )
    .map((step) => step.detail);
}
