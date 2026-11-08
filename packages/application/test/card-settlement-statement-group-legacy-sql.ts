// `CARD_SETTLEMENT_STATEMENT_GROUP_SQL` of src/query/card-settlements.ts
// exactly as #1021 shipped it and origin/main held it at c96e80e6, before the
// grouped list searched a statement's older candidates for a ready lead
// (ADR 0089), frozen as text with the readiness CTEs it embedded, so the
// differential tests can prove the grouped read still judges the same window
// and returns the same rows, and that the grouped list changes only where that
// window decides no lead. The digest below pins the text: never edit it by
// hand, and never import it outside tests.

/** SHA-256 of `LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL`. */
export const LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL_SHA256 =
  "d63aa7238d2f960aa6c2fb62f0badf6853571728fdc21c0e9764b89c999550e7";

/** `?1` a JSON array of statement keys, `?2` the newest candidates judged per statement. */
export const LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL = `WITH chosen AS MATERIALIZED (
 SELECT id FROM (
  SELECT c.id,row_number() OVER (PARTITION BY c.statement_key ORDER BY c.created_at DESC,c.id DESC) AS position
  FROM json_each(?1) page JOIN card_settlement_candidates c ON c.statement_key=page.value
 ) WHERE position<=?2
 UNION
 SELECT c.id FROM json_each(?1) page JOIN card_settlement_candidates c ON c.statement_key=page.value
 WHERE EXISTS(SELECT 1 FROM card_settlement_decisions d WHERE d.proposal_id=c.id AND d.status='accepted'
  AND d.revision=(SELECT max(latest.revision) FROM card_settlement_decisions latest WHERE latest.proposal_id=c.id))
), ready_candidates AS MATERIALIZED (
 SELECT c.* FROM (SELECT DISTINCT id FROM chosen) chosen_ids
 CROSS JOIN card_settlement_candidates c ON c.id=chosen_ids.id
), statement_partitions AS MATERIALIZED (
 SELECT DISTINCT a.source_id,coalesce(json_extract(b.extra_json,'$._kogane.period'),
  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2)) AS period
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
 coalesce(json_extract(b.extra_json,'$._kogane.period'),
  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2)) AS period,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,b.source_account,
  coalesce(json_extract(b.extra_json,'$._kogane.period'),
  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2))
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
  AND statement_partition.period IS CASE WHEN json_valid(b.extra_json) THEN coalesce(json_extract(b.extra_json,'$._kogane.period'),
  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2)) END)
 ) WHERE position=1
), debit_partitions AS MATERIALIZED (
 SELECT DISTINCT t.source_account,t.external_id
 FROM ready_candidates ready_candidate
 CROSS JOIN transaction_observations t ON t.id=ready_candidate.bank_observation_id
 WHERE t.external_id IS NOT NULL AND t.external_id<>''
), ready_debits AS MATERIALIZED (
 SELECT * FROM (
 SELECT t.id,t.parse_run_id,t.source_account,t.currency AS unit_ref,t.external_id,t.status,t.extra_json,d.coefficient,
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
 UNION ALL
 SELECT * FROM (
 SELECT t.id,t.parse_run_id,t.source_account,t.currency AS unit_ref,t.external_id,t.status,t.extra_json,d.coefficient,
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
 WHERE a.source_id='sbi-shinsei-bank' AND p.parser_name='sbi-shinsei-top-balances-and-activity' AND t.external_id IS NOT NULL AND t.external_id<>''
 ) WHERE position=1 AND status IS NULL AND unit_ref='JPY' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.amountSignSource')='debit'
 AND coefficient LIKE '-%'
), statement_observed AS (
 SELECT id AS observation_id FROM ready_statements
 UNION ALL SELECT statement_observation_id FROM ready_candidates
), statement_owned_runs AS MATERIALIZED (
 SELECT DISTINCT r.parse_run_id FROM statement_observed
 CROSS JOIN identity_observations o ON o.kind='balance' AND o.observation_id=statement_observed.observation_id
 CROSS JOIN identity_runs r ON r.id=o.identity_run_id
), statement_owned_candidates AS MATERIALIZED (
 SELECT r.id,r.parse_run_id,r.policy_version
 FROM statement_owned_runs
 CROSS JOIN published_parse_runs pub ON pub.parse_run_id=statement_owned_runs.parse_run_id
 CROSS JOIN parse_runs p ON p.id=pub.parse_run_id
 CROSS JOIN eligible_identity_runs r ON r.parse_run_id=p.id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
), statement_owned_latest AS MATERIALIZED (
 SELECT parse_run_id,max(policy_version) AS policy_version
 FROM statement_owned_candidates GROUP BY parse_run_id
), statement_owned_identity AS MATERIALIZED (
 SELECT o.* FROM (SELECT DISTINCT observation_id FROM statement_observed) observed_ids
 CROSS JOIN identity_observations o ON o.kind='balance' AND o.observation_id=observed_ids.observation_id
 CROSS JOIN statement_owned_candidates r ON r.id=o.identity_run_id
 CROSS JOIN statement_owned_latest l ON l.parse_run_id=r.parse_run_id AND l.policy_version=r.policy_version
), statement_ownership AS (
SELECT owned.kind,owned.observation_id,
 CASE WHEN count(DISTINCT m.account_id)=1 THEN min(m.account_id) END AS account_id,
 CASE WHEN count(DISTINCT m.account_id)=1 AND count(DISTINCT r.to_ref)=1 THEN min(r.to_ref) END AS owner_ref,
 json_array('account_mapping:'||min(m.id),'relation:'||min(r.id),'decision:'||min(d.id)) AS evidence_refs_json
FROM statement_owned_identity owned
CROSS JOIN current_account_mappings m ON m.source_account_id=owned.source_account_id
LEFT JOIN entity_relations r ON r.from_ref IN(m.account_id,'account:'||m.account_id)
 AND r.kind=CASE WHEN owned.kind='balance' THEN 'liable_party' ELSE 'beneficial_owner' END AND r.status='accepted'
 AND r.valid_from IS NULL AND r.valid_to IS NULL
 AND NOT EXISTS(SELECT 1 FROM entity_relations dated
  JOIN decision_revisions dated_decision ON dated_decision.id=dated.decision_revision_id AND dated_decision.superseded_by IS NULL
  WHERE dated.from_ref IN(m.account_id,'account:'||m.account_id)
   AND dated.kind=CASE WHEN owned.kind='balance' THEN 'liable_party' ELSE 'beneficial_owner' END
   AND dated.status='accepted' AND (dated.valid_from IS NOT NULL OR dated.valid_to IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM entity_relations latest WHERE latest.kind=dated.kind
    AND latest.from_ref IN(m.account_id,'account:'||m.account_id) AND latest.to_ref=dated.to_ref AND latest.rowid>dated.rowid
    AND latest.status<>'proposed'))
 AND NOT EXISTS(SELECT 1 FROM entity_relations newer WHERE newer.kind=r.kind
  AND newer.from_ref IN(m.account_id,'account:'||m.account_id) AND newer.to_ref=r.to_ref AND newer.rowid>r.rowid
  AND newer.status<>'proposed')
LEFT JOIN decision_revisions d ON d.id=r.decision_revision_id AND d.superseded_by IS NULL
WHERE owned.kind IN ('balance','transaction') AND (r.id IS NULL OR d.id IS NOT NULL)
GROUP BY owned.kind,owned.observation_id),
debit_observed AS (SELECT bank_observation_id AS observation_id FROM ready_candidates),
debit_owned_runs AS MATERIALIZED (
 SELECT DISTINCT r.parse_run_id FROM debit_observed
 CROSS JOIN identity_observations o ON o.kind='transaction' AND o.observation_id=debit_observed.observation_id
 CROSS JOIN identity_runs r ON r.id=o.identity_run_id
), debit_owned_candidates AS MATERIALIZED (
 SELECT r.id,r.parse_run_id,r.policy_version
 FROM debit_owned_runs
 CROSS JOIN published_parse_runs pub ON pub.parse_run_id=debit_owned_runs.parse_run_id
 CROSS JOIN parse_runs p ON p.id=pub.parse_run_id
 CROSS JOIN eligible_identity_runs r ON r.parse_run_id=p.id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
), debit_owned_latest AS MATERIALIZED (
 SELECT parse_run_id,max(policy_version) AS policy_version
 FROM debit_owned_candidates GROUP BY parse_run_id
), debit_owned_identity AS MATERIALIZED (
 SELECT o.* FROM (SELECT DISTINCT observation_id FROM debit_observed) observed_ids
 CROSS JOIN identity_observations o ON o.kind='transaction' AND o.observation_id=observed_ids.observation_id
 CROSS JOIN debit_owned_candidates r ON r.id=o.identity_run_id
 CROSS JOIN debit_owned_latest l ON l.parse_run_id=r.parse_run_id AND l.policy_version=r.policy_version
), debit_ownership AS (
SELECT owned.kind,owned.observation_id,
 CASE WHEN count(DISTINCT m.account_id)=1 THEN min(m.account_id) END AS account_id,
 CASE WHEN count(DISTINCT m.account_id)=1 AND count(DISTINCT r.to_ref)=1 THEN min(r.to_ref) END AS owner_ref,
 json_array('account_mapping:'||min(m.id),'relation:'||min(r.id),'decision:'||min(d.id)) AS evidence_refs_json
FROM debit_owned_identity owned
CROSS JOIN current_account_mappings m ON m.source_account_id=owned.source_account_id
LEFT JOIN entity_relations r ON r.from_ref IN(m.account_id,'account:'||m.account_id)
 AND r.kind=CASE WHEN owned.kind='balance' THEN 'liable_party' ELSE 'beneficial_owner' END AND r.status='accepted'
 AND r.valid_from IS NULL AND r.valid_to IS NULL
 AND NOT EXISTS(SELECT 1 FROM entity_relations dated
  JOIN decision_revisions dated_decision ON dated_decision.id=dated.decision_revision_id AND dated_decision.superseded_by IS NULL
  WHERE dated.from_ref IN(m.account_id,'account:'||m.account_id)
   AND dated.kind=CASE WHEN owned.kind='balance' THEN 'liable_party' ELSE 'beneficial_owner' END
   AND dated.status='accepted' AND (dated.valid_from IS NOT NULL OR dated.valid_to IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM entity_relations latest WHERE latest.kind=dated.kind
    AND latest.from_ref IN(m.account_id,'account:'||m.account_id) AND latest.to_ref=dated.to_ref AND latest.rowid>dated.rowid
    AND latest.status<>'proposed'))
 AND NOT EXISTS(SELECT 1 FROM entity_relations newer WHERE newer.kind=r.kind
  AND newer.from_ref IN(m.account_id,'account:'||m.account_id) AND newer.to_ref=r.to_ref AND newer.rowid>r.rowid
  AND newer.status<>'proposed')
LEFT JOIN decision_revisions d ON d.id=r.decision_revision_id AND d.superseded_by IS NULL
WHERE owned.kind IN ('balance','transaction') AND (r.id IS NULL OR d.id IS NOT NULL)
GROUP BY owned.kind,owned.observation_id),
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
  AND a.id IS NOT (SELECT settlement_id FROM card_settlement_reviews self WHERE self.id=ready_candidate.id)) AS allocation_available,
 NOT EXISTS(SELECT 1 FROM economic_claims held
  JOIN economic_event_revisions held_revision ON held_revision.event_id=held.event_id AND held_revision.revision=held.revision
  WHERE held.book='cash-movement' AND held.consumption_key=ready_candidate.bank_key AND held_revision.superseded_by IS NULL
  AND held.event_id IS NOT (SELECT self.event_id FROM card_settlement_reviews self WHERE self.id=ready_candidate.id AND self.status='accepted'))
 AND NOT EXISTS(SELECT 1 FROM card_settlement_candidates holder_candidate
  JOIN card_settlement_decisions holder ON holder.proposal_id=holder_candidate.id AND holder.status='accepted'
  JOIN economic_event_revisions holder_revision ON holder_revision.event_id=holder.event_id AND holder_revision.revision=holder.revision
  WHERE holder_candidate.bank_key=ready_candidate.bank_key AND holder_revision.superseded_by IS NULL
  AND holder.event_id IS NOT (SELECT self.event_id FROM card_settlement_reviews self WHERE self.id=ready_candidate.id AND self.status='accepted'))
 AND NOT EXISTS(SELECT 1 FROM transaction_observations debit
  JOIN parse_runs debit_run ON debit_run.id=debit.parse_run_id
  JOIN fetch_artifacts debit_artifact ON debit_artifact.id=debit_run.fetch_artifact_id
  JOIN economic_claims alias_held ON alias_held.book='cash-movement' AND alias_held.alias_class=CASE WHEN json_valid(debit.extra_json) THEN CASE WHEN debit_artifact.source_id='smbc-bank' AND debit_run.parser_name='smbc-direct-transactions' AND json_type(debit.extra_json,'$.id')='text' AND length(json_extract(debit.extra_json,'$.id')) BETWEEN 1 AND 512
  AND typeof(json_extract(ready_candidate.facts_json,'$.bankDebit.accountId'))='text' AND length(json_extract(ready_candidate.facts_json,'$.bankDebit.accountId')) BETWEEN 1 AND 256
  AND length(json_array(debit_artifact.source_id,json_array(json_extract(debit.extra_json,'$.id')),json_extract(ready_candidate.facts_json,'$.bankDebit.accountId'),'smbc-meisai-id-v1'))<=2048 THEN json_array(debit_artifact.source_id,json_array(json_extract(debit.extra_json,'$.id')),json_extract(ready_candidate.facts_json,'$.bankDebit.accountId'),'smbc-meisai-id-v1')
  WHEN debit_artifact.source_id='sbi-shinsei-bank' AND debit_run.parser_name='sbi-shinsei-top-balances-and-activity' AND json_type(debit.extra_json,'$.txnReferenceNo')='text' AND length(json_extract(debit.extra_json,'$.txnReferenceNo')) BETWEEN 1 AND 512
  AND typeof(json_extract(ready_candidate.facts_json,'$.bankDebit.accountId'))='text' AND length(json_extract(ready_candidate.facts_json,'$.bankDebit.accountId')) BETWEEN 1 AND 256
  AND length(json_array(debit_artifact.source_id,json_array(json_extract(debit.extra_json,'$.txnReferenceNo')),json_extract(ready_candidate.facts_json,'$.bankDebit.accountId'),'sbi-shinsei-txn-reference-no-v1'))<=2048 THEN json_array(debit_artifact.source_id,json_array(json_extract(debit.extra_json,'$.txnReferenceNo')),json_extract(ready_candidate.facts_json,'$.bankDebit.accountId'),'sbi-shinsei-txn-reference-no-v1') END END
  JOIN economic_event_revisions alias_revision ON alias_revision.event_id=alias_held.event_id AND alias_revision.revision=alias_held.revision
  WHERE debit.id=ready_candidate.bank_observation_id AND alias_revision.superseded_by IS NULL
  AND alias_held.event_id IS NOT (SELECT self.event_id FROM card_settlement_reviews self WHERE self.id=ready_candidate.id AND self.status='accepted')) AS claim_available
FROM ready_candidates ready_candidate)
SELECT c.id,c.facts_json,c.revision,c.status,c.decision_revision_id,c.event_id,c.obligation_id,c.settlement_id,c.created_at,
 r.statement_current,r.bank_current,r.ownership_current,r.allocation_available,c.statement_key
FROM chosen JOIN card_settlement_reviews c ON c.id=chosen.id LEFT JOIN readiness r ON r.id=c.id
ORDER BY c.created_at DESC,c.id DESC`;
