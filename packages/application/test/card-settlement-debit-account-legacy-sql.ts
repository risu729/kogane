// `CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL` exactly as #1019 shipped it, before the
// review counted only evidence citing a reading under the current reader
// version and took a refused page's code (ADR 0032, 2026-11-07 amendment),
// frozen as text so a differential test can prove the new read returns the
// same evidence rows wherever every cited reading is current. Verbatim from
// src/query/card-settlements.ts at that commit; never edit it by hand, and
// never import it outside tests.

/** `?1` a JSON array of candidate ids, `?2` the policy. */
export const LEGACY_CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL = `SELECT candidate_id,statement_id,reader_version,outcome,reason,proposal_json,created_at FROM (
 SELECT e.candidate_id,e.statement_id,s.reader_version,e.outcome,e.reason,e.proposal_json,e.created_at,
  ROW_NUMBER() OVER (PARTITION BY e.candidate_id ORDER BY e.id DESC) AS ordinal
 FROM json_each(?1) selected
 JOIN card_settlement_debit_account_evidence e ON e.candidate_id=selected.value AND e.policy=?2
 JOIN card_debit_account_statement s ON s.id=e.statement_id
) WHERE ordinal=1`;
