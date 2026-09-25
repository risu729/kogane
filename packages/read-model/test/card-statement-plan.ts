// What the statement and settlement reads may and may not do on a store
// without table statistics (D1 is never analyzed), read from `EXPLAIN QUERY
// PLAN`. Shared by the read-model, application and processor tests; like
// card-usage-plan.ts it matches patterns, never a whole plan text, so another
// SQLite version may reorder a join without failing the checks.
import type { PlanStep } from "./card-usage-plan";

/**
 * Relations a statement or settlement plan may read whole: the callers' own
 * CTEs (each bounded by the statements or debits asked for), the keyed
 * ownership CTEs of card-settlement-ownership.ts and a JSON argument.
 */
const BOUNDED = new Set([
  "json_each",
  "wanted",
  "statements",
  "page",
  "debits",
  "owned_runs",
  "owned_candidates",
  "observed_ids",
  "owned",
  "ownership",
]);

/** The details of every step enclosing `step`, innermost first. */
function ancestors(steps: readonly PlanStep[], step: PlanStep): string[] {
  const byId = new Map(steps.map((entry) => [entry.id, entry]));
  const found: string[] = [];
  for (let at = byId.get(step.parent); at !== undefined; at = byId.get(at.parent))
    found.push(at.detail);
  return found;
}

/**
 * The `ranked` CTE of `card_statement_facts` and `card_bank_debit_facts`
 * (migration 0044) ranks every capture of the history; its whole read of the
 * balance observations (`b`) is the one documented in docs/card-settlements.md
 * (Cost) and is allowed. Nothing else may scan a base table there.
 */
const insideRanked = (steps: readonly PlanStep[], step: PlanStep): boolean =>
  ancestors(steps, step).some((detail) => /^(?:CO-ROUTINE|MATERIALIZE) ranked$/u.test(detail));

/**
 * Every step that makes the read grow with the whole store: a base table read
 * from end to end (published parses, identity rows, runs, reports, artifacts,
 * candidates...), an identity lookup by kind alone, or the whole-store CTEs of
 * `current_identity_observations`. `allowed` names a caller's own bounded
 * relations (the shipped settlement text's `w`).
 */
export function statementPlanProblems(
  steps: readonly PlanStep[],
  allowed: readonly string[] = [],
): string[] {
  const bounded = new Set([...BOUNDED, ...allowed]);
  return steps
    .filter((step) => {
      if (/^MATERIALIZE (?:candidates|latest)$/u.test(step.detail)) return true;
      if (/\bidentity_observation_lookup \(kind=\?\)/u.test(step.detail)) return true;
      if (!step.detail.startsWith("SCAN ")) return false;
      const name = step.detail.slice(5).split(" ")[0]!;
      if (bounded.has(name) || /^\(subquery-\d+\)$/u.test(name)) return false;
      if (name === "ranked") return false;
      if (name === "b" && insideRanked(steps, step)) return false;
      return true;
    })
    .map((step) => step.detail);
}
