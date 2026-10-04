// Bounded, aggregate-only production diagnostics for ADR 0034. No writes,
// amounts, account identifiers, labels or financial dates leave this query.
// This is prerequisite readiness, not permission to adopt a settlement.
import { cardSettlementReadinessCtes } from "../../../packages/read-model/src/card-settlement-readiness.ts";

export const CARD_SETTLEMENT_AUTOMATION_SHADOW_SQL = `WITH
chosen AS (SELECT id FROM card_settlement_candidates ORDER BY created_at DESC,id DESC LIMIT 1001),
${cardSettlementReadinessCtes()},
current_candidates AS (
 SELECT c.*,json_array(json_extract(c.facts_json,'$.statement.sourceId'),
   coalesce(json_extract(c.facts_json,'$.statement.accountId'),
     json_extract(c.facts_json,'$.statement.sourceAccount')),
   json_extract(c.facts_json,'$.statement.period')) AS logical_statement
 FROM ready_candidates c JOIN readiness r ON r.id=c.id
 WHERE r.statement_current=1 AND r.bank_current=1
),
pairs AS (SELECT DISTINCT logical_statement,bank_key FROM current_candidates),
statement_options AS (SELECT logical_statement,count(*) n FROM pairs GROUP BY logical_statement),
bank_options AS (SELECT bank_key,count(*) n FROM pairs GROUP BY bank_key)
SELECT
 (SELECT count(*) FROM chosen) AS scanned_candidates,
 (SELECT count(*) FROM chosen)>1000 AS truncated,
 (SELECT count(*) FROM current_candidates) AS current_candidate_rows,
 (SELECT count(*) FROM pairs) AS distinct_pairs,
 (SELECT count(*) FROM statement_options) AS statements,
 (SELECT count(*) FROM pairs p JOIN statement_options s USING(logical_statement)
   JOIN bank_options b USING(bank_key) WHERE s.n=1 AND b.n=1) AS one_to_one_pairs,
 (SELECT count(*) FROM readiness WHERE statement_current<>1 OR bank_current<>1) AS stale_candidates,
 (SELECT count(*) FROM readiness WHERE statement_current=1 AND bank_current=1 AND ownership_current<>1) AS ownership_blocked,
 (SELECT count(*) FROM readiness WHERE statement_current=1 AND bank_current=1 AND allocation_available<>1) AS allocation_blocked,
 (SELECT count(*) FROM current_candidates c JOIN transaction_observations t ON t.id=c.bank_observation_id
   JOIN parse_runs p ON p.id=t.parse_run_id
   WHERE p.parser_name='smbc-direct-transactions' AND p.parser_version='1.1.0'
   AND json_type(t.extra_json,'$._kogane.bankAccount')='object') AS debit_context_present
`;
