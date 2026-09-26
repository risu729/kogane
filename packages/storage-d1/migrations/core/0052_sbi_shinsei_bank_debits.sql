-- Card settlement bank debits become a union of per-bank adapters (ADR 0018,
-- docs/card-settlements.md, Bank adapters). Each branch ranks its own
-- provider key, so re-observing a provider id never adds a second payment,
-- and each states the date the sweep matches (`debit_date`, a civil
-- `YYYY-MM-DD` or NULL) and the adapter that admitted the row (`adapter`).
--
-- SMBC keeps the 0044 predicate unchanged; its `debit_date` is the date part
-- of the midnight-JST `as_of` the sweep's regex accepted, and NULL otherwise.
-- (D1 refuses a GLOB pattern longer than 50 bytes, so only the date part is
-- globbed; the time part is compared as text.)
--
-- SBI Shinsei admits rows of `sbi-shinsei-top-balances-and-activity` only:
-- the provider row id `txnReferenceNo` as the external id, the provider's own
-- debit column (`_kogane.amountSignSource='debit'`, which the parser signs
-- negative unless the amount is zero), JPY, and no status (the parser never
-- sets one). `as_of` is the provider posting date, already `YYYY-MM-DD`.
-- Currency, status and sign are judged on the newest capture of the id, as
-- SMBC's are, so a newer representation that fails them withdraws the row.
--
-- Additive in effect: the SMBC rows and every column the view had are the
-- same, and `card_settlement_readiness` (0044), which reads this view by id,
-- keeps its text. SQLite does not check dependent views on DROP VIEW.
DROP VIEW card_bank_debit_facts;
CREATE VIEW card_bank_debit_facts AS
WITH ranked AS (
 SELECT t.id,t.parse_run_id,t.source_account,t.currency AS unit_ref,a.source_id,t.as_of,
 t.external_id,t.status,t.extra_json,d.status AS value_status,d.coefficient,d.scale,
 json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS bank_key,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id
  ORDER BY a.fetched_at DESC,t.id DESC) AS position
 FROM transaction_observations t
 JOIN published_parse_runs pub ON pub.parse_run_id=t.parse_run_id
 JOIN parse_runs p ON p.id=t.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='transaction' AND d.observation_id=t.id AND d.policy_version='decimal-v1'
 WHERE a.source_id='smbc-bank' AND t.external_id IS NOT NULL AND t.external_id<>''
), sbi_shinsei_ranked AS (
 SELECT t.id,t.parse_run_id,t.source_account,t.currency AS unit_ref,a.source_id,t.as_of,
 t.external_id,t.status,t.extra_json,d.status AS value_status,d.coefficient,d.scale,
 json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS bank_key,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id
  ORDER BY a.fetched_at DESC,t.id DESC) AS position
 FROM transaction_observations t
 JOIN published_parse_runs pub ON pub.parse_run_id=t.parse_run_id
 JOIN parse_runs p ON p.id=t.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='transaction' AND d.observation_id=t.id AND d.policy_version='decimal-v1'
 WHERE a.source_id='sbi-shinsei-bank' AND p.parser_name='sbi-shinsei-top-balances-and-activity'
 AND t.external_id IS NOT NULL AND t.external_id<>''
)
SELECT *,CASE WHEN length(as_of)=25 AND substr(as_of,11)='T00:00:00+09:00'
 AND substr(as_of,1,10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN substr(as_of,1,10) END AS debit_date,
 'smbc-bank' AS adapter
FROM ranked WHERE position=1 AND status='posted' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.direction')='outflow'
 AND json_extract(extra_json,'$._kogane.amountSignSource')='direction'
 AND coefficient LIKE '-%'
UNION ALL
SELECT *,CASE WHEN length(as_of)=10 AND as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN as_of END AS debit_date,
 'sbi-shinsei-bank' AS adapter
FROM sbi_shinsei_ranked WHERE position=1 AND status IS NULL AND unit_ref='JPY' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.amountSignSource')='debit'
 AND coefficient LIKE '-%';
