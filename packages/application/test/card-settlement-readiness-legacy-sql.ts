// The reads of `card_settlement_readiness` exactly as #251 left them, before
// they judged only their own candidates through the keyed CTEs of
// packages/read-model/src/card-settlement-readiness.ts, frozen as text so the
// tests can prove the new reads return the same rows and see the old plans
// fail the plan checks. They still name the migration 0044 view, so a later
// change to it is compared with the keyed reads too. Verbatim from
// src/query/card-settlements.ts, src/query/card-ownership.ts,
// src/operations/card-settlement-target.ts and src/operations/ownership-review.ts
// at that commit; never edit them by hand, and never import them outside tests.

/** `queryCardSettlements`: `?1` a proposal id or NULL, `?2` the limit, `?3` the offset. */
export const LEGACY_CARD_SETTLEMENT_REVIEWS_SQL = `SELECT c.id,c.facts_json,c.revision,c.status,c.decision_revision_id,c.event_id,c.obligation_id,c.settlement_id,c.created_at,
       r.statement_current,r.bank_current,r.ownership_current,r.allocation_available
     FROM card_settlement_reviews c LEFT JOIN card_settlement_readiness r ON r.id=c.id
     WHERE (?1 IS NULL OR c.id=?1) ORDER BY c.created_at DESC,c.id DESC LIMIT ?2 OFFSET ?3`;

/** `queryCardOwnership`'s candidate read. */
export const LEGACY_CARD_OWNERSHIP_CANDIDATE_SQL = `SELECT c.id,c.facts_json,c.revision,c.status,r.statement_current,r.bank_current
    FROM card_settlement_reviews c JOIN card_settlement_readiness r ON r.id=c.id WHERE c.id=?1`;

/** `cardSettlementPlan`'s candidate read. */
export const LEGACY_CARD_SETTLEMENT_PLAN_SQL = `SELECT c.id,c.facts_json,c.status,c.revision,
      r.statement_current,r.bank_current,r.ownership_current,r.allocation_available
     FROM card_settlement_reviews c JOIN card_settlement_readiness r ON r.id=c.id WHERE c.id=?1`;

/** `prepareOwnershipReview`'s candidate read. */
export const LEGACY_OWNERSHIP_REVIEW_CANDIDATE_SQL = `SELECT c.id,c.facts_json,c.revision,c.status,r.statement_current,r.bank_current
 FROM card_settlement_reviews c JOIN card_settlement_readiness r ON r.id=c.id WHERE c.id=?`;

/** The candidate term of `prepareOwnershipReview`'s commit guard, binds (id, revision). */
export const LEGACY_OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL = `EXISTS(SELECT 1 FROM card_settlement_reviews c JOIN card_settlement_readiness r ON r.id=c.id
    WHERE c.id=? AND c.status='proposed' AND c.revision=? AND r.statement_current=1 AND r.bank_current=1)`;
