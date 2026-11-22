// The candidate read exactly as e8f455ed927f5cc3be512fbfd9799ea414825853 shipped it
// (src/reward-claims-job.ts), before the J-POINT history account filter
// checked the connection's characters and the acquisition date's digits,
// frozen as text so the tests can prove the narrowed read drops only rows the
// promotion rule refuses and keeps its plan. Its scope bindings follow ?1
// (release) and ?2 (limit). Verbatim; never edit it by hand, never derive it
// from the current mapping or query, and never import it outside tests.
export const FROZEN_JPOINT_ACCOUNT_CANDIDATE_QUERY = Object.freeze({
  sql: `WITH
jpoint_totals AS (
 SELECT b.id AS total_fact_id,b.source_account AS holding_account,b.amount_text AS reported_total,
   fa.fetch_run_id,fa.fetched_at,
   row_number() OVER(PARTITION BY b.source_account ORDER BY fa.fetched_at DESC,fa.id DESC,p.id DESC) AS total_rank
 FROM balance_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts fa ON fa.id=p.fetch_artifact_id
 JOIN observation_fetch_runs fr ON fr.id=fa.fetch_run_id
 WHERE fa.source_id='myjcb' AND fa.dataset='jpoint-balance'
   AND p.parser_name='myjcb-jpoint-balance' AND b.metric='displayed_jpoint_total'
   AND b.instrument='J_POINT' AND (fr.status = 'success' AND fr.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
), jpoint_history_distinct AS (
 SELECT DISTINCT p.id AS parse_run_id,fa.id AS artifact_id,fa.fetch_run_id,fa.fetched_at,
   json_extract(b.extra_json,'$._kogane.jpointHoldingSourceAccount') AS holding_account,
   json_extract(b.extra_json,'$._kogane.reportedHistoryTotal') AS reported_total,
   json_extract(b.extra_json,'$._kogane.historyBucketCount') AS bucket_count,
   min(b.id) OVER(PARTITION BY p.id) AS history_fact_id
 FROM balance_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts fa ON fa.id=p.fetch_artifact_id
 JOIN observation_fetch_runs fr ON fr.id=fa.fetch_run_id
 WHERE fa.source_id='myjcb' AND fa.dataset='jpoint-history'
   AND p.parser_name='myjcb-jpoint-history' AND b.metric='jpoint_acquisition_remaining'
   AND b.instrument='J_POINT' AND (fr.status = 'success' AND fr.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = fa.source_id
          AND unit_policy.dataset = fa.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = fa.id
          AND artifact_unit.unit_status = 'success')))
   AND EXISTS (SELECT 1 FROM parse_coverage_claims hc WHERE hc.parse_run_id=p.id
     AND hc.mode='complete-container' AND hc.completeness='complete'
     AND hc.membership_complete=1 AND hc.failure_cause IS NULL)
), jpoint_histories AS (
 SELECT h.*,row_number() OVER(PARTITION BY h.holding_account
   ORDER BY h.fetched_at DESC,h.artifact_id DESC,h.parse_run_id DESC) AS history_rank
 FROM jpoint_history_distinct h
)
 SELECT b.id,b.parse_run_id,a.source_id,p.parser_name,b.source_account,b.metric,
 b.instrument,b.observed_at,b.as_of,b.extra_json,
 d.status AS decimal_status,d.coefficient,d.scale
 FROM balance_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 LEFT JOIN observation_decimal_values d
   ON d.kind='balance' AND d.observation_id=b.id AND d.policy_version='decimal-v1'
 WHERE ((f.status='success' AND f.failure_count=0) OR (a.source_id='myjcb' AND p.parser_name IN ('myjcb-jpoint-balance','myjcb-jpoint-history') AND a.dataset IN ('jpoint-balance','jpoint-history') AND (f.status = 'success' AND f.failure_count = 0 OR (EXISTS (SELECT 1 FROM dataset_snapshot_policies unit_policy
        WHERE unit_policy.source_id = a.source_id
          AND unit_policy.dataset = a.dataset
          AND unit_policy.unit_scope = 'unit')
      AND EXISTS (SELECT 1 FROM observation_fetch_artifact_units artifact_unit
        WHERE artifact_unit.fetch_artifact_id = a.id
          AND artifact_unit.unit_status = 'success'))))) AND ((a.source_id=?3 AND p.parser_name=?4 AND b.metric=?5 AND substr(b.source_account,1,length(?6))=?6 AND b.instrument=?7 AND b.source_account GLOB ?8 AND EXISTS (SELECT 1 FROM parse_coverage_claims hc WHERE hc.parse_run_id=p.id
        AND hc.completeness='complete' AND hc.membership_complete=1 AND hc.failure_cause IS NULL) AND EXISTS (SELECT 1 FROM jpoint_histories h JOIN jpoint_totals t ON h.history_rank=1 AND t.total_rank=1
 AND h.holding_account=t.holding_account AND h.fetch_run_id=t.fetch_run_id
 AND h.reported_total=t.reported_total
        WHERE h.parse_run_id=p.id)) OR (a.source_id=?9 AND p.parser_name=?10 AND b.metric=?11 AND substr(b.source_account,1,length(?12))=?12 AND b.instrument=?13 AND b.source_account GLOB ?14 AND length(b.source_account) BETWEEN 21 AND 84 AND substr(b.source_account,7,length(b.source_account)-20) NOT GLOB '*[^a-z0-9-]*' AND substr(b.source_account,7,1) GLOB '[a-z0-9]') OR (a.source_id=?15 AND p.parser_name=?16 AND b.metric=?17 AND substr(b.source_account,1,length(?18))=?18) OR (a.source_id=?19 AND p.parser_name=?20 AND b.metric=?21) OR (a.source_id=?22 AND p.parser_name=?23 AND b.metric=?24) OR (a.source_id=?25 AND p.parser_name=?26 AND b.metric=?27 AND b.instrument=?28) OR (a.source_id=?29 AND p.parser_name=?30 AND b.metric=?31 AND b.source_account=?32 AND b.instrument=?33))
 AND NOT EXISTS (
   SELECT 1 FROM reward_bucket_claims_v2 claimed
   WHERE claimed.source_fact_kind='balance' AND claimed.source_fact_id=b.id
     AND claimed.promotion_release=?1
 )
 ORDER BY b.id LIMIT ?2`,
  scopeBindings: Object.freeze([
    "myjcb",
    "myjcb-jpoint-history",
    "jpoint_acquisition_remaining",
    "myjcb:",
    "J_POINT",
    "myjcb:*:j-point:acquired:????-??-??",
    "myjcb",
    "myjcb-jpoint-balance",
    "displayed_jpoint_total",
    "myjcb:",
    "J_POINT",
    "myjcb:*:j-point:total",
    "v-point",
    "v-point-balance-info",
    "available_point_bucket",
    "v-point:store-limited:",
    "v-point",
    "v-point-balance-info",
    "available_point_bucket",
    "v-point",
    "v-point-smfg-point",
    "displayed_point_balance",
    "v-point-pay",
    "v-point-pay-notification-event",
    "prepaid_balance_after_event",
    "JPY",
    "mobile-suica",
    "mobile-suica-sf-history",
    "sf_balance_after_transaction",
    "mobile-suica:sf",
    "JPY",
  ] as const),
});
