// `card_settlement_readiness` (migration 0044) for named candidates only.
//
// The view reads `card_statement_facts`, `card_bank_debit_facts` and
// `card_settlement_fact_ownership` whole: it ranks every captured statement
// total and every SMBC row of the history, and resolves owners through
// `current_identity_observations`, which materializes the candidate identity
// runs of every published parse. On D1, which never runs `ANALYZE`, the first
// page of the review list took about 42 s on the two-year synthetic store and
// one candidate's readiness about 5 s (docs/card-settlements.md, Cost).
//
// These CTEs compute the same flags for the candidates a caller names. The
// caller defines `chosen(id)` before them; they add
//
//   ready_candidates     those candidates' rows;
//   statement_partitions the (source, period) of each candidate's statement;
//   ready_statements     `card_statement_facts`, for the statements of those (source, period);
//   debit_partitions     the (source account, provider id) of each candidate's debit;
//   ready_debits         `card_bank_debit_facts`, for the rows of those partitions;
//   statement_observed   the statements whose owner a flag reads;
//   statement_owned_runs ... statement_ownership
//                        card-settlement-ownership.ts, `balance`, over those;
//   debit_observed       the candidates' debits;
//   debit_owned_runs ... debit_ownership
//                        card-settlement-ownership.ts, `transaction`, over those;
//   readiness            the view's own select over them: id, statement_current,
//                        bank_current, ownership_current, allocation_available.
//
// They are exact, not an approximation. Each fact view ranks captures within a
// partition (source, producer, namespace, source account and period or provider
// id), and both restrictions keep whole partitions: every row of a given
// source and period, and every row of a given source account and provider id.
// `statement_current` compares a candidate's statement only with statements of
// its own source and period, and `bank_current` looks up the candidate's own
// debit, so the partitions they can reach are all there. The owners are those
// of card-settlement-ownership.ts, which is exact for the observations named.
// The allocation check keeps the view's text, with the debit's own source
// account and provider id taken from the candidate's `bank_key` as well: a row
// whose key equals `bank_key` has exactly those, so the added terms only let
// the plan find the rows by index; the debit rows are reached by the account
// index too (`+t.external_id` keeps an unanalyzed planner from building an
// automatic index over every bank row instead). `readiness` is the view's select with the
// three views swapped for these CTEs; the review and allocation checks are the
// view's text. card-settlement-readiness.test.ts and every caller's
// differential test compare it with the view on the scale and random stores.
import { cardSettlementOwnershipCtes } from "./card-settlement-ownership.ts";

/** The 0044 period expression of a statement total, over `b.extra_json`. */
const PERIOD = `coalesce(json_extract(b.extra_json,'$._kogane.period'),
  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2))`;

export function cardSettlementReadinessCtes(): string {
  return `ready_candidates AS MATERIALIZED (
 SELECT c.* FROM (SELECT DISTINCT id FROM chosen) chosen_ids
 CROSS JOIN card_settlement_candidates c ON c.id=chosen_ids.id
), statement_partitions AS MATERIALIZED (
 SELECT DISTINCT a.source_id,${PERIOD} AS period
 FROM ready_candidates ready_candidate
 CROSS JOIN balance_observations b ON b.id=ready_candidate.statement_observation_id
 CROSS JOIN parse_runs p ON p.id=b.parse_run_id
 CROSS JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
 WHERE json_valid(b.extra_json)
), ready_statements AS MATERIALIZED (
 SELECT * FROM (
 SELECT b.id,b.parse_run_id,b.source_account,b.instrument AS unit_ref,a.source_id,a.fetched_at,
 d.status AS value_status,d.coefficient,d.scale,
 json_extract(b.extra_json,'$._kogane.paymentDate') AS payment_date,
 ${PERIOD} AS period,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,b.source_account,
  ${PERIOD}
  ORDER BY a.fetched_at DESC,json_extract(b.extra_json,'$._kogane.paymentDate') IS NOT NULL DESC,b.id DESC) AS position
 FROM balance_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='balance' AND d.observation_id=b.id AND d.policy_version='decimal-v1'
 WHERE ((a.source_id='vpass' AND p.parser_name='vpass-statement-page') OR (a.source_id='myjcb' AND p.parser_name='myjcb-credit-statement-total'))
 AND b.metric='credit_statement_payment_amount' AND json_valid(b.extra_json)
 AND json_extract(b.extra_json,'$._kogane.snapshotSemantics')='provider-reported-monthly-payment-amount'
 AND EXISTS(SELECT 1 FROM statement_partitions statement_partition WHERE statement_partition.source_id IS a.source_id
  AND statement_partition.period IS CASE WHEN json_valid(b.extra_json) THEN ${PERIOD} END)
 ) WHERE position=1
), debit_partitions AS MATERIALIZED (
 SELECT DISTINCT t.source_account,t.external_id
 FROM ready_candidates ready_candidate
 CROSS JOIN transaction_observations t ON t.id=ready_candidate.bank_observation_id
 WHERE t.external_id IS NOT NULL AND t.external_id<>''
), ready_debits AS MATERIALIZED (
 SELECT * FROM (
 SELECT t.id,t.parse_run_id,t.source_account,t.external_id,t.status,t.extra_json,d.coefficient,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id
  ORDER BY a.fetched_at DESC,t.id DESC) AS position
 FROM debit_partitions debit_partition
 CROSS JOIN transaction_observations t ON t.source_account=debit_partition.source_account AND +t.external_id=debit_partition.external_id
 JOIN published_parse_runs pub ON pub.parse_run_id=t.parse_run_id
 JOIN parse_runs p ON p.id=t.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='transaction' AND d.observation_id=t.id AND d.policy_version='decimal-v1'
 WHERE a.source_id='smbc-bank' AND t.external_id IS NOT NULL AND t.external_id<>''
 ) WHERE position=1 AND status='posted' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.direction')='outflow'
 AND json_extract(extra_json,'$._kogane.amountSignSource')='direction'
 AND coefficient LIKE '-%'
), statement_observed AS (
 SELECT id AS observation_id FROM ready_statements
 UNION ALL SELECT statement_observation_id FROM ready_candidates
), ${cardSettlementOwnershipCtes("balance", { prefix: "statement_", observed: "statement_observed" })},
debit_observed AS (SELECT bank_observation_id AS observation_id FROM ready_candidates),
${cardSettlementOwnershipCtes("transaction", { prefix: "debit_", observed: "debit_observed" })},
readiness AS (
SELECT ready_candidate.id,
 EXISTS(SELECT 1 FROM ready_statements current_statement
  WHERE current_statement.id=ready_candidate.statement_observation_id AND current_statement.parse_run_id=ready_candidate.statement_parse_run_id
  AND NOT EXISTS(SELECT 1 FROM ready_statements newer_statement
   JOIN statement_ownership newer_owner ON newer_owner.kind='balance' AND newer_owner.observation_id=newer_statement.id
   WHERE newer_statement.source_id=current_statement.source_id AND newer_statement.period=current_statement.period
    AND newer_owner.account_id=json_extract(ready_candidate.facts_json,'$.statement.accountId')
    AND (newer_statement.fetched_at>current_statement.fetched_at
     OR (newer_statement.fetched_at=current_statement.fetched_at AND newer_statement.id>current_statement.id)))
 ) AS statement_current,
 EXISTS(SELECT 1 FROM ready_debits current_debit WHERE current_debit.id=ready_candidate.bank_observation_id AND current_debit.parse_run_id=ready_candidate.bank_parse_run_id) AS bank_current,
 EXISTS(SELECT 1 FROM statement_ownership statement_owner JOIN debit_ownership debit_owner
  ON debit_owner.kind='transaction' AND debit_owner.observation_id=ready_candidate.bank_observation_id
  WHERE statement_owner.kind='balance' AND statement_owner.observation_id=ready_candidate.statement_observation_id
   AND statement_owner.owner_ref IS NOT NULL AND statement_owner.owner_ref=debit_owner.owner_ref
   AND statement_owner.account_id=json_extract(ready_candidate.facts_json,'$.statement.accountId')
   AND debit_owner.account_id=json_extract(ready_candidate.facts_json,'$.bankDebit.accountId')
   AND statement_owner.owner_ref=json_extract(ready_candidate.facts_json,'$.statement.ownerRef')
   AND debit_owner.owner_ref=json_extract(ready_candidate.facts_json,'$.bankDebit.ownerRef')
   AND NOT EXISTS(SELECT 1 FROM json_each(statement_owner.evidence_refs_json) e WHERE e.value NOT IN (SELECT value FROM json_each(ready_candidate.facts_json,'$.ownershipEvidenceRefs')))
   AND NOT EXISTS(SELECT 1 FROM json_each(debit_owner.evidence_refs_json) e WHERE e.value NOT IN (SELECT value FROM json_each(ready_candidate.facts_json,'$.ownershipEvidenceRefs')))
 ) AS ownership_current,
 NOT EXISTS(SELECT 1 FROM card_settlement_reviews used WHERE used.status='accepted' AND used.id<>ready_candidate.id
  AND (used.statement_key=ready_candidate.statement_key OR used.bank_key=ready_candidate.bank_key
   OR (json_extract(used.facts_json,'$.statement.sourceId')=json_extract(ready_candidate.facts_json,'$.statement.sourceId')
    AND json_extract(used.facts_json,'$.statement.accountId')=json_extract(ready_candidate.facts_json,'$.statement.accountId')
    AND json_extract(used.facts_json,'$.statement.period')=json_extract(ready_candidate.facts_json,'$.statement.period'))))
 AND NOT EXISTS(SELECT 1 FROM current_allocations a
  JOIN transaction_observations t ON a.source_component_ref='transaction:'||t.id
  JOIN parse_runs p ON p.id=t.parse_run_id
  JOIN observation_fetch_artifacts artifact ON artifact.id=p.fetch_artifact_id
  JOIN financial_fetch_runs fr ON fr.id=artifact.fetch_run_id
  JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
  WHERE json_array(artifact.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id)=ready_candidate.bank_key
  AND t.source_account=CASE WHEN json_valid(ready_candidate.bank_key) THEN json_extract(ready_candidate.bank_key,'$[3]') END
  AND t.external_id IS CASE WHEN json_valid(ready_candidate.bank_key) THEN json_extract(ready_candidate.bank_key,'$[4]') END
  AND a.id IS NOT (SELECT settlement_id FROM card_settlement_reviews self WHERE self.id=ready_candidate.id)) AS allocation_available
FROM ready_candidates ready_candidate)`;
}
