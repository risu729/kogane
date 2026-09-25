// The card purchases statement read exactly as #235 shipped it, before its
// owner was resolved through the keyed CTEs of
// packages/read-model/src/card-settlement-ownership.ts, frozen as text so the
// tests can prove the new read returns the same rows and see the old plan fail
// the plan checks. It still names the migration 0044 views, so a later change
// to them is compared with the keyed read too. `STATEMENT_SQL` of
// src/query/card-purchases.ts at that commit, verbatim. Never edit it by hand,
// and never import it outside tests.
export const LEGACY_STATEMENT_SQL = `SELECT account_id,source_id,period,id,parse_run_id,unit_ref,value_status,coefficient,scale,payment_date FROM (
  SELECT w.account_id,w.source_id,w.period,s.id,s.parse_run_id,s.unit_ref,s.value_status,s.coefficient,s.scale,s.payment_date,
   ROW_NUMBER() OVER (PARTITION BY w.account_id,w.source_id,w.period ORDER BY s.fetched_at DESC,s.id DESC) AS position
  FROM (SELECT DISTINCT json_extract(value,'$[0]') AS account_id,json_extract(value,'$[1]') AS source_id,
    json_extract(value,'$[2]') AS period FROM json_each(?1)) w
  JOIN card_statement_facts s ON s.source_id=w.source_id AND s.period=w.period
  WHERE (SELECT o.account_id FROM card_settlement_fact_ownership o
    WHERE o.kind='balance' AND o.observation_id=s.id)=w.account_id
 ) WHERE position=1`;
