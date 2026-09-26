// The settlement sweep's statement and bank reads exactly as #215 shipped them
// (src/card-settlement-job.ts), before their owners were resolved through the
// keyed CTEs of packages/read-model/src/card-settlement-ownership.ts, frozen as
// text so the tests can prove the new reads return the same rows and see the
// old plans fail the plan checks. They still name the migration 0044 views, so
// a later change to them is compared with the keyed reads too. Verbatim; never
// edit them by hand, and never import them outside tests.
export const LEGACY_CARD_SETTLEMENT_STATEMENTS_SQL = `SELECT s.*,o.account_id,o.owner_ref,o.evidence_refs_json FROM card_statement_facts s
 LEFT JOIN card_settlement_fact_ownership o ON o.kind='balance' AND o.observation_id=s.id
 WHERE s.id>? ORDER BY s.id LIMIT ?`;

export const LEGACY_CARD_SETTLEMENT_BANK_DEBITS_SQL = `SELECT b.*,o.account_id,o.owner_ref,o.evidence_refs_json FROM card_bank_debit_facts b
 LEFT JOIN card_settlement_fact_ownership o ON o.kind='transaction' AND o.observation_id=b.id
 WHERE substr(b.as_of,1,10) BETWEEN date(?,'-3 days') AND date(?,'+3 days') ORDER BY b.id LIMIT ?`;

/**
 * The commit guard of src/card-settlement-commands.ts exactly as #251 left it,
 * before it judged only its own candidate through the keyed CTEs of
 * packages/read-model/src/card-settlement-readiness.ts; binds (id, revision,
 * status). Verbatim; never edit it by hand.
 */
export function legacyCardSettlementCommitGuardSql(accept: boolean): string {
  return (
    `EXISTS(SELECT 1 FROM card_settlement_reviews c JOIN card_settlement_readiness ready ON ready.id=c.id
   WHERE c.id=? AND c.revision=? AND c.status=?` +
    (accept
      ? " AND ready.statement_current=1 AND ready.bank_current=1 AND ready.ownership_current=1 AND ready.allocation_available=1"
      : "") +
    ")"
  );
}
