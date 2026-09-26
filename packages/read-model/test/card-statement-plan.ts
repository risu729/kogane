// What the statement and settlement reads may and may not do on a store
// without table statistics (D1 is never analyzed), read from `EXPLAIN QUERY
// PLAN`. Shared by the read-model, application and processor tests; like
// card-usage-plan.ts it matches patterns, never a whole plan text, so another
// SQLite version may reorder a join without failing the checks.
import type { PlanStep } from "./card-usage-plan";

/**
 * Relations a statement or settlement plan may read whole: the callers' own
 * CTEs (each bounded by the statements, debits or candidates asked for), the
 * keyed ownership CTEs of card-settlement-ownership.ts (also under the
 * `statement_` and `debit_` prefixes the readiness CTEs give them), the keyed
 * readiness CTEs of card-settlement-readiness.ts and their aliases, and a JSON
 * argument.
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
  "chosen",
  "chosen_ids",
  "ready_candidates",
  "ready_candidate",
  "statement_partitions",
  "statement_partition",
  "ready_statements",
  "current_statement",
  "newer_statement",
  "debit_partitions",
  "debit_partition",
  "ready_debits",
  "current_debit",
  "statement_observed",
  "debit_observed",
  "readiness",
  ...["statement_", "debit_"].flatMap((prefix) =>
    ["owned_runs", "owned_candidates", "owned_latest", "owned_identity", "ownership"].map(
      (name) => `${prefix}${name}`,
    ),
  ),
  "statement_owner",
  "newer_owner",
  "debit_owner",
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
 * (migration 0044) ranks every capture of the history, and `ready_statements`
 * (card-settlement-readiness.ts) ranks the captures of the periods its
 * candidates' statements name; their whole read of the balance observations
 * (`b`) is the one documented in docs/card-settlements.md (Cost) and is
 * allowed. Nothing else may scan a base table there.
 */
const insideRanked = (steps: readonly PlanStep[], step: PlanStep): boolean =>
  ancestors(steps, step).some((detail) =>
    /^(?:CO-ROUTINE|MATERIALIZE) (?:ranked|ready_statements)$/u.test(detail),
  );

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
      // An automatic index is built from a whole read of its relation: fine
      // on a bounded CTE (the ownership CTEs alias theirs `r` and `l`), never
      // on a base table.
      const automatic = /^SEARCH (\S+) USING AUTOMATIC /u.exec(step.detail);
      if (automatic !== null)
        return !(
          bounded.has(automatic[1]!) ||
          ["r", "l"].includes(automatic[1]!) ||
          /^\(subquery-\d+\)$/u.test(automatic[1]!)
        );
      if (!step.detail.startsWith("SCAN ")) return false;
      // A JSON argument or a row's own JSON value (`json_each`, whatever its alias).
      if (/^SCAN \S+ VIRTUAL TABLE /u.test(step.detail)) return false;
      // The one row of `SELECT ?1 AS id`.
      if (step.detail === "SCAN CONSTANT ROW") return false;
      const name = step.detail.slice(5).split(" ")[0]!;
      if (bounded.has(name) || /^\(subquery-\d+\)$/u.test(name)) return false;
      if (name === "ranked") return false;
      if (name === "b" && insideRanked(steps, step)) return false;
      return true;
    })
    .map((step) => step.detail);
}
