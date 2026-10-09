// The shipped Transactions/Balances capture selections (ADR 0045 amendment).
// Compose these texts, never copy their rules into a second reader. They
// select published eligible captures, not full provider-history coverage.
import { activeStateProjection, visibleEvidence } from "./concepts";

const ACTIVE = activeStateProjection.predicate;
const PARSE_CHAIN = activeStateProjection.parseChain;

/** The existing partition expression, not a new date parser. */
export const MONEYFORWARD_MONTH = (fa: string): string => `substr(${fa}.artifact_key, -12, 7)`;
/** The existing connection partition, not an account identity resolution. */
export const MYJCB_PAST_MONTHS_CONNECTION = (fa: string): string =>
  `substr(${fa}.artifact_key, 1, instr(${fa}.artifact_key, '/') - 1)`;

export const SMBC_DIRECT_SNAPSHOT_CTES = `ranked_smbc_direct_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id, fa.artifact_key
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name = 'smbc-direct-transactions'
           AND fa.dataset = 'transactions-normalized'
       ), current_smbc_direct_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_smbc_direct_snapshots
         WHERE snapshot_rank = 1
       )`;

export const MONEYFORWARD_SNAPSHOT_CTES = `ranked_moneyforward_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id, fa.fetch_unit_key, ${MONEYFORWARD_MONTH("fa")}
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name = 'moneyforward-monthly-transactions'
           AND fa.dataset = 'monthly-transactions'
           AND (fa.fetch_unit_key LIKE 'moneyforward-account-v1-%'
             OR fa.fetch_unit_key LIKE 'moneyforward-account-v2-%')
       ), current_moneyforward_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_moneyforward_snapshots
         WHERE snapshot_rank = 1
       )`;

// V Point publishes one balance across three page datasets; a run is complete
// only when all three parsed and every expected artifact of the run parsed.
export const ELIGIBLE_VPOINT_RUNS = `eligible_vpoint_runs AS (
         SELECT DISTINCT f.id AS fetch_run_id, fa.source_id, f.completed_at
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name IN (
             'v-point-balance-info', 'v-point-smfg-point', 'v-point-history-page'
           )
         GROUP BY f.id, fa.source_id, f.completed_at
         HAVING COUNT(DISTINCT p.parser_name) = 3
            AND COUNT(DISTINCT p.fetch_artifact_id) = (
              SELECT COUNT(*)
              FROM ${visibleEvidence.fetchArtifacts} expected_fa
              WHERE expected_fa.fetch_run_id = f.id
                AND (
                  expected_fa.dataset IN ('balance-info', 'smfg-point')
                  OR expected_fa.dataset LIKE 'history-page-%'
                )
            )
       ), ranked_vpoint_runs AS (
         SELECT fetch_run_id,
                ROW_NUMBER() OVER (
                  PARTITION BY source_id
                  ORDER BY completed_at DESC, fetch_run_id DESC
                ) AS snapshot_rank
         FROM eligible_vpoint_runs
       ), current_vpoint_runs AS (
         SELECT fetch_run_id
         FROM ranked_vpoint_runs
         WHERE snapshot_rank = 1
       )`;

/**
 * Balances' legacy MyJCB name collides with the credit-ledger CTE. Only the
 * quality composition uses cq_; the default text remains byte-identical.
 */
export function myjcbPastMonthsSnapshotCtes(prefix: "" | "cq_" = ""): string {
  return `${prefix}ranked_myjcb_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY
                    fa.source_id,
                    ${MYJCB_PAST_MONTHS_CONNECTION("fa")}
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name = 'myjcb-credit-past-month-balances'
           AND fa.dataset = 'credit-past-months'
       ), ${prefix}current_myjcb_snapshots AS (
         SELECT fetch_artifact_id
         FROM ${prefix}ranked_myjcb_snapshots
         WHERE snapshot_rank = 1
       )`;
}

export const SMBC_DIRECT_MEMBER =
  "fa.id IN (SELECT fetch_artifact_id FROM current_smbc_direct_snapshots)";
export const MONEYFORWARD_MEMBER =
  "fa.id IN (SELECT fetch_artifact_id FROM current_moneyforward_snapshots)";
export const VPOINT_MEMBER = "f.id IN (SELECT fetch_run_id FROM current_vpoint_runs)";
export const MYJCB_PAST_MONTHS_MEMBER =
  "fa.id IN (SELECT fetch_artifact_id FROM cq_current_myjcb_snapshots)";
