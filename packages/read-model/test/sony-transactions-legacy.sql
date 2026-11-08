SELECT * FROM (WITH ranked_myjcb_snapshots AS (
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
       ), ranked_smbc_direct_snapshots AS (
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
       ), eligible_global_pass_snapshots AS (
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
       ), ranked_moneyforward_snapshots AS (
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
       ), eligible_vpoint_runs AS (
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
       ), eligible_vpass_snapshots AS (
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
       )
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
                           'st-george-transactions',
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
         FROM transaction_observations t
    JOIN parse_runs p ON p.id = t.parse_run_id
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
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
                 AND snapshot.statement_month = CASE WHEN substr(fa.artifact_key, 1, 7) = 'months/'
                   THEN substr(fa.artifact_key, 8, 6)
                   ELSE substr(fa.artifact_key, 23, 6)
                 END
             )
           )
           AND (
             p.parser_name <> 'moneyforward-monthly-transactions'
             OR fa.id IN (SELECT fetch_artifact_id FROM current_moneyforward_snapshots)
           )
       )
       WHERE rank_in_identity = 1)
      WHERE 1
      ORDER BY COALESCE(as_of, '') DESC, id DESC LIMIT 501 OFFSET ?
