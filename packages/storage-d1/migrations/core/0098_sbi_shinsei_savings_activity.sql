-- Period history and top activity share one account-local provider transaction identity.
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
 WHERE a.source_id='sbi-shinsei-bank' AND p.parser_name IN ('sbi-shinsei-top-balances-and-activity','sbi-shinsei-savings-activity')
 AND t.external_id IS NOT NULL AND t.external_id<>''
)
SELECT *,CASE WHEN as_of=substr(as_of,1,10)||'T00:00:00+09:00'
 AND substr(as_of,1,10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN substr(as_of,1,10) END AS debit_date,
 'smbc-bank' AS adapter
FROM ranked WHERE position=1 AND status='posted' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.direction')='outflow'
 AND json_extract(extra_json,'$._kogane.amountSignSource')='direction'
 AND coefficient LIKE '-%'
UNION ALL
SELECT *,CASE WHEN length(CAST(as_of AS BLOB))=10 AND as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN as_of END AS debit_date,
 'sbi-shinsei-bank' AS adapter
FROM sbi_shinsei_ranked WHERE position=1 AND status IS NULL AND unit_ref='JPY' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.amountSignSource')='debit'
 AND coefficient LIKE '-%';

-- Independent account histories keep successful units on a partial run.
INSERT INTO dataset_snapshot_policies
(source_id,dataset,parser_name,policy_id,unit_scope,snapshot_selection) VALUES
('sbi-shinsei-bank','savings-activity','sbi-shinsei-savings-activity','coverage-v1','unit',0);
