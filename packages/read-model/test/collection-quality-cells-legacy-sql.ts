// The collection quality cell page (`CELL_QUALITY_SQL` in
// src/collection-quality.ts) exactly as it shipped before ADR 0088 split its
// CTEs out as `CELL_RESULT_CTES` (main at commit 76a01e11, rendered text),
// frozen so collection-quality.test.ts can prove that the current cell page
// and the account coverage read (`ACCOUNT_COVERAGE_SQL`) return the shipped
// cells row for row on scaled and random stores. The digest pins the text:
// never edit it by hand, and never import it outside tests.

/** SHA-256 of `LEGACY_CELL_QUALITY_SQL`. */
export const LEGACY_CELL_QUALITY_SQL_SHA256 =
  "83c1ce9f5c0bf98a69d0869fd2a3ab582470d1b75640b7cec509bf6c7d66a761";

export const LEGACY_CELL_QUALITY_SQL = `WITH snapshot_policies(parser_name, dataset, required_version, policy_id, replaces_previous_on_complete_empty, unit_scope) AS (
  SELECT parser_name, dataset, required_parser_version, policy_id, replaces_previous_on_complete_empty, unit_scope
  FROM dataset_snapshot_policies WHERE snapshot_selection = 1
), eligible_snapshots AS (
  SELECT fa.source_id, policy.parser_name, policy.required_version, fa.dataset, fa.fetch_unit_key,
         fa.fetch_run_id, MAX(fa.fetched_at) AS fetched_at, MAX(fa.id) AS artifact_id
  FROM observation_fetch_artifacts fa
  JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
  JOIN snapshot_policies policy ON policy.dataset = fa.dataset
  -- Run scope (default, unchanged) or, for a dataset whose policy row names
  -- unit-independent-v1, this artifact's own unit. The grouping below is
  -- already per fetch_unit_key, so a rescued unit can only ever replace its
  -- own partition; a failed sibling unit contributes no row and keeps its
  -- previous snapshot.
  WHERE (f.status = 'success' AND f.failure_count = 0)
     OR (policy.unit_scope = 'unit' AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success'))
  GROUP BY fa.source_id, policy.parser_name, policy.required_version, fa.dataset,
           fa.fetch_unit_key, fa.fetch_run_id
  HAVING COUNT(*) = SUM(CASE WHEN EXISTS (
    SELECT 1 FROM parse_runs complete_parse
    WHERE complete_parse.fetch_artifact_id = fa.id
      AND complete_parse.parser_name = policy.parser_name
      AND (policy.required_version IS NULL OR complete_parse.parser_version = policy.required_version)
      AND EXISTS (SELECT 1 FROM published_parse_runs published
                  WHERE published.parse_run_id = complete_parse.id)
      -- Membership is decided by the dataset's active policy: the stored
      -- coverage claim under coverage-v1, the confined warning-text adapter
      -- under legacy-warning-compat-v1.
      AND CASE policy.policy_id
        WHEN 'coverage-v1' THEN EXISTS (
        SELECT 1 FROM parse_coverage_claims claim
        WHERE claim.parse_run_id = complete_parse.id
          AND claim.mode = 'complete-container'
          AND claim.scope_key = fa.source_id || '/' || COALESCE(fa.dataset, '') || CASE WHEN fa.fetch_unit_key IS NULL THEN '' ELSE '/unit=' || fa.fetch_unit_key END
          AND claim.completeness = 'complete'
          AND claim.membership_complete = 1
          AND claim.failure_cause IS NULL
          AND (claim.observed_count > 0 OR policy.replaces_previous_on_complete_empty = 1)
      )
        ELSE (policy.parser_name NOT IN (
        'sbi-foreign-cash-positions', 'sbi-foreign-cash-balances'
      ) OR NOT EXISTS (
        SELECT 1 FROM json_each(complete_parse.warnings_json) warning
        WHERE warning.type <> 'text' OR NOT (
          warning.value LIKE '% has no exact % minor-unit form; kept as text'
          OR instr(warning.value, ': fields not modelled as metrics were kept only in extra: ') > 0
        )
      ))
      END
  ) THEN 1 ELSE 0 END)
), ranked_snapshots AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY source_id, parser_name, dataset, fetch_unit_key
    ORDER BY fetched_at DESC, artifact_id DESC
  ) AS snapshot_rank FROM eligible_snapshots
), current_snapshots AS (
  SELECT * FROM ranked_snapshots WHERE snapshot_rank = 1
), artifact_container_policies(source_id, parser_name, artifact_key, fetch_unit_key, dataset, replaces_previous_on_complete_empty) AS (
  VALUES ('mizuho-bank', 'mizuho-account-list', 'account-list.html', 'account-list', 'mizuho-account-list-html', 1)
), eligible_artifact_containers AS (
  SELECT fa.id AS artifact_id, fa.source_id, container_policy.parser_name,
         fa.artifact_key, fa.fetch_unit_key, fa.fetched_at
  FROM observation_fetch_artifacts fa
  JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
  JOIN artifact_container_policies container_policy ON fa.source_id = container_policy.source_id
    AND fa.artifact_key = container_policy.artifact_key
    AND fa.fetch_unit_key = container_policy.fetch_unit_key
    AND (fa.dataset IS NULL OR fa.dataset = container_policy.dataset)
  WHERE f.status = 'success' AND f.failure_count = 0
    AND EXISTS (
      SELECT 1 FROM parse_runs complete_parse
      WHERE complete_parse.fetch_artifact_id = fa.id
        AND complete_parse.parser_name = container_policy.parser_name
        AND EXISTS (SELECT 1 FROM published_parse_runs published
                    WHERE published.parse_run_id = complete_parse.id)
        AND EXISTS (
        SELECT 1 FROM parse_coverage_claims claim
        WHERE claim.parse_run_id = complete_parse.id
          AND claim.mode = 'complete-container'
          AND claim.scope_key = fa.source_id || '/' || COALESCE(fa.dataset, '') || CASE WHEN fa.fetch_unit_key IS NULL THEN '' ELSE '/unit=' || fa.fetch_unit_key END
          AND claim.completeness = 'complete'
          AND claim.membership_complete = 1
          AND claim.failure_cause IS NULL
          AND (claim.observed_count > 0 OR container_policy.replaces_previous_on_complete_empty = 1)
      )
    )
), ranked_artifact_containers AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY source_id, parser_name, artifact_key, fetch_unit_key
    ORDER BY fetched_at DESC, artifact_id DESC
  ) AS snapshot_rank FROM eligible_artifact_containers
), current_artifact_containers AS (
  SELECT * FROM ranked_artifact_containers WHERE snapshot_rank = 1
),
eligible_global_pass_snapshots AS (
         SELECT fa.fetch_run_id, fa.source_id,
                substr(fa.artifact_key, 10, 7) AS activity_month,
                MAX(fa.fetched_at) AS fetched_at,
                MAX(fa.id) AS newest_artifact_id
         FROM parse_runs p
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
           AND p.parser_name = 'global-pass-activity'
           AND fa.dataset = 'globalpass-activity'
         GROUP BY fa.fetch_run_id, fa.source_id, activity_month
         HAVING COUNT(DISTINCT fa.id) = (
           SELECT COUNT(*)
           FROM observation_fetch_artifacts expected_fa
           WHERE expected_fa.fetch_run_id = fa.fetch_run_id
             AND expected_fa.source_id = fa.source_id
             AND expected_fa.dataset = 'globalpass-activity'
             AND substr(expected_fa.artifact_key, 10, 7) = substr(fa.artifact_key, 10, 7)
         )
       ), ranked_global_pass_snapshots AS (
         SELECT fetch_run_id, source_id, activity_month,
                ROW_NUMBER() OVER (
                  PARTITION BY source_id, activity_month
                  ORDER BY fetched_at DESC, newest_artifact_id DESC
                ) AS snapshot_rank
         FROM eligible_global_pass_snapshots
       ), current_global_pass_snapshots AS (
         SELECT member_fa.id AS fetch_artifact_id
         FROM ranked_global_pass_snapshots snapshot
         JOIN observation_fetch_artifacts member_fa
           ON member_fa.fetch_run_id = snapshot.fetch_run_id
          AND member_fa.source_id = snapshot.source_id
          AND member_fa.dataset = 'globalpass-activity'
          AND substr(member_fa.artifact_key, 10, 7) = snapshot.activity_month
         WHERE snapshot.snapshot_rank = 1
       ),
eligible_vpass_snapshots AS (
         SELECT fa.fetch_run_id, fa.source_id, fa.fetch_unit_key,
                CASE WHEN substr(fa.artifact_key, 1, 7) = 'months/'
                   THEN substr(fa.artifact_key, 8, 6)
                   ELSE substr(fa.artifact_key, 23, 6)
                 END AS statement_month,
                MAX(fa.fetched_at) AS fetched_at
         FROM parse_runs p
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
           AND p.parser_name = 'vpass-statement-page'
           AND fa.dataset = 'statement-page'
           AND fa.fetch_unit_key IS NOT NULL
         GROUP BY fa.fetch_run_id, fa.source_id, fa.fetch_unit_key, statement_month
         HAVING COUNT(DISTINCT fa.id) = (
           SELECT COUNT(*)
           FROM observation_fetch_artifacts expected_fa
           WHERE expected_fa.fetch_run_id = fa.fetch_run_id
             AND expected_fa.source_id = fa.source_id
             AND expected_fa.dataset = 'statement-page'
             AND expected_fa.fetch_unit_key = fa.fetch_unit_key
             AND CASE WHEN substr(expected_fa.artifact_key, 1, 7) = 'months/'
                   THEN substr(expected_fa.artifact_key, 8, 6)
                   ELSE substr(expected_fa.artifact_key, 23, 6)
                 END = CASE WHEN substr(fa.artifact_key, 1, 7) = 'months/'
                   THEN substr(fa.artifact_key, 8, 6)
                   ELSE substr(fa.artifact_key, 23, 6)
                 END
         )
       ), ranked_vpass_snapshots AS (
         SELECT fetch_run_id, source_id, fetch_unit_key, statement_month, fetched_at,
                ROW_NUMBER() OVER (
                  PARTITION BY source_id, fetch_unit_key, statement_month
                  ORDER BY fetched_at DESC, fetch_run_id DESC
                ) AS snapshot_rank
         FROM eligible_vpass_snapshots
       ), current_vpass_snapshots AS (
         SELECT fetch_run_id, source_id, fetch_unit_key, statement_month, fetched_at
         FROM ranked_vpass_snapshots
         WHERE snapshot_rank = 1
       ),
ranked_myjcb_snapshots AS (
         SELECT fetch_artifact_id, statement_slot,
                ROW_NUMBER() OVER (
                  PARTITION BY source_id, connection, statement_state, statement_slot
                  ORDER BY fetched_at DESC, artifact_id DESC
                ) AS snapshot_rank,
                CASE WHEN statement_state = 'unconfirmed' THEN ROW_NUMBER() OVER (
                  PARTITION BY source_id, artifact_key
                  ORDER BY fetched_at DESC, artifact_id DESC
                ) ELSE 1 END AS position_rank
         FROM (
           SELECT p.fetch_artifact_id, fa.id AS artifact_id, fa.source_id, fa.fetched_at,
                  fa.artifact_key,
                  substr(fa.artifact_key, 1, instr(fa.artifact_key, '/') - 1) AS connection,
                  fa.statement_state,
                  coalesce(CASE
             WHEN length(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9')) = 7 AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) GLOB '[0-9][0-9][0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 1) = '-'
               AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2) GLOB '[0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2) BETWEEN '01' AND '12'
               THEN replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9')
             WHEN length(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9')) = 6 AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) GLOB '[0-9][0-9][0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 2) GLOB '[0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 2) BETWEEN '01' AND '12'
               THEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) || '-' || substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 2)
             WHEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) GLOB '[0-9][0-9][0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 1) = '年' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 1) GLOB '[1-9]'
               AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 7) IN ('月', '月お支払い分')
               THEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) || '-0' || substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 1)
             WHEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) GLOB '[0-9][0-9][0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 1) = '年' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2) GLOB '[0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2) BETWEEN '01' AND '12'
               AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 8) IN ('月', '月お支払い分')
               THEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) || '-' || substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2)
             WHEN fa.period IN ('detailMonth-0', 'detailMonth-1') AND datetime(fa.fetched_at, '+9 hours') IS NOT NULL
               THEN strftime('%Y-%m', datetime(fa.fetched_at, '+9 hours'), 'start of month', printf('%+d months',
                 CASE WHEN CAST(strftime('%d', datetime(fa.fetched_at, '+9 hours')) AS INTEGER) <= 15 THEN 1 ELSE 2 END
                 - CAST(substr(fa.period, 13) AS INTEGER)))
           END,
              CASE WHEN substr(fa.period, 1, 12) = 'detailMonth-' THEN NULL ELSE fa.period END) AS statement_slot
           FROM parse_runs p
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
           WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
             AND p.parser_name = 'myjcb-credit-ledger'
             AND fa.dataset = 'credit-ledger'
         ) captures
       ), current_myjcb_snapshots AS (
         SELECT fetch_artifact_id, statement_slot
         FROM ranked_myjcb_snapshots
         WHERE snapshot_rank = 1 AND position_rank = 1 AND statement_slot IS NOT NULL
       ),
ranked_smbc_direct_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id, fa.artifact_key
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM parse_runs p
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
           AND p.parser_name = 'smbc-direct-transactions'
           AND fa.dataset = 'transactions-normalized'
       ), current_smbc_direct_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_smbc_direct_snapshots
         WHERE snapshot_rank = 1
       ),
ranked_moneyforward_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id, fa.fetch_unit_key, substr(fa.artifact_key, -12, 7)
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM parse_runs p
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
           AND p.parser_name = 'moneyforward-monthly-transactions'
           AND fa.dataset = 'monthly-transactions'
           AND (fa.fetch_unit_key LIKE 'moneyforward-account-v1-%'
             OR fa.fetch_unit_key LIKE 'moneyforward-account-v2-%')
       ), current_moneyforward_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_moneyforward_snapshots
         WHERE snapshot_rank = 1
       ),
eligible_vpoint_runs AS (
         SELECT DISTINCT f.id AS fetch_run_id, fa.source_id, f.completed_at
         FROM parse_runs p
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
           AND p.parser_name IN (
             'v-point-balance-info', 'v-point-smfg-point', 'v-point-history-page'
           )
         GROUP BY f.id, fa.source_id, f.completed_at
         HAVING COUNT(DISTINCT p.parser_name) = 3
            AND COUNT(DISTINCT p.fetch_artifact_id) = (
              SELECT COUNT(*)
              FROM observation_fetch_artifacts expected_fa
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
       ),
cq_ranked_myjcb_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY
                    fa.source_id,
                    substr(fa.artifact_key, 1, instr(fa.artifact_key, '/') - 1)
                  ORDER BY fa.fetched_at DESC, fa.id DESC
                ) AS snapshot_rank
         FROM parse_runs p
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
           AND p.parser_name = 'myjcb-credit-past-month-balances'
           AND fa.dataset = 'credit-past-months'
       ), cq_current_myjcb_snapshots AS (
         SELECT fetch_artifact_id
         FROM cq_ranked_myjcb_snapshots
         WHERE snapshot_rank = 1
       ),
cq_artifacts AS MATERIALIZED (
  SELECT fa.id, fa.fetch_run_id, fa.source_id, fa.dataset, fa.artifact_key, fa.fetch_unit_key,
         fa.fetched_at, fa.sha256,
         CASE fa.dataset
           WHEN 'globalpass-activity' THEN 'activity-month'
           WHEN 'statement-page' THEN 'statement-month'
           WHEN 'credit-ledger' THEN 'statement-slot'
           WHEN 'transactions-normalized' THEN 'request-key'
           WHEN 'monthly-transactions' THEN 'account-month'
           WHEN 'credit-past-months' THEN 'connection'
           ELSE 'latest'
         END AS period_kind,
         CASE fa.dataset
           WHEN 'globalpass-activity' THEN substr(fa.artifact_key, 10, 7)
           WHEN 'statement-page' THEN CASE WHEN substr(fa.artifact_key, 1, 7) = 'months/'
                   THEN substr(fa.artifact_key, 8, 6)
                   ELSE substr(fa.artifact_key, 23, 6)
                 END
           WHEN 'credit-ledger' THEN coalesce(CASE
             WHEN length(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9')) = 7 AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) GLOB '[0-9][0-9][0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 1) = '-'
               AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2) GLOB '[0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2) BETWEEN '01' AND '12'
               THEN replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9')
             WHEN length(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9')) = 6 AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) GLOB '[0-9][0-9][0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 2) GLOB '[0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 2) BETWEEN '01' AND '12'
               THEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) || '-' || substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 2)
             WHEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) GLOB '[0-9][0-9][0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 1) = '年' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 1) GLOB '[1-9]'
               AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 7) IN ('月', '月お支払い分')
               THEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) || '-0' || substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 1)
             WHEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) GLOB '[0-9][0-9][0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 5, 1) = '年' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2) GLOB '[0-9][0-9]' AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2) BETWEEN '01' AND '12'
               AND substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 8) IN ('月', '月お支払い分')
               THEN substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 1, 4) || '-' || substr(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(fa.period, ' ', ''), '　', ''), '０', '0'), '１', '1'), '２', '2'), '３', '3'), '４', '4'), '５', '5'), '６', '6'), '７', '7'), '８', '8'), '９', '9'), 6, 2)
             WHEN fa.period IN ('detailMonth-0', 'detailMonth-1') AND datetime(fa.fetched_at, '+9 hours') IS NOT NULL
               THEN strftime('%Y-%m', datetime(fa.fetched_at, '+9 hours'), 'start of month', printf('%+d months',
                 CASE WHEN CAST(strftime('%d', datetime(fa.fetched_at, '+9 hours')) AS INTEGER) <= 15 THEN 1 ELSE 2 END
                 - CAST(substr(fa.period, 13) AS INTEGER)))
           END,
              CASE WHEN substr(fa.period, 1, 12) = 'detailMonth-' THEN NULL ELSE fa.period END)
           WHEN 'transactions-normalized' THEN fa.artifact_key
           WHEN 'monthly-transactions' THEN substr(fa.artifact_key, -12, 7)
           WHEN 'credit-past-months' THEN substr(fa.artifact_key, 1, instr(fa.artifact_key, '/') - 1)
         END AS period,
         CASE WHEN fa.dataset = 'credit-ledger' THEN fa.statement_state END AS period_state
    FROM observation_fetch_artifacts fa
   WHERE fa.source_id = ?1
     AND (fa.dataset IS NOT NULL
          OR EXISTS (SELECT 1 FROM observation_parse_jobs job WHERE job.fetch_artifact_id = fa.id)
          OR EXISTS (SELECT 1 FROM parse_runs attempt
                      WHERE attempt.fetch_artifact_id = fa.id AND attempt.status <> 'pending' AND (attempt.status = 'error' OR attempt.superseded_by_parse_run_id IS NOT NULL OR EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = attempt.id))))
), cq_parsers AS MATERIALIZED (
  SELECT fa.id AS artifact_id, job.parser_name
    FROM cq_artifacts fa CROSS JOIN observation_parse_jobs job ON job.fetch_artifact_id = fa.id
  UNION
  SELECT fa.id, attempt.parser_name
    FROM cq_artifacts fa CROSS JOIN parse_runs attempt ON attempt.fetch_artifact_id = fa.id
   WHERE attempt.status <> 'pending' AND (attempt.status = 'error' OR attempt.superseded_by_parse_run_id IS NOT NULL OR EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = attempt.id))
), cq_targets AS MATERIALIZED (
  SELECT targeted.*, CASE
           WHEN targeted.dataset = 'globalpass-activity'
             AND coalesce(targeted.parser_name, 'global-pass-activity') = 'global-pass-activity'
             THEN 'global-pass-month'
           WHEN targeted.dataset = 'statement-page'
             AND coalesce(targeted.parser_name, 'vpass-statement-page') = 'vpass-statement-page'
             THEN 'vpass-card-month'
           WHEN targeted.dataset = 'credit-ledger'
             AND coalesce(targeted.parser_name, 'myjcb-credit-ledger') = 'myjcb-credit-ledger'
             THEN 'myjcb-statement-slot'
           WHEN targeted.dataset = 'transactions-normalized'
             AND coalesce(targeted.parser_name, 'smbc-direct-transactions') = 'smbc-direct-transactions'
             THEN 'smbc-request-key'
           WHEN targeted.dataset = 'monthly-transactions'
             AND coalesce(targeted.parser_name, 'moneyforward-monthly-transactions') = 'moneyforward-monthly-transactions'
             THEN 'moneyforward-account-month'
           WHEN targeted.dataset = 'credit-past-months'
             AND coalesce(targeted.parser_name, 'myjcb-credit-past-month-balances') = 'myjcb-credit-past-month-balances'
             THEN 'myjcb-connection'
           WHEN (targeted.dataset IN ('balance-info', 'smfg-point') OR targeted.dataset LIKE 'history-page-%')
             AND targeted.source_id = 'v-point'
             AND (targeted.parser_name IS NULL OR targeted.parser_name IN ('v-point-balance-info', 'v-point-smfg-point', 'v-point-history-page'))
             THEN 'v-point-complete-run'
           WHEN EXISTS (SELECT 1 FROM snapshot_policies policy
                         WHERE policy.dataset = targeted.dataset
                           AND coalesce(targeted.parser_name, policy.parser_name) = policy.parser_name)
             OR EXISTS (SELECT 1 FROM artifact_container_policies container_policy
                         WHERE container_policy.source_id = targeted.source_id
                           AND container_policy.artifact_key = targeted.artifact_key
                           AND container_policy.fetch_unit_key = targeted.fetch_unit_key
                           AND (targeted.dataset IS NULL OR targeted.dataset = container_policy.dataset)
                           AND coalesce(targeted.parser_name, container_policy.parser_name) = container_policy.parser_name)
             THEN 'container-snapshot'
           ELSE 'published-eligible'
         END AS current_rule
    FROM (
      SELECT fa.*, k.parser_name FROM cq_artifacts fa JOIN cq_parsers k ON k.artifact_id = fa.id
      UNION ALL
      SELECT fa.*, NULL FROM cq_artifacts fa
       WHERE NOT EXISTS (SELECT 1 FROM cq_parsers k WHERE k.artifact_id = fa.id)
    ) targeted
), cq_ordered AS MATERIALIZED (
  SELECT fa.*,
         MAX(fa.fetched_at) OVER capture AS run_captured_at,
         MAX(fa.id) OVER capture AS run_newest_id
    FROM cq_targets fa
  WINDOW capture AS (PARTITION BY dataset, parser_name, fetch_unit_key, period_kind, period, period_state, current_rule, fetch_run_id)
), cq_newest AS MATERIALIZED (
  SELECT * FROM (
    SELECT ordered.*, DENSE_RANK() OVER (
             PARTITION BY dataset, parser_name, fetch_unit_key, period_kind, period, period_state, current_rule
             ORDER BY run_captured_at DESC, run_newest_id DESC
           ) AS capture_rank
      FROM cq_ordered ordered
  ) WHERE capture_rank = 1
), cq_members AS MATERIALIZED (
  SELECT fa.*
    FROM cq_ordered fa
   WHERE CASE fa.current_rule
     WHEN 'global-pass-month'
       THEN fa.id IN (SELECT fetch_artifact_id FROM current_global_pass_snapshots)
     WHEN 'vpass-card-month'
       THEN EXISTS (SELECT 1 FROM current_vpass_snapshots snapshot WHERE snapshot.fetch_run_id = fa.fetch_run_id
                 AND snapshot.source_id = fa.source_id
                 AND snapshot.fetch_unit_key = fa.fetch_unit_key
                 AND snapshot.statement_month = CASE WHEN substr(fa.artifact_key, 1, 7) = 'months/'
                   THEN substr(fa.artifact_key, 8, 6)
                   ELSE substr(fa.artifact_key, 23, 6)
                 END)
     WHEN 'myjcb-statement-slot'
       THEN fa.id IN (SELECT fetch_artifact_id FROM current_myjcb_snapshots)
     WHEN 'smbc-request-key' THEN fa.id IN (SELECT fetch_artifact_id FROM current_smbc_direct_snapshots)
     WHEN 'moneyforward-account-month' THEN fa.id IN (SELECT fetch_artifact_id FROM current_moneyforward_snapshots)
     WHEN 'myjcb-connection' THEN fa.id IN (SELECT fetch_artifact_id FROM cq_current_myjcb_snapshots)
       AND EXISTS (
         SELECT 1 FROM parse_runs p
         WHERE p.fetch_artifact_id = fa.id AND p.parser_name = fa.parser_name
           AND ((
  NOT EXISTS (SELECT 1 FROM snapshot_policies policy
              WHERE policy.parser_name = p.parser_name)
  OR EXISTS (
    SELECT 1 FROM current_snapshots snapshot
    WHERE snapshot.source_id = fa.source_id
      AND snapshot.parser_name = p.parser_name
      AND (snapshot.required_version IS NULL OR p.parser_version = snapshot.required_version)
      AND snapshot.dataset = fa.dataset
      AND snapshot.fetch_unit_key IS fa.fetch_unit_key
      AND snapshot.fetch_run_id = fa.fetch_run_id
  )
) AND (
  NOT EXISTS (SELECT 1 FROM artifact_container_policies container_policy
              WHERE container_policy.parser_name = p.parser_name
                AND fa.source_id = container_policy.source_id
    AND fa.artifact_key = container_policy.artifact_key
    AND fa.fetch_unit_key = container_policy.fetch_unit_key
    AND (fa.dataset IS NULL OR fa.dataset = container_policy.dataset))
  OR EXISTS (SELECT 1 FROM current_artifact_containers snapshot
             WHERE snapshot.artifact_id = fa.id
               AND snapshot.parser_name = p.parser_name)
))
       )
     WHEN 'v-point-complete-run'
       THEN EXISTS (
         SELECT 1 FROM parse_runs p JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         WHERE p.fetch_artifact_id = fa.id AND p.parser_name = fa.parser_name
           AND EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success'))) AND f.id IN (SELECT fetch_run_id FROM current_vpoint_runs)
           AND (p.parser_name = 'v-point-history-page'
             OR ((
  NOT EXISTS (SELECT 1 FROM snapshot_policies policy
              WHERE policy.parser_name = p.parser_name)
  OR EXISTS (
    SELECT 1 FROM current_snapshots snapshot
    WHERE snapshot.source_id = fa.source_id
      AND snapshot.parser_name = p.parser_name
      AND (snapshot.required_version IS NULL OR p.parser_version = snapshot.required_version)
      AND snapshot.dataset = fa.dataset
      AND snapshot.fetch_unit_key IS fa.fetch_unit_key
      AND snapshot.fetch_run_id = fa.fetch_run_id
  )
) AND (
  NOT EXISTS (SELECT 1 FROM artifact_container_policies container_policy
              WHERE container_policy.parser_name = p.parser_name
                AND fa.source_id = container_policy.source_id
    AND fa.artifact_key = container_policy.artifact_key
    AND fa.fetch_unit_key = container_policy.fetch_unit_key
    AND (fa.dataset IS NULL OR fa.dataset = container_policy.dataset))
  OR EXISTS (SELECT 1 FROM current_artifact_containers snapshot
             WHERE snapshot.artifact_id = fa.id
               AND snapshot.parser_name = p.parser_name)
)))
       )
     ELSE EXISTS (
       SELECT 1 FROM parse_runs p
         JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
        WHERE p.fetch_artifact_id = fa.id AND p.parser_name = fa.parser_name
          AND EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
          AND ((
  NOT EXISTS (SELECT 1 FROM snapshot_policies policy
              WHERE policy.parser_name = p.parser_name)
  OR EXISTS (
    SELECT 1 FROM current_snapshots snapshot
    WHERE snapshot.source_id = fa.source_id
      AND snapshot.parser_name = p.parser_name
      AND (snapshot.required_version IS NULL OR p.parser_version = snapshot.required_version)
      AND snapshot.dataset = fa.dataset
      AND snapshot.fetch_unit_key IS fa.fetch_unit_key
      AND snapshot.fetch_run_id = fa.fetch_run_id
  )
) AND (
  NOT EXISTS (SELECT 1 FROM artifact_container_policies container_policy
              WHERE container_policy.parser_name = p.parser_name
                AND fa.source_id = container_policy.source_id
    AND fa.artifact_key = container_policy.artifact_key
    AND fa.fetch_unit_key = container_policy.fetch_unit_key
    AND (fa.dataset IS NULL OR fa.dataset = container_policy.dataset))
  OR EXISTS (SELECT 1 FROM current_artifact_containers snapshot
             WHERE snapshot.artifact_id = fa.id
               AND snapshot.parser_name = p.parser_name)
)))
   END
     AND fa.parser_name IS NOT NULL
), cq_current AS (
  SELECT * FROM (
    SELECT dataset, parser_name, fetch_unit_key, period_kind, period, period_state, current_rule, fetch_run_id, run_captured_at AS captured_at,
           ROW_NUMBER() OVER (
             PARTITION BY dataset, parser_name, fetch_unit_key, period_kind, period, period_state, current_rule
             ORDER BY run_captured_at DESC, run_newest_id DESC
           ) AS current_rank
      FROM (SELECT DISTINCT dataset, parser_name, fetch_unit_key, period_kind, period, period_state, current_rule, fetch_run_id, run_captured_at, run_newest_id
              FROM cq_members)
  ) WHERE current_rank = 1
), cq_states AS MATERIALIZED (
  SELECT n.id AS artifact_id, n.parser_name,
         CASE
           WHEN EXISTS (SELECT 1 FROM published_parse_runs pub
                         WHERE pub.fetch_artifact_id = n.id AND pub.parser_name = n.parser_name)
             THEN 'published'
           WHEN EXISTS (SELECT 1 FROM observation_parse_jobs job
                         WHERE job.fetch_artifact_id = n.id AND job.parser_name = n.parser_name
                           AND job.status IN ('pending', 'running'))
             THEN 'pending'
           WHEN EXISTS (SELECT 1 FROM observation_parse_jobs job
                         WHERE job.fetch_artifact_id = n.id AND job.parser_name = n.parser_name
                           AND job.status = 'failed'
                           AND coalesce(job.last_error_code, '') <> 'parser_version_retired')
               OR EXISTS (SELECT 1 FROM parse_runs failed
                           WHERE failed.fetch_artifact_id = n.id
                             AND failed.parser_name = n.parser_name AND failed.status = 'error')
             THEN 'failed'
           ELSE 'unpublished'
         END AS state,
         coalesce(
           (SELECT job.last_error_code FROM observation_parse_jobs job
             WHERE job.fetch_artifact_id = n.id AND job.parser_name = n.parser_name
               AND job.status = 'failed'
               AND coalesce(job.last_error_code, '') <> 'parser_version_retired'
             ORDER BY job.created_at_ms DESC, job.parser_version DESC LIMIT 1),
           (SELECT failed.error FROM parse_runs failed
             WHERE failed.fetch_artifact_id = n.id
               AND failed.parser_name = n.parser_name AND failed.status = 'error'
             ORDER BY failed.id DESC LIMIT 1)
         ) AS failure_code
    FROM cq_newest n
   WHERE n.parser_name IS NOT NULL
), cq_latest_units AS MATERIALIZED (
  -- The newest visible run of each producer of the source, and of each unit
  -- it declared: a collector that runs once per card or connection is
  -- compared with its own newest run of that unit, and a unit that failed
  -- with no artifact still counts as captured by that run.
  SELECT latest.tool, unit.unit_key, MAX(latest.id) AS fetch_run_id
    FROM observation_fetch_runs latest
    LEFT JOIN fetch_units unit ON unit.fetch_run_id = latest.id
   WHERE latest.source_id = ?1
   GROUP BY latest.tool, unit.unit_key
), cq_latest_runs AS MATERIALIZED (
  SELECT tool, MAX(fetch_run_id) AS fetch_run_id FROM cq_latest_units GROUP BY tool
), cq_cells AS MATERIALIZED (
  SELECT n.dataset, n.parser_name, n.fetch_unit_key, n.period_kind, n.period, n.period_state, n.current_rule, n.fetch_run_id AS newest_run_id,
         MAX(n.run_captured_at) AS newest_captured_at,
         MAX(CASE WHEN f.status = 'success' AND f.failure_count = 0 THEN 1 ELSE 0 END) AS newest_run_succeeded,
         MAX(CASE WHEN n.fetch_unit_key IS NULL THEN producer.fetch_run_id
                  ELSE producer_unit.fetch_run_id END) AS latest_producer_run_id,
         COUNT(*) AS artifacts,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM observation_raw_objects o WHERE o.sha256 = n.sha256) THEN 1 ELSE 0 END) AS raw_stored,
         SUM(CASE WHEN n.parser_name IS NULL
                   AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = n.source_id
          AND unit_policy.dataset = n.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = n.id
          AND artifact_unit.unit_status = 'success'))) THEN 1 ELSE 0 END) AS not_queued,
         SUM(CASE WHEN n.parser_name IS NULL
                   AND NOT (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = n.source_id
          AND unit_policy.dataset = n.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = n.id
          AND artifact_unit.unit_status = 'success'))) THEN 1 ELSE 0 END) AS not_eligible,
         SUM(CASE WHEN k.state = 'published' THEN 1 ELSE 0 END) AS published,
         SUM(CASE WHEN k.state = 'published' AND NOT EXISTS (
           SELECT 1 FROM published_parse_runs pub JOIN parse_coverage_claims claim ON claim.parse_run_id = pub.parse_run_id
           WHERE pub.fetch_artifact_id = n.id AND pub.parser_name = n.parser_name
         ) THEN 1 ELSE 0 END) AS unreported_coverage,
         SUM(CASE WHEN k.state = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN k.state = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN k.state = 'unpublished' THEN 1 ELSE 0 END) AS unpublished,
         json_group_array(DISTINCT CASE WHEN k.state = 'failed' THEN k.failure_code END) AS failure_codes_json,
         MAX(CASE WHEN n.fetch_unit_key IS NOT NULL AND coalesce((
           SELECT report.normalized_outcome FROM fetch_units unit
           LEFT JOIN fetch_unit_reports report
             ON report.fetch_unit_id = unit.id AND report.report_kind = 'terminal'
           WHERE unit.fetch_run_id = n.fetch_run_id AND unit.unit_key = n.fetch_unit_key
         ), 'unknown') = 'unknown' THEN 1 ELSE 0 END) AS unit_outcome_unknown,
         MAX(CASE WHEN (SELECT unit.unit_status FROM observation_fetch_artifact_units unit
                         WHERE unit.fetch_artifact_id = n.id) = 'failed' THEN 1 ELSE 0 END) AS unit_failed,
         MAX((SELECT unit.unit_failure_code FROM observation_fetch_artifact_units unit
               WHERE unit.fetch_artifact_id = n.id)) AS unit_failure_code
    FROM cq_newest n
    JOIN observation_fetch_runs f ON f.id = n.fetch_run_id
    LEFT JOIN cq_latest_runs producer ON producer.tool = f.tool
    LEFT JOIN cq_latest_units producer_unit
      ON producer_unit.tool = f.tool AND producer_unit.unit_key = n.fetch_unit_key
    LEFT JOIN cq_states k ON k.artifact_id = n.id AND k.parser_name = n.parser_name
   GROUP BY n.dataset, n.parser_name, n.fetch_unit_key, n.period_kind, n.period, n.period_state, n.current_rule, n.fetch_run_id
), cq_claims AS (
  SELECT n.dataset, n.parser_name, n.fetch_unit_key, n.period_kind, n.period, n.period_state, n.current_rule, COUNT(*) AS incomplete_coverage,
         json_group_array(DISTINCT claim.failure_cause) AS coverage_causes_json
    FROM cq_newest n
    CROSS JOIN published_parse_runs pub
      ON pub.fetch_artifact_id = n.id AND pub.parser_name = n.parser_name
    CROSS JOIN parse_coverage_claims claim ON claim.parse_run_id = pub.parse_run_id
   WHERE claim.completeness <> 'complete' OR claim.membership_complete <> 1
      OR claim.failure_cause IS NOT NULL
   GROUP BY n.dataset, n.parser_name, n.fetch_unit_key, n.period_kind, n.period, n.period_state, n.current_rule
), cq_publication AS (
  SELECT n.dataset, n.parser_name, n.fetch_unit_key, n.period_kind, n.period, n.period_state, n.current_rule,
         SUM((SELECT COUNT(*) FROM transaction_observations o WHERE o.parse_run_id = pub.parse_run_id)
           + (SELECT COUNT(*) FROM balance_observations o WHERE o.parse_run_id = pub.parse_run_id)
           + (SELECT COUNT(*) FROM position_observations o WHERE o.parse_run_id = pub.parse_run_id)
           + (SELECT COUNT(*) FROM valuation_observations o WHERE o.parse_run_id = pub.parse_run_id)) AS observations,
         SUM(CASE WHEN NOT EXISTS (
           SELECT 1 FROM eligible_identity_runs r JOIN identity_run_seals seal ON seal.identity_run_id = r.id
            WHERE r.parse_run_id = pub.parse_run_id
         ) THEN 1 ELSE 0 END) AS identity_missing,
         SUM((SELECT COUNT(*) FROM identity_observations o
           JOIN eligible_identity_runs r ON r.id = o.identity_run_id
           JOIN identity_run_seals seal ON seal.identity_run_id = r.id
           JOIN current_account_mappings mapping ON mapping.source_account_id = o.source_account_id
           WHERE r.parse_run_id = pub.parse_run_id AND mapping.status = 'unresolved'
             AND r.policy_version = (SELECT MAX(newest.policy_version) FROM eligible_identity_runs newest
               JOIN identity_run_seals newest_seal ON newest_seal.identity_run_id = newest.id
               WHERE newest.parse_run_id = pub.parse_run_id))) AS unresolved_identities
    FROM cq_newest n
    JOIN published_parse_runs pub ON pub.fetch_artifact_id = n.id AND pub.parser_name = n.parser_name
   GROUP BY n.dataset, n.parser_name, n.fetch_unit_key, n.period_kind, n.period, n.period_state, n.current_rule
), cq_empty_units AS (
  SELECT u.unit_key, f.id AS fetch_run_id, coalesce(f.completed_at, f.started_at) AS captured_at,
         CASE WHEN f.status = 'success' AND f.failure_count = 0 THEN 1 ELSE 0 END AS succeeded,
         report.normalized_outcome AS outcome, report.safe_failure_code AS failure_code,
         ROW_NUMBER() OVER (PARTITION BY u.unit_key
           ORDER BY coalesce(f.completed_at, f.started_at) DESC, f.id DESC) AS choice
    FROM cq_latest_units unit_latest
    CROSS JOIN observation_fetch_runs f ON f.id = unit_latest.fetch_run_id
    CROSS JOIN fetch_units u ON u.fetch_run_id = f.id AND u.unit_key = unit_latest.unit_key
    LEFT JOIN fetch_unit_reports report ON report.fetch_unit_id = u.id AND report.report_kind = 'terminal'
   WHERE NOT EXISTS (SELECT 1 FROM observation_fetch_artifacts a
                      WHERE a.fetch_run_id = f.id AND a.fetch_unit_key = u.unit_key)
), cq_result AS (
SELECT c.dataset, c.parser_name, c.fetch_unit_key, c.period_kind, c.period, c.period_state,
       c.current_rule, c.newest_run_id, c.newest_captured_at, c.newest_run_succeeded,
       c.latest_producer_run_id, c.artifacts, c.raw_stored, c.not_queued, c.not_eligible,
       c.published, c.pending, c.failed, c.unpublished, c.failure_codes_json,
       c.unit_failed, c.unit_failure_code,
       claims.incomplete_coverage, claims.coverage_causes_json, c.unreported_coverage,
       cur.fetch_run_id AS current_run_id, cur.captured_at AS current_captured_at,
       coalesce(publication.observations, 0) AS observations,
       coalesce(publication.unresolved_identities, 0) AS unresolved_identities,
       coalesce(publication.identity_missing, 0) AS identity_missing,
       c.unit_outcome_unknown
  FROM cq_cells c
  LEFT JOIN cq_publication publication ON publication.dataset IS c.dataset AND publication.parser_name IS c.parser_name AND publication.fetch_unit_key IS c.fetch_unit_key AND publication.period_kind IS c.period_kind AND publication.period IS c.period AND publication.period_state IS c.period_state AND publication.current_rule IS c.current_rule
  LEFT JOIN cq_claims claims ON claims.dataset IS c.dataset AND claims.parser_name IS c.parser_name AND claims.fetch_unit_key IS c.fetch_unit_key AND claims.period_kind IS c.period_kind AND claims.period IS c.period AND claims.period_state IS c.period_state AND claims.current_rule IS c.current_rule
  LEFT JOIN cq_current cur ON cur.dataset IS c.dataset AND cur.parser_name IS c.parser_name AND cur.fetch_unit_key IS c.fetch_unit_key AND cur.period_kind IS c.period_kind AND cur.period IS c.period AND cur.period_state IS c.period_state AND cur.current_rule IS c.current_rule
 WHERE c.parser_name IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM cq_cells parsed
                    WHERE parsed.parser_name IS NOT NULL AND parsed.dataset IS c.dataset AND parsed.fetch_unit_key IS c.fetch_unit_key AND parsed.period_kind IS c.period_kind AND parsed.period IS c.period AND parsed.period_state IS c.period_state
                      AND parsed.newest_captured_at > c.newest_captured_at)
 UNION ALL
 SELECT NULL, NULL, unit_key, 'latest', NULL, NULL, 'published-eligible',
        fetch_run_id, captured_at, succeeded, fetch_run_id,
        0, 0, 0, 0, 0, 0, 0, 0, '[]',
        CASE WHEN outcome IS NOT NULL AND (outcome <> 'success' OR failure_code IS NOT NULL)
             THEN 1 ELSE 0 END,
        failure_code, 0, '[]', 0, NULL, NULL, 0, 0, 0,
        CASE WHEN outcome IS NULL OR outcome = 'unknown' THEN 1 ELSE 0 END
   FROM cq_empty_units WHERE choice = 1
)
SELECT * FROM cq_result
 ORDER BY dataset, fetch_unit_key, period_kind, period DESC, period_state,
          parser_name, current_rule
 LIMIT 501 OFFSET ?2`;
