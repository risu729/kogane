// The card debit-account candidate read exactly as #1387 shipped it, before a
// statement counted as settled by the acceptance guard's month identity, frozen
// as text so the tests can prove the new read returns the same rows wherever
// that identity and the statement key agree, and see where they differ.
// `CARD_DEBIT_ACCOUNT_CANDIDATES_SQL` of src/query/card-debit-accounts.ts at
// that commit (034c726b, unchanged through ee51b8b7), verbatim. Never edit it
// by hand, and never import it outside tests.
export const LEGACY_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL = `WITH live AS MATERIALIZED (
 SELECT r.id,r.status,r.statement_key,
  json_extract(r.facts_json,'$.statement.sourceId') AS card_source_id,
  json_extract(r.facts_json,'$.statement.sourceAccount') AS card_source_account,
  json_extract(r.facts_json,'$.statement.period') AS period,
  json_extract(r.facts_json,'$.bankDebit.sourceId') AS bank_source_id,
  json_extract(r.facts_json,'$.bankDebit.sourceAccount') AS bank_source_account,
  CASE WHEN json_extract(r.facts_json,'$.bankDebit.occurred.kind')='local-date'
   THEN json_extract(r.facts_json,'$.bankDebit.occurred.value') END AS debit_date
 FROM card_settlement_reviews r WHERE r.status IN ('accepted','proposed')
), settled AS (SELECT DISTINCT statement_key FROM live WHERE status='accepted')
SELECT status,card_source_id,card_source_account,bank_source_id,bank_source_account,
 count(DISTINCT statement_key) AS statements,
 max(coalesce(debit_date,'')||char(10)||id) AS latest_key,period AS latest_period
FROM live WHERE status='accepted' OR statement_key NOT IN (SELECT statement_key FROM settled)
GROUP BY status,card_source_id,card_source_account,bank_source_id,bank_source_account
ORDER BY card_source_id,card_source_account,status,bank_source_id,bank_source_account`;
