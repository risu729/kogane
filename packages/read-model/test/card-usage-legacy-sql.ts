// The current card usage reads exactly as #233 and #236 shipped them, before
// they were re-planned for D1's unanalyzed planner, frozen as text so the
// scaled-store tests can prove the new plans return the same rows and see the
// old plans fail the plan checks. `LEGACY_CURRENT_CARD_USAGE_SQL` is the
// expanded `CURRENT_CARD_USAGE_SQL` of that commit; the two wrappers are its
// `STALE_CARD_PURCHASE_KEYS_SQL` and `UNRECOGNIZED_CARD_USAGE_COUNT_SQL`, verbatim.
// Never edit these by hand, and never import them outside tests.
export const LEGACY_CURRENT_CARD_USAGE_SQL = `WITH ranked_myjcb_snapshots AS (
         SELECT p.fetch_artifact_id,
                ROW_NUMBER() OVER (
                  PARTITION BY
                    fa.source_id,
                    substr(fa.artifact_key, 1, instr(fa.artifact_key, '/') - 1),
                    fa.statement_state,
                    CASE WHEN fa.statement_state = 'unconfirmed' THEN '' ELSE fa.period END
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
           AND p.parser_name = 'myjcb-credit-ledger'
           AND fa.dataset = 'credit-ledger'
       ), current_myjcb_snapshots AS (
         SELECT fetch_artifact_id
         FROM ranked_myjcb_snapshots
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
       ), current_rows AS MATERIALIZED (
         SELECT t.id AS observation_id, t.parse_run_id, fa.id AS fetch_artifact_id,
                fa.fetch_run_id, t.raw_locator,
                fa.source_id, fr.producer_id, ses.external_id_namespace,
                t.source_account, t.external_id,
                (f.status = 'success' AND f.failure_count = 0) AS run_succeeded,
                t.status AS provider_status,
                CASE WHEN fa.source_id = 'vpass' AND p.parser_name = 'vpass-statement-page' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$._kogane.statementFamily') = 'text'
              AND length(json_extract(t.extra_json, '$._kogane.statementFamily')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$._kogane.statementFamily') END
            WHEN fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$._kogane.statementState') = 'text'
              AND length(json_extract(t.extra_json, '$._kogane.statementState')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$._kogane.statementState') END END AS provider_family,
                CASE
              WHEN fa.source_id = 'vpass' AND p.parser_name = 'vpass-statement-page' AND t.status = 'unconfirmed' THEN 'pending'
              WHEN fa.source_id = 'vpass' AND p.parser_name = 'vpass-statement-page' AND t.status = 'posted' THEN 'posted'
              WHEN fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger' AND t.status = 'unconfirmed' THEN 'pending'
              WHEN fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger' AND t.status = 'confirmed' THEN 'posted'
            END AS display_state,
                t.as_of,
                CASE WHEN fa.source_id = 'vpass' AND p.parser_name = 'vpass-statement-page' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$._kogane.statementMonth') = 'text'
              AND length(json_extract(t.extra_json, '$._kogane.statementMonth')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$._kogane.statementMonth') END
            WHEN fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$._kogane.period') = 'text'
              AND length(json_extract(t.extra_json, '$._kogane.period')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$._kogane.period') END END AS statement_period,
                CASE WHEN snapshot.fetch_run_id IS NOT NULL THEN fa.fetch_unit_key
                  ELSE substr(fa.artifact_key, 1, instr(fa.artifact_key, '/') - 1)
                END AS snapshot_unit,
                coalesce(snapshot.fetched_at, fa.fetched_at) AS snapshot_fetched_at,
                CASE WHEN snapshot.fetch_run_id IS NOT NULL THEN json_array(snapshot.statement_month)
                  ELSE json_array(
                    fa.statement_state,
                    CASE WHEN fa.statement_state = 'unconfirmed' THEN '' ELSE fa.period END
                  )
                END AS snapshot_slot,
                dv.status AS value_status, dv.coefficient, dv.scale, dv.basis AS value_basis,
                t.currency AS unit_ref,
                CASE WHEN fa.source_id = 'vpass' AND p.parser_name = 'vpass-statement-page' THEN
              CASE CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$._kogane.statementFamily') = 'text'
              AND length(json_extract(t.extra_json, '$._kogane.statementFamily')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$._kogane.statementFamily') END
                WHEN 'web' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$.data[6]') = 'text'
              AND length(json_extract(t.extra_json, '$.data[6]')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$.data[6]') END
                WHEN 'customized' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$.bunkatsuYaku') = 'text'
              AND length(json_extract(t.extra_json, '$.bunkatsuYaku')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$.bunkatsuYaku') END
              END
            WHEN fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger' AND json_valid(t.extra_json) THEN
              CASE json_extract(t.extra_json, '$._kogane.paymentTypeCellIndex')
                WHEN 2 THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$.summaryCells[2]') = 'text'
              AND length(json_extract(t.extra_json, '$.summaryCells[2]')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$.summaryCells[2]') END
                WHEN 3 THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$.summaryCells[3]') = 'text'
              AND length(json_extract(t.extra_json, '$.summaryCells[3]')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$.summaryCells[3]') END
              END
            END AS payment_type,
                CASE WHEN fa.source_id = 'vpass' AND p.parser_name = 'vpass-statement-page' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$._kogane.providerSaleCode') = 'text'
              AND length(json_extract(t.extra_json, '$._kogane.providerSaleCode')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$._kogane.providerSaleCode') END END
                  AS provider_sale_code,
                CASE WHEN fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$._kogane.usageAmountText') = 'text'
              AND length(json_extract(t.extra_json, '$._kogane.usageAmountText')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$._kogane.usageAmountText') END END
                  AS usage_amount_text,
                CASE WHEN fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$._kogane.paymentAmountText') = 'text'
              AND length(json_extract(t.extra_json, '$._kogane.paymentAmountText')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$._kogane.paymentAmountText') END END
                  AS payment_amount_text,
                CASE WHEN fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger' THEN CASE WHEN json_valid(t.extra_json) AND json_type(t.extra_json, '$.expanded."今回回数"') = 'text'
              AND length(json_extract(t.extra_json, '$.expanded."今回回数"')) BETWEEN 1 AND 256
            THEN json_extract(t.extra_json, '$.expanded."今回回数"') END END
                  AS installment_count_text
         FROM transaction_observations t
    JOIN parse_runs p ON p.id = t.parse_run_id
    JOIN observation_fetch_artifacts fa ON fa.id = p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id = fa.fetch_run_id
         JOIN financial_fetch_runs fr ON fr.id = f.id
         JOIN acquisition_sessions ses ON ses.id = fr.acquisition_session_id
         LEFT JOIN current_vpass_snapshots snapshot
           ON p.parser_name = 'vpass-statement-page'
          AND snapshot.fetch_run_id = fa.fetch_run_id
                 AND snapshot.source_id = fa.source_id
                 AND snapshot.fetch_unit_key = fa.fetch_unit_key
                 AND snapshot.statement_month = CASE WHEN substr(fa.artifact_key, 1, 7) = 'months/'
                   THEN substr(fa.artifact_key, 8, 6)
                   ELSE substr(fa.artifact_key, 23, 6)
                 END
         LEFT JOIN observation_decimal_values dv
           ON dv.kind = 'transaction' AND dv.observation_id = t.id
          AND dv.policy_version = 'decimal-v1'
         WHERE EXISTS (SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id = p.id) AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
           AND (
             (fa.source_id = 'vpass' AND p.parser_name = 'vpass-statement-page' AND snapshot.fetch_run_id IS NOT NULL)
             OR (fa.source_id = 'myjcb' AND p.parser_name = 'myjcb-credit-ledger' AND fa.id IN (SELECT fetch_artifact_id FROM current_myjcb_snapshots))
           )
       ), parse_identity AS MATERIALIZED (
         SELECT parses.parse_run_id,
                (SELECT run.id
                   FROM eligible_identity_runs run
                   JOIN identity_run_seals seal ON seal.identity_run_id = run.id
                  WHERE run.parse_run_id = parses.parse_run_id
                  ORDER BY run.policy_version DESC
                  LIMIT 1) AS identity_run_id
         FROM (SELECT DISTINCT parse_run_id FROM current_rows WHERE run_succeeded) parses
       ), card_usage AS (
         SELECT current_rows.*,
                CASE WHEN current_rows.external_id IS NOT NULL THEN json_array(
                  current_rows.source_id, current_rows.producer_id,
                  current_rows.external_id_namespace, current_rows.source_account,
                  current_rows.external_id
                ) END AS recognition_key,
                io.source_account_id, mapping.account_id, mapping.status AS account_status,
                -- Scalar lookups keep the view keyed; as a LEFT JOIN operand it is materialized whole.
                (SELECT ctx.policy_version FROM identity_run_contexts ctx
                  WHERE ctx.identity_run_id = io.identity_run_id) AS policy_version,
                (SELECT ctx.policy_family FROM identity_run_contexts ctx
                  WHERE ctx.identity_run_id = io.identity_run_id) AS policy_family
         FROM current_rows
         LEFT JOIN parse_identity ON parse_identity.parse_run_id = current_rows.parse_run_id
         LEFT JOIN identity_observations io
           ON io.identity_run_id = parse_identity.identity_run_id
          AND io.kind = 'transaction' AND io.observation_id = current_rows.observation_id
         LEFT JOIN current_account_mappings mapping
           ON mapping.source_account_id = io.source_account_id
       ), representations AS (
         SELECT card_usage.*,
                FIRST_VALUE(fetch_run_id) OVER (
                  PARTITION BY source_id, snapshot_slot,
                    CASE WHEN account_id IS NULL THEN json_array('unit', snapshot_unit)
                      ELSE json_array('account', account_id)
                    END
                  ORDER BY snapshot_fetched_at DESC, fetch_run_id DESC
                ) AS newest_run
         FROM card_usage
       ), keyed AS (
         SELECT representations.*,
                ROW_NUMBER() OVER (
                  PARTITION BY coalesce(recognition_key, json_array('observation-row', observation_id))
                  ORDER BY snapshot_fetched_at DESC, observation_id DESC
                ) AS key_rank
         FROM representations
         WHERE fetch_run_id = newest_run
       )
       SELECT observation_id, parse_run_id, fetch_artifact_id, fetch_run_id, raw_locator, source_id, producer_id, external_id_namespace, source_account, external_id, recognition_key, source_account_id, account_id, account_status, policy_version, policy_family, provider_status, provider_family, display_state, as_of, statement_period, snapshot_unit, snapshot_fetched_at, value_status, coefficient, scale, value_basis, unit_ref, payment_type, provider_sale_code, usage_amount_text, payment_amount_text, installment_count_text
       FROM keyed
       WHERE key_rank = 1 AND observation_id > ?1
       ORDER BY observation_id
       LIMIT ?2`;

const LEGACY_ALL_CURRENT_USAGE = `(${LEGACY_CURRENT_CARD_USAGE_SQL})`;

export const LEGACY_STALE_CARD_PURCHASE_KEYS_SQL = `WITH current_keys AS MATERIALIZED (
         SELECT recognition_key FROM ${LEGACY_ALL_CURRENT_USAGE}
         WHERE recognition_key IS NOT NULL
       )
       SELECT k.event_id, k.revision, k.recognition_key, k.role, k.observation_id,
              k.parse_run_id, c.kind, c.state,
              (SELECT count(*) FROM card_purchase_recognition_keys all_keys
                WHERE all_keys.event_id = k.event_id AND all_keys.revision = k.revision) AS key_count
       FROM current_card_purchase_keys k
       JOIN current_card_purchase_recognitions c
         ON c.event_id = k.event_id AND c.revision = k.revision
       WHERE c.state IN ('authorized', 'captured')
         AND NOT EXISTS (SELECT 1 FROM card_purchase_recognition_keys held
                          WHERE held.event_id = k.event_id AND held.revision = k.revision
                            AND held.recognition_key IN (SELECT recognition_key FROM current_keys))
       ORDER BY k.event_id, k.recognition_key
       LIMIT ?3`;

export const LEGACY_UNRECOGNIZED_CARD_USAGE_COUNT_SQL = `SELECT count(*) AS unrecognized
       FROM ${LEGACY_ALL_CURRENT_USAGE} usage
       WHERE usage.recognition_key IS NULL
          OR NOT EXISTS (SELECT 1 FROM current_card_purchase_keys k
                          WHERE k.recognition_key = usage.recognition_key)`;
