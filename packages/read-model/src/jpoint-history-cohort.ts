import { unitScopedEligibilitySql } from "../../parsers/src/snapshot-query.ts";

/** Exact same-capture cohorts. A later total never borrows older acquisition
 * membership. Decimal comparison uses canonical integer text, never SQL SUM. */
export const JPOINT_PUBLISHED_COHORT_CTES = `
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
   AND b.instrument='J_POINT' AND ${unitScopedEligibilitySql("fr", "fa")}
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
   AND b.instrument='J_POINT' AND ${unitScopedEligibilitySql("fr", "fa")}
   AND EXISTS (SELECT 1 FROM parse_coverage_claims hc WHERE hc.parse_run_id=p.id
     AND hc.mode='complete-container' AND hc.completeness='complete'
     AND hc.membership_complete=1 AND hc.failure_cause IS NULL)
), jpoint_histories AS (
 SELECT h.*,row_number() OVER(PARTITION BY h.holding_account
   ORDER BY h.fetched_at DESC,h.artifact_id DESC,h.parse_run_id DESC) AS history_rank
 FROM jpoint_history_distinct h
)`;
export const JPOINT_COHORT_MATCH = `h.history_rank=1 AND t.total_rank=1
 AND h.holding_account=t.holding_account AND h.fetch_run_id=t.fetch_run_id
 AND h.reported_total=t.reported_total`;
/** ?1 is the existing promotion-release parameter of the reward reader. */
export const JPOINT_CURRENT_COHORT_CTES = `${JPOINT_PUBLISHED_COHORT_CTES},
jpoint_current_history AS (
 SELECT h.* FROM jpoint_histories h JOIN jpoint_totals t ON ${JPOINT_COHORT_MATCH}
 WHERE h.bucket_count BETWEEN 1 AND 500
 AND (SELECT COUNT(*) FROM reward_bucket_claims_v2 promoted
   JOIN balance_observations fact ON fact.id=promoted.source_fact_id AND promoted.source_fact_kind='balance'
   WHERE promoted.parse_run_id=h.parse_run_id AND promoted.promotion_release=?1
     AND fact.metric='jpoint_acquisition_remaining')=h.bucket_count
)`;
export const JPOINT_REWARD_MEMBERSHIP = `(c.program_id<>'program:j-point' OR (
 c.source_fact_kind='balance' AND (
 EXISTS (SELECT 1 FROM jpoint_current_history h
   WHERE h.parse_run_id=c.parse_run_id AND c.holding_ref='program:j-point:'||h.holding_account)
 OR EXISTS (SELECT 1 FROM jpoint_totals t WHERE t.total_rank=1 AND t.total_fact_id=c.source_fact_id
   AND NOT EXISTS (SELECT 1 FROM jpoint_current_history h WHERE h.holding_account=t.holding_account))
 )))`;
export const JPOINT_HISTORY_COLUMNS = `
 CASE WHEN r.program_id<>'program:j-point' THEN NULL
   WHEN EXISTS (SELECT 1 FROM jpoint_current_history h WHERE 'program:j-point:'||h.holding_account=r.holding_ref) THEN 'current'
   WHEN EXISTS (SELECT 1 FROM jpoint_histories h WHERE h.history_rank=1 AND 'program:j-point:'||h.holding_account=r.holding_ref) THEN 'stale'
   ELSE 'unavailable' END AS jpoint_history_state,
 (SELECT h.fetched_at FROM jpoint_histories h WHERE h.history_rank=1 AND 'program:j-point:'||h.holding_account=r.holding_ref) AS jpoint_history_observed_at,
 (SELECT h.history_fact_id FROM jpoint_histories h WHERE h.history_rank=1 AND 'program:j-point:'||h.holding_account=r.holding_ref) AS jpoint_history_fact_id`;
