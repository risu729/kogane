// The balance projection's candidate sets from one latest-balance read
// (ADR 0129, slice 1). The capture used to run `listLatestBalances` three
// times, once unfiltered and once per measure view, and each run recomputed
// the same snapshot selection and ranking. One flagged read gives all three.

import type { BalanceRow } from "../../../packages/observation-shared/src/api-contract";
import { balanceRow, type BalanceSqlRow } from "./mappers";
import { ResultLimitExceededError, type SqlExecutor } from "./reader";
import { RESULT_BOUND } from "./scope";
import { LATEST_BALANCE_CANDIDATES_SQL } from "./sql";

export interface LatestBalanceCandidateSets {
  /** `listLatestBalances` without a measure view: each group's ranked latest. */
  latest: BalanceRow[];
  /** The `balances` measure view: ranked latest rows that are not period totals. */
  balances: BalanceRow[];
  /** The `summaries` measure view: period totals, with every MyJCB statement month kept. */
  summaries: BalanceRow[];
}

export interface LatestBalanceCandidateRow extends BalanceSqlRow {
  latest_in_group: number;
  is_summary: number;
}

/**
 * Each set holds the same rows `listLatestBalances` returns for it, ordered by
 * id. Like the reader, it refuses with `ResultLimitExceededError` when any one
 * set is over the 5,000-row bound, rather than returning a partial set.
 */
export async function readLatestBalanceCandidates(
  executor: SqlExecutor,
): Promise<LatestBalanceCandidateSets> {
  const rows = await executor.all<LatestBalanceCandidateRow>(LATEST_BALANCE_CANDIDATES_SQL, []);
  // The union of the views is at most twice the bound while each is within it.
  if (rows.length > 2 * RESULT_BOUND) throw new ResultLimitExceededError();
  return latestBalanceCandidateSets(rows);
}

export function latestBalanceCandidateSets(
  rows: readonly LatestBalanceCandidateRow[],
): LatestBalanceCandidateSets {
  const sets: LatestBalanceCandidateSets = { latest: [], balances: [], summaries: [] };
  for (const row of rows) {
    const latest = Number(row.latest_in_group) === 1;
    const summary = Number(row.is_summary) === 1;
    const balance = balanceRow(row);
    if (latest) sets.latest.push(balance);
    if (latest && !summary) sets.balances.push(balance);
    if (summary) sets.summaries.push(balance);
  }
  for (const set of Object.values(sets))
    if (set.length > RESULT_BOUND) throw new ResultLimitExceededError();
  return sets;
}
