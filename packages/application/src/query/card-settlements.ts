// One bounded read path for review UI. It never writes a financial decision.
import {
  cardSettlementEligible,
  cardSettlementImpact,
  validCardSettlementFacts,
  type CardSettlementStatus,
} from "../../../domain/src/card-settlement.ts";
import type {
  CardSettlementReview,
  CardSettlementReviewPage,
} from "../../../domain/src/card-settlement-review.ts";
import { cardSettlementReadinessCtes } from "../../../read-model/src/card-settlement-readiness.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

export const CARD_SETTLEMENT_PAGE_SIZE = 50;
const HISTORY_LIMIT = 20;
interface ReviewRow {
  id: string;
  facts_json: string;
  revision: number;
  status: CardSettlementStatus;
  decision_revision_id: string | null;
  event_id: string | null;
  obligation_id: string | null;
  settlement_id: string | null;
  created_at: string;
  statement_current: number | null;
  bank_current: number | null;
  ownership_current: number | null;
  allocation_available: number | null;
}
interface HistoryRow {
  proposal_id: string;
  revision: number;
  status: Exclude<CardSettlementStatus, "proposed">;
  decision_revision_id: string;
  created_at: string;
}

/** A malformed persisted candidate is an unavailable answer, never a zero-filled result. */
function review(row: ReviewRow): CardSettlementReview {
  const facts: unknown = JSON.parse(row.facts_json);
  if (!validCardSettlementFacts(facts)) throw new Error("card_settlement_facts_invalid");
  const blockers: string[] = [];
  if (!cardSettlementEligible(facts)) {
    if (facts.ownership === "different") blockers.push("owner_differs");
    else if (facts.ownership !== "established-same" || facts.ownershipEvidenceRefs.length === 0)
      blockers.push("owner_not_established");
    if (facts.statement.accountId === null || facts.bankDebit.accountId === null)
      blockers.push("account_not_resolved");
    if (blockers.length === 0) blockers.push("settlement_not_eligible");
  }
  if (row.statement_current !== 1) blockers.push("statement_changed");
  if (row.bank_current !== 1) blockers.push("bank_debit_changed");
  if (
    row.ownership_current !== 1 &&
    !blockers.includes("owner_not_established") &&
    !blockers.includes("owner_differs")
  )
    blockers.push("ownership_changed");
  if (row.allocation_available !== 1) blockers.push("allocation_already_used");
  return {
    proposalId: row.id,
    revision: row.revision,
    status: row.status,
    facts,
    acceptanceBlockers: blockers,
    impact: cardSettlementImpact(facts, row.status),
    decisionRevisionId: row.decision_revision_id,
    eventId: row.event_id,
    obligationId: row.obligation_id,
    settlementId: row.settlement_id,
    createdAt: row.created_at,
    history: [],
    historyTruncated: false,
  };
}

/**
 * The reviews `chosen` names (`?1` a proposal id, `?2` the page size plus one,
 * `?3` the offset), newest first, with their `card_settlement_readiness`
 * flags. The page is chosen first and only its candidates are judged, through
 * the keyed form of the view (card-settlement-readiness.ts): joined whole, the
 * view ranked every statement total and SMBC row and resolved the owners of
 * the whole store for every candidate (docs/card-settlements.md, Cost).
 * A review is one candidate and its latest decision, so choosing candidates
 * chooses the same reviews.
 */
const reviewsSql = (chosen: string): string => `WITH chosen AS MATERIALIZED (
 ${chosen}
), ${cardSettlementReadinessCtes()}
SELECT c.id,c.facts_json,c.revision,c.status,c.decision_revision_id,c.event_id,c.obligation_id,c.settlement_id,c.created_at,
 r.statement_current,r.bank_current,r.ownership_current,r.allocation_available
FROM chosen JOIN card_settlement_reviews c ON c.id=chosen.id LEFT JOIN readiness r ON r.id=c.id
ORDER BY c.created_at DESC,c.id DESC`;
/** A page of the list: every candidate is ordered (`?1` is NULL here). */
export const CARD_SETTLEMENT_PAGE_SQL = reviewsSql(
  "SELECT id FROM card_settlement_candidates review_page WHERE ?1 IS NULL ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3",
);
/** One proposal by id, found by its key. */
export const CARD_SETTLEMENT_REVIEW_SQL = reviewsSql(
  "SELECT id FROM card_settlement_candidates WHERE id=?1 ORDER BY created_at DESC,id DESC LIMIT ?2 OFFSET ?3",
);

/** Offset lists and exact-id reads share the same financial and explanation DTO. */
export async function queryCardSettlements(
  sql: SqlExecutor,
  input: { offset?: number; proposalId?: string } = {},
): Promise<CardSettlementReviewPage> {
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
    throw new Error("invalid_offset");
  const rows = await sql.all<ReviewRow>(
    (input.proposalId ?? null) === null ? CARD_SETTLEMENT_PAGE_SQL : CARD_SETTLEMENT_REVIEW_SQL,
    [input.proposalId ?? null, CARD_SETTLEMENT_PAGE_SIZE + 1, offset],
  );
  const items = rows.slice(0, CARD_SETTLEMENT_PAGE_SIZE).map(review);
  if (items.length > 0) {
    const history = await sql.all<HistoryRow>(
      `SELECT proposal_id,revision,status,decision_revision_id,created_at FROM (
        SELECT proposal_id,revision,status,decision_revision_id,created_at,
          ROW_NUMBER() OVER (PARTITION BY proposal_id ORDER BY revision DESC) AS ordinal
        FROM card_settlement_decisions d JOIN json_each(?1) selected ON d.proposal_id=json_extract(selected.value,'$.proposalId')
        WHERE d.revision<=json_extract(selected.value,'$.revision')
      ) WHERE ordinal<=?2 ORDER BY proposal_id,revision DESC`,
      [
        JSON.stringify(
          items.map((item) => ({ proposalId: item.proposalId, revision: item.revision })),
        ),
        HISTORY_LIMIT + 1,
      ],
    );
    for (const item of items) {
      const revisions = history.filter((row) => row.proposal_id === item.proposalId);
      item.history = revisions.slice(0, HISTORY_LIMIT).map((row) => ({
        revision: row.revision,
        status: row.status,
        decisionRevisionId: row.decision_revision_id,
        createdAt: row.created_at,
      }));
      item.historyTruncated = revisions.length > HISTORY_LIMIT;
    }
  }
  return {
    items,
    nextOffset: rows.length > CARD_SETTLEMENT_PAGE_SIZE ? offset + CARD_SETTLEMENT_PAGE_SIZE : null,
    coverage: {
      scope: "card-statement-bank-debit-candidates",
      completeTransactionHistory: false,
      netAssets: "unknown",
      limit: CARD_SETTLEMENT_PAGE_SIZE,
    },
  };
}
