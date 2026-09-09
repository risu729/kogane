// SQL text of every read, composed from the named concepts. Each function
// returns finished SQL plus bound arguments. Reading this file top to bottom
// answers "which view does this query read, and when is the filter applied".
//
// Filter/grouping order, per query:
//   listTransactions   rank duplicates within (source, account, parser, external id)
//                      over the whole active set, keep rank 1, THEN filter, order, page.
//   listLatestBalances rank witnesses within (source, parser family, unit, account,
//                      metric, instrument) over the whole active set, keep rank 1,
//                      THEN filter, order, page. Callers group again on the page.
//   listBalanceHistory no grouping; filter, order, page over visible parse results.
//   listPositions      no grouping; filter, order, page over the active set, then
//                      match valuations for the first 500 positions of that page.
//   listArtifacts      no grouping; id cursor and source filter inside the query.

import {
  activeStateProjection,
  completeSnapshotCandidates,
  OBSERVATION_TABLES,
  type ObservationKind,
  type ObservationTable,
  successfulFetchRuns,
  unitScopedDataset,
  unitSucceeded,
  visibleEvidence,
} from "./concepts";
import {
  type CollectionScope,
  type MeasureView,
  PAGE_LIMIT,
  type PageLimit,
  type PageSql,
  pagedCollection,
  periodMeasureSql,
} from "./scope";

const ACTIVE = activeStateProjection.predicate;
const PARSE_CHAIN = activeStateProjection.parseChain;
const SNAPSHOT_CTES = completeSnapshotCandidates.ctes;
const CURRENT_SNAPSHOT = completeSnapshotCandidates.currentMember;

/** Counted under their contract names; each name reads its visible relation. */
export const COUNTED_RELATIONS: readonly (readonly [string, string])[] = [
  ["sources", visibleEvidence.sources],
  ["fetch_runs", visibleEvidence.fetchRuns],
  ["raw_objects", visibleEvidence.rawObjects],
  ["fetch_artifacts", visibleEvidence.fetchArtifacts],
  ["parse_runs", visibleEvidence.parseRuns],
  ["transaction_observations", visibleEvidence.observations("transaction_observations")],
  ["balance_observations", visibleEvidence.observations("balance_observations")],
  ["position_observations", visibleEvidence.observations("position_observations")],
  ["valuation_observations", visibleEvidence.observations("valuation_observations")],
];

export const countSql = (relation: string): string => `SELECT COUNT(*) AS n FROM ${relation}`;

export const OVERVIEW_SOURCES_SQL = `SELECT s.id, s.provider, s.ingestion,
       COUNT(a.id) AS artifact_count
  FROM ${visibleEvidence.sources} s
  LEFT JOIN ${visibleEvidence.fetchArtifacts} a ON a.source_id = s.id
  GROUP BY s.id, s.provider, s.ingestion
  ORDER BY s.id`;

export const OVERVIEW_FETCH_RUNS_SQL = `SELECT id, source_id, tool, external_run_id, status, started_at, completed_at
  FROM ${visibleEvidence.fetchRuns} ORDER BY id DESC LIMIT ${PAGE_LIMIT}`;

export const OVERVIEW_PARSE_RUNS_SQL = `SELECT id, fetch_artifact_id, parser_name, parser_version, parsed_at, status,
       error, warnings_json, superseded_by_parse_run_id
  FROM ${visibleEvidence.parseRuns} ORDER BY id DESC LIMIT ${PAGE_LIMIT}`;

/**
 * D13 partial-update signal: fetch runs that did NOT succeed as a whole, on a
 * dataset whose policy row names the `unit` scope, where at least one unit was
 * nevertheless parseable. One row per (source, dataset, run) with how many
 * units this run refreshed and how many it left on their previous evidence.
 *
 * This is what stops a partial run from being presented as a complete refresh
 * of a dataset: the reader can say "some units updated" and name the counts.
 * Identifiers and counts only — no unit keys, amounts or failure text, since
 * a unit key is a provider-owned card/connection label. The list is empty for
 * every dataset on the seeded `run` scope, so the response shape of every
 * existing dataset is unchanged.
 */
export const UNIT_UPDATES_SQL = `SELECT fa.source_id, fa.dataset, fa.fetch_run_id,
       MAX(fa.fetched_at) AS fetched_at,
       COUNT(DISTINCT CASE WHEN au.unit_status = 'success' THEN fa.fetch_unit_key END) AS updated_units,
       COUNT(DISTINCT CASE WHEN au.unit_status <> 'success' THEN fa.fetch_unit_key END) AS stale_units
  FROM ${visibleEvidence.fetchArtifacts} fa
  JOIN ${visibleEvidence.fetchRuns} f ON f.id = fa.fetch_run_id
  JOIN ${unitSucceeded.relation} au ON au.fetch_artifact_id = fa.id
 WHERE NOT (${successfulFetchRuns.predicate("f")})
   AND ${unitScopedDataset.predicate("fa")}
 GROUP BY fa.source_id, fa.dataset, fa.fetch_run_id
HAVING updated_units > 0
 ORDER BY fa.fetch_run_id DESC LIMIT ${PAGE_LIMIT}`;

/** Confirms the sealed read view is reachable before health is reported. */
export const VISIBLE_EVIDENCE_PROBE_SQL = `SELECT id FROM ${visibleEvidence.fetchArtifacts} LIMIT 1`;

/**
 * Registered parse jobs still pending, running, or failed. A failure counts
 * only until a newer published parse of the same parser repairs it; retired
 * parser versions are operational noise, not backlog. This "repaired" test is
 * a health notion about jobs and reads the job table and parse runs directly;
 * it is not a visibility rule.
 */
export const PARSING_HEALTH_SQL = `SELECT j.status, count(*) AS count FROM observation_parse_jobs j
      WHERE j.status IN ('pending','running','failed')
        AND coalesce(j.last_error_code, '') <> 'parser_version_retired'
        AND (j.status <> 'failed' OR NOT EXISTS (
          SELECT 1 FROM published_parse_runs published
          JOIN parse_runs success ON success.id = published.parse_run_id
          WHERE published.fetch_artifact_id = j.fetch_artifact_id
            AND published.parser_name = j.parser_name
            AND success.parsed_at > coalesce((
              SELECT max(failed.parsed_at) FROM parse_runs failed
              WHERE failed.fetch_artifact_id = j.fetch_artifact_id
                AND failed.parser_name = j.parser_name
                AND failed.parser_version = j.parser_version AND failed.status = 'error'
            ), '')
        )) GROUP BY j.status`;

// V Point publishes one balance across three page datasets; a run is complete
// only when all three parsed and every expected artifact of the run parsed.
const ELIGIBLE_VPOINT_RUNS = `eligible_vpoint_runs AS (
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

const VPASS_STATEMENT_MONTH = (artifact: string): string =>
  `CASE WHEN substr(${artifact}.artifact_key, 1, 7) = 'months/'
                   THEN substr(${artifact}.artifact_key, 8, 6)
                   ELSE substr(${artifact}.artifact_key, 23, 6)
                 END`;

const TRANSACTION_CTES = `ranked_myjcb_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY
                    fa.source_id,
                    substr(fa.artifact_key, 1, instr(fa.artifact_key, '/') - 1),
                    fa.statement_state,
                    CASE WHEN fa.statement_state = 'unconfirmed' THEN '' ELSE fa.period END
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name = 'myjcb-credit-ledger'
           AND fa.dataset = 'credit-ledger'
       ), current_myjcb_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_myjcb_snapshots
         WHERE snapshot_rank = 1
       ), ranked_smbc_direct_snapshots AS (
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
       ), ranked_global_pass_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id, fa.artifact_key
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name = 'global-pass-activity'
           AND fa.dataset = 'globalpass-activity'
       ), current_global_pass_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_global_pass_snapshots
         WHERE snapshot_rank = 1
       ), ranked_moneyforward_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id, fa.fetch_unit_key, substr(fa.artifact_key, -12, 7)
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name = 'moneyforward-monthly-transactions'
           AND fa.dataset = 'monthly-transactions'
           AND fa.fetch_unit_key LIKE 'moneyforward-account-v1-%'
       ), current_moneyforward_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_moneyforward_snapshots
         WHERE snapshot_rank = 1
       ), ${ELIGIBLE_VPOINT_RUNS}, eligible_vpass_snapshots AS (
         SELECT fa.fetch_run_id, fa.source_id, fa.fetch_unit_key,
                ${VPASS_STATEMENT_MONTH("fa")} AS statement_month,
                MAX(fa.fetched_at) AS fetched_at
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name = 'vpass-statement-page'
           AND fa.dataset = 'statement-page'
           AND fa.fetch_unit_key IS NOT NULL
         GROUP BY fa.fetch_run_id, fa.source_id, fa.fetch_unit_key, statement_month
         HAVING COUNT(DISTINCT fa.id) = (
           SELECT COUNT(*)
           FROM ${visibleEvidence.fetchArtifacts} expected_fa
           WHERE expected_fa.fetch_run_id = fa.fetch_run_id
             AND expected_fa.source_id = fa.source_id
             AND expected_fa.dataset = 'statement-page'
             AND expected_fa.fetch_unit_key = fa.fetch_unit_key
             AND ${VPASS_STATEMENT_MONTH("expected_fa")} = ${VPASS_STATEMENT_MONTH("fa")}
         )
       ), ranked_vpass_snapshots AS (
         SELECT fetch_run_id, source_id, fetch_unit_key, statement_month, fetched_at,
                ROW_NUMBER() OVER (
                  PARTITION BY source_id, fetch_unit_key, statement_month
                  ORDER BY fetched_at DESC, fetch_run_id DESC
                ) AS snapshot_rank
         FROM eligible_vpass_snapshots
       ), current_vpass_snapshots AS (
         SELECT fetch_run_id, source_id, fetch_unit_key, statement_month
         FROM ranked_vpass_snapshots
         WHERE snapshot_rank = 1
       )`;

/**
 * Current transactions: one row per provider transaction identity. Sources
 * whose exports overlap are ranked so the historical/official witness wins;
 * container datasets keep only their latest complete capture.
 */
const TRANSACTIONS_SQL = `WITH ${TRANSACTION_CTES}
       SELECT id, source_id, source_account, as_of, amount_minor, amount_text,
              currency, description, counterparty, external_id, status, parser
       FROM (
         SELECT t.id, fa.source_id, t.source_account, t.as_of,
                CAST(t.amount_minor AS TEXT) AS amount_minor, t.amount_text,
                t.currency, t.description, t.counterparty, t.external_id, t.status,
                p.parser_name || '@' || p.parser_version AS parser,
                ROW_NUMBER() OVER (
                  PARTITION BY CASE
                    WHEN p.parser_name IN (
                           'sbi-vc-executions',
                           'sbi-vc-cashflows',
                           'mobile-suica-sf-history',
                           'sbi-yen-detail-history',
                           'sbi-foreign-trade-records',
                           'sbi-domestic-trade-records',
                           'myjcb-credit-ledger',
                           'sony-bank-history-json',
                           'sony-bank-history-csv',
                           'sony-bank-wallet-history',
                           'smbc-direct-transactions',
                           'sbi-shinsei-top-balances-and-activity',
                           'v-point-pay-notification-event'
                         ) AND t.external_id IS NOT NULL
                      THEN json_array(fa.source_id, t.source_account,
                        CASE WHEN p.parser_name IN (
                          'sony-bank-history-json', 'sony-bank-history-csv'
                        ) THEN 'sony-bank-deposit-history' ELSE p.parser_name END,
                        t.external_id)
                    ELSE json_array('observation-row', t.id)
                  END
                  ORDER BY CASE json_extract(t.extra_json, '$._kogane.sourceView')
                    WHEN 'historical' THEN 0
                    WHEN 'official-csv' THEN 0
                    WHEN 'wallet-monthly-html' THEN 0
                    WHEN 'provider-json' THEN 1
                    WHEN 'recent' THEN 1
                    ELSE 2
                  END,
                  fa.fetched_at DESC,
                  t.id DESC
                ) AS rank_in_identity
         FROM ${activeStateProjection.observationChain("transaction_observations", "t")}
         WHERE ${ACTIVE}
           AND (
             p.parser_name <> 'myjcb-credit-ledger'
             OR fa.id IN (SELECT fetch_artifact_id FROM current_myjcb_snapshots)
           )
           AND (
             p.parser_name <> 'smbc-direct-transactions'
             OR fa.id IN (SELECT fetch_artifact_id FROM current_smbc_direct_snapshots)
           )
           AND (
             p.parser_name <> 'global-pass-activity'
             OR fa.id IN (SELECT fetch_artifact_id FROM current_global_pass_snapshots)
           )
           AND (
             p.parser_name <> 'v-point-history-page'
             OR f.id IN (SELECT fetch_run_id FROM current_vpoint_runs)
           )
           AND (
             p.parser_name <> 'vpass-statement-page'
             OR EXISTS (
               SELECT 1
               FROM current_vpass_snapshots snapshot
               WHERE snapshot.fetch_run_id = fa.fetch_run_id
                 AND snapshot.source_id = fa.source_id
                 AND snapshot.fetch_unit_key = fa.fetch_unit_key
                 AND snapshot.statement_month = ${VPASS_STATEMENT_MONTH("fa")}
             )
           )
           AND (
             p.parser_name <> 'moneyforward-monthly-transactions'
             OR fa.id IN (SELECT fetch_artifact_id FROM current_moneyforward_snapshots)
           )
       )
       WHERE rank_in_identity = 1`;

export function transactionsSql(scope: CollectionScope, offset: number): PageSql {
  return pagedCollection(
    TRANSACTIONS_SQL,
    scope,
    ["source", "account", "from", "to", "q"],
    "transactionsByDateDesc",
    PAGE_LIMIT,
    offset,
  );
}

/**
 * Latest balance per (source, parser family, fetch unit, account, metric,
 * instrument). The source is part of the key because `source_account` is only
 * the provider's own label. Computed on request and stored nowhere.
 */
function latestBalancesInner(measureView: MeasureView | undefined): string {
  // Period totals are one witness per statement month, so in the summaries
  // view every MyJCB payment amount is kept, not only the ranked latest.
  const keepPeriodTotals =
    measureView === "summaries"
      ? " OR (source_id = 'myjcb' AND parser LIKE 'myjcb-credit-past-month-balances@%' AND metric = 'credit_statement_payment_amount')"
      : "";
  return `WITH ${SNAPSHOT_CTES}, ranked_myjcb_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY
                    fa.source_id,
                    substr(fa.artifact_key, 1, instr(fa.artifact_key, '/') - 1)
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM ${PARSE_CHAIN}
         WHERE ${ACTIVE}
           AND p.parser_name = 'myjcb-credit-past-month-balances'
           AND fa.dataset = 'credit-past-months'
       ), current_myjcb_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_myjcb_snapshots
         WHERE snapshot_rank = 1
       ), ${ELIGIBLE_VPOINT_RUNS}
       SELECT id, source_id, source_account, metric, instrument, amount_minor,
              amount_text, as_of, observed_at, parser
       FROM (
         SELECT b.id, fa.source_id, b.source_account, b.metric, b.instrument,
                CAST(b.amount_minor AS TEXT) AS amount_minor, b.amount_text,
                b.as_of, b.observed_at,
                p.parser_name || '@' || p.parser_version AS parser,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id,
                               CASE WHEN p.parser_name IN (
                                 'sony-bank-history-json', 'sony-bank-history-csv'
                               ) THEN 'sony-bank-deposit-history' ELSE p.parser_name END,
                               fa.fetch_unit_key,
                               b.source_account, b.metric, b.instrument
                  ORDER BY
                    CASE WHEN p.parser_name = 'myjcb-credit-past-month-balances'
                      THEN CAST(json_extract(b.extra_json, '$._kogane.detailMonth') AS INTEGER)
                    END ASC,
                    CASE WHEN p.parser_name <> 'myjcb-credit-past-month-balances'
                      THEN COALESCE(b.as_of, b.observed_at, '')
                    END DESC,
                    b.id DESC
                ) AS rank_in_group
         FROM ${activeStateProjection.observationChain("balance_observations", "b")}
         WHERE ${ACTIVE}
           AND ${CURRENT_SNAPSHOT}
           AND (
             p.parser_name <> 'myjcb-credit-past-month-balances'
             OR fa.id IN (SELECT fetch_artifact_id FROM current_myjcb_snapshots)
           )
           AND (
             p.parser_name NOT IN ('v-point-balance-info', 'v-point-smfg-point')
             OR f.id IN (SELECT fetch_run_id FROM current_vpoint_runs)
           )
       )
       WHERE rank_in_group = 1${keepPeriodTotals}`;
}

export function latestBalancesSql(
  scope: CollectionScope,
  offset: number,
  limit: PageLimit,
): PageSql {
  return pagedCollection(
    latestBalancesInner(scope.measureView),
    scope,
    ["source", "account", "instrument", "metric", "measureView"],
    "balancesByScope",
    limit,
    offset,
  );
}

/** The full append-only history over visible parse results, superseded rows included and marked. */
export const BALANCE_HISTORY_SQL = `SELECT b.id, fa.source_id, b.source_account, b.metric, b.instrument,
              CAST(b.amount_minor AS TEXT) AS amount_minor,
              b.amount_text, b.as_of, b.observed_at,
              p.parser_name || '@' || p.parser_version AS parser,
              p.superseded_by_parse_run_id, p.status AS parse_status
       FROM balance_observations b
       JOIN ${visibleEvidence.parseRuns} p ON p.id = b.parse_run_id
       JOIN ${visibleEvidence.fetchArtifacts} fa ON fa.id = p.fetch_artifact_id`;

export function balanceHistorySql(scope: CollectionScope, offset: number): PageSql {
  return pagedCollection(
    BALANCE_HISTORY_SQL,
    scope,
    ["source", "account", "instrument", "metric", "measureView"],
    "balanceHistoryByDateDesc",
    PAGE_LIMIT,
    offset,
  );
}

const POSITIONS_SQL = `WITH ${SNAPSHOT_CTES}
       SELECT po.id, fa.source_id, po.source_account, po.security_code, po.security_name,
              po.market, po.quantity_text, po.quantity_scale, po.currency, po.as_of,
              p.parser_name || '@' || p.parser_version AS parser
       FROM ${activeStateProjection.observationChain("position_observations", "po")}
       WHERE ${ACTIVE} AND ${CURRENT_SNAPSHOT}`;

export function positionsSql(scope: CollectionScope, offset: number): PageSql {
  return pagedCollection(
    POSITIONS_SQL,
    scope,
    ["source", "account"],
    "positionsByScope",
    PAGE_LIMIT,
    offset,
  );
}

/**
 * Provider-reported valuations of the given positions, matched within the
 * same parse snapshot and provider row. Source-specific locator guards keep
 * equal codes in two markets apart. Valuations are never summed or converted.
 */
export const POSITION_VALUATIONS_SQL = `WITH ${SNAPSHOT_CTES}
    SELECT po.id AS position_id, v.id, fa.source_id, v.source_account, v.subject, v.metric,
      CAST(v.amount_minor AS TEXT) AS amount_minor, v.amount_text, v.currency, v.as_of,
      p.parser_name || '@' || p.parser_version AS parser
    FROM position_observations po
    JOIN valuation_observations v ON v.parse_run_id = po.parse_run_id
      AND v.source_account = po.source_account AND v.subject = po.security_code
    JOIN parse_runs p ON p.id = po.parse_run_id
    JOIN ${visibleEvidence.fetchArtifacts} fa ON fa.id = p.fetch_artifact_id
    JOIN ${visibleEvidence.fetchRuns} f ON f.id = fa.fetch_run_id
    WHERE po.id IN (SELECT value FROM json_each(?1))
      AND ${ACTIVE} AND ${CURRENT_SNAPSHOT} AND CASE p.parser_name
      WHEN 'sbi-foreign-cash-positions'
        THEN v.raw_locator = po.raw_locator || '.evaluationProfitLoss'
      WHEN 'sbi-domestic-cash-positions'
        THEN CAST(substr(v.raw_locator, 28) AS INTEGER)
          BETWEEN CAST(substr(po.raw_locator, 28) AS INTEGER)
          AND CAST(substr(po.raw_locator, 28) AS INTEGER) + 422
      ELSE 1
    END`;

const observationCount = (table: ObservationTable, alias: string): string =>
  `(SELECT COUNT(*) FROM ${table} ${alias}
                 JOIN ${visibleEvidence.parseRuns} p ON p.id = ${alias}.parse_run_id
                WHERE p.fetch_artifact_id = a.id)`;

/** Visible artifacts newest first below an id cursor, with visible parse and observation counts. */
export const ARTIFACTS_SQL = `SELECT a.id, a.source_id, a.dataset, a.url, a.mime, a.fetched_at, a.sha256,
              (SELECT COUNT(*) FROM ${visibleEvidence.parseRuns} p WHERE p.fetch_artifact_id = a.id)
                AS parse_run_count,
              ${observationCount("transaction_observations", "t")} AS transaction_count,
              ${observationCount("balance_observations", "b")} AS balance_count,
              ${observationCount("position_observations", "o")} AS position_count,
              ${observationCount("valuation_observations", "v")} AS valuation_count
       FROM ${visibleEvidence.fetchArtifacts} a
       WHERE a.id < ?1 AND (?2 IS NULL OR a.source_id = ?2) ORDER BY a.id DESC LIMIT ${PAGE_LIMIT}`;

export const FILTER_SOURCES_SQL = `SELECT DISTINCT source_id FROM ${visibleEvidence.fetchArtifacts} ORDER BY source_id`;

/**
 * Filter membership. Transactions and positions offer the accounts of the
 * active set. Balances offer every account, instrument and metric among
 * visible parse results, so a historical row stays reachable through the
 * filter after its parse was superseded; the measure view narrows by family.
 */
export function filterAccountsSql(table: ObservationTable, balanceScope: string | null): string {
  return `SELECT DISTINCT fa.source_id, o.source_account FROM ${table} o
    JOIN ${visibleEvidence.parseRuns} p ON p.id=o.parse_run_id
    JOIN ${visibleEvidence.fetchArtifacts} fa ON fa.id=p.fetch_artifact_id
    JOIN ${visibleEvidence.fetchRuns} f ON f.id=fa.fetch_run_id
    WHERE ${balanceScope ?? ACTIVE} ORDER BY fa.source_id, o.source_account`;
}

export function filterDimensionsSql(balanceScope: string): string {
  return `SELECT DISTINCT o.instrument, o.metric FROM balance_observations o
    JOIN ${visibleEvidence.parseRuns} p ON p.id=o.parse_run_id
    JOIN ${visibleEvidence.fetchArtifacts} fa ON fa.id=p.fetch_artifact_id
    JOIN ${visibleEvidence.fetchRuns} f ON f.id=fa.fetch_run_id
    WHERE ${balanceScope}`;
}

export function balanceFilterScope(measureView: MeasureView | undefined): string {
  if (!measureView) return "1";
  const summary = periodMeasureSql(
    "fa.source_id",
    "(p.parser_name || '@' || p.parser_version)",
    "o.metric",
  );
  return measureView === "summaries" ? summary : `NOT ${summary}`;
}

export const ARTIFACT_DETAIL_SQL = `SELECT a.id, a.source_id, a.dataset, a.url, a.method, a.http_status, a.mime,
              a.fetched_at, a.sha256, r.size, r.content_type,
              f.id AS fetch_run_id, f.tool, f.external_run_id,
              f.status AS fetch_status, f.started_at, f.completed_at
       FROM ${visibleEvidence.fetchArtifacts} a
       JOIN ${visibleEvidence.rawObjects} r ON r.sha256 = a.sha256
       JOIN ${visibleEvidence.fetchRuns} f ON f.id = a.fetch_run_id
       WHERE a.id = ?1`;

/** Every recorded parse run over one artifact, superseded and failed included, oldest first. */
export const ARTIFACT_PARSE_RUNS_SQL = `SELECT id, parser_name, parser_version, parsed_at, status, error,
              warnings_json, superseded_by_parse_run_id
       FROM ${visibleEvidence.parseRuns} WHERE fetch_artifact_id = ?1 ORDER BY id`;

const REFERENCE_COLUMNS: Record<ObservationKind, string> = {
  transaction: "id, source_account, as_of, description",
  balance: "id, source_account, metric, instrument, as_of",
  position: "id, source_account, security_code, security_name",
  valuation: "id, source_account, subject, metric, currency",
};

export function parseRunObservationsSql(kind: ObservationKind): string {
  return `SELECT ${REFERENCE_COLUMNS[kind]}
       FROM ${visibleEvidence.observations(OBSERVATION_TABLES[kind])} WHERE parse_run_id = ?1 ORDER BY id`;
}

export function observationDetailSql(kind: ObservationKind): string {
  // Positions store a quantity, not an amount. Other kinds need the trailing
  // CAST to preserve every digit while still returning all stored columns.
  const columns = kind === "position" ? "*" : "*, CAST(amount_minor AS TEXT) AS amount_minor";
  return `SELECT ${columns} FROM ${visibleEvidence.observations(OBSERVATION_TABLES[kind])} WHERE id = ?1`;
}

export const PROVENANCE_SQL = `SELECT p.id AS parse_run_id, p.parser_name, p.parser_version, p.parsed_at,
              p.status AS parse_status, p.error, p.warnings_json,
              p.superseded_by_parse_run_id,
              a.id AS artifact_id, a.source_id, a.dataset, a.url, a.mime, a.fetched_at,
              r.sha256, r.size, r.content_type,
              f.id AS fetch_run_id, f.tool, f.external_run_id,
              f.status AS fetch_status, f.started_at, f.completed_at
       FROM ${visibleEvidence.parseRuns} p
       JOIN ${visibleEvidence.fetchArtifacts} a ON a.id = p.fetch_artifact_id
       JOIN ${visibleEvidence.rawObjects} r ON r.sha256 = a.sha256
       JOIN ${visibleEvidence.fetchRuns} f ON f.id = a.fetch_run_id
       WHERE p.id = ?1`;

/**
 * A raw object is downloadable only when reachable through a visible
 * artifact. Independent of every list limit: this join is re-evaluated for
 * the single hash on each download, after authentication.
 */
export const RAW_DOWNLOAD_SQL = `SELECT o.sha256, o.blob_key, o.byte_size,
        a.artifact_key, a.mime AS declared_media_type
      FROM raw_objects o JOIN ${visibleEvidence.fetchArtifacts} a ON a.sha256 = o.sha256
      WHERE o.sha256 = ? ORDER BY a.id ASC LIMIT 1`;
