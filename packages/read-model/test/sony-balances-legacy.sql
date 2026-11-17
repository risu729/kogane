SELECT * FROM (WITH snapshot_policies(parser_name, dataset, required_version, policy_id, replaces_previous_on_complete_empty, unit_scope) AS (
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
), ranked_myjcb_snapshots AS (
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
       ), current_myjcb_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_myjcb_snapshots
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
       )
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
         FROM balance_observations b
    JOIN parse_runs p ON p.id = b.parse_run_id
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
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
))
           AND (
             p.parser_name <> 'myjcb-credit-past-month-balances'
             OR fa.id IN (SELECT fetch_artifact_id FROM current_myjcb_snapshots)
           )
           AND (
             p.parser_name NOT IN ('v-point-balance-info', 'v-point-smfg-point')
             OR f.id IN (SELECT fetch_run_id FROM current_vpoint_runs)
           )
       )
       WHERE rank_in_group = 1)
      WHERE 1
      ORDER BY source_id, source_account, metric, instrument, id LIMIT 501 OFFSET ?
