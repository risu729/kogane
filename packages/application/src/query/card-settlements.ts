// One bounded read path for review UI. It never writes a financial decision.
import {
  cardSettlementEligible,
  cardSettlementImpact,
  validCardSettlementFacts,
  type CardSettlementStatus,
} from "../../../domain/src/card-settlement.ts";
import type {
  CardSettlementDebitAccountReview,
  CardSettlementReview,
  CardSettlementReviewPage,
} from "../../../domain/src/card-settlement-review.ts";
import {
  CARD_DEBIT_ACCOUNT_POLICY,
  CARD_DEBIT_ACCOUNT_REASONS,
  type CardDebitAccountReason,
} from "../../../domain/src/card-debit-account.ts";
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

interface DebitAccountRow {
  candidate_id: string;
  statement_id: number;
  reader_version: string;
  outcome: string;
  reason: string | null;
  proposal_json: string | null;
  created_at: string;
}

/**
 * The latest provider-stated debit-account evidence row of each chosen
 * candidate under the current policy (`?1` a JSON array of candidate ids,
 * `?2` the policy), with the reader version of the statement it cites. Found
 * through `card_settlement_debit_account_evidence_candidate`
 * (candidate_id, statement_id, policy, id) and the statement's key; the page
 * holds at most 50 candidates, each with a row per changed outcome.
 */
export const CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL = `SELECT candidate_id,statement_id,reader_version,outcome,reason,proposal_json,created_at FROM (
 SELECT e.candidate_id,e.statement_id,s.reader_version,e.outcome,e.reason,e.proposal_json,e.created_at,
  ROW_NUMBER() OVER (PARTITION BY e.candidate_id ORDER BY e.id DESC) AS ordinal
 FROM json_each(?1) selected
 JOIN card_settlement_debit_account_evidence e ON e.candidate_id=selected.value AND e.policy=?2
 JOIN card_debit_account_statement s ON s.id=e.statement_id
) WHERE ordinal=1`;

const reasonCode = (value: unknown): value is CardDebitAccountReason =>
  (CARD_DEBIT_ACCOUNT_REASONS as readonly unknown[]).includes(value);

/** A malformed evidence row is an unavailable answer, never a missing one. */
function debitAccountReview(row: DebitAccountRow): CardSettlementDebitAccountReview {
  const invalid = () => new Error("card_settlement_debit_account_evidence_invalid");
  const statementRef = {
    kind: "typed-claim" as const,
    id: `card_debit_account_statement:${row.statement_id}`,
    revision: `reader:${row.reader_version}`,
  };
  const base = { policy: CARD_DEBIT_ACCOUNT_POLICY, statementRef, recordedAt: row.created_at };
  if (row.outcome === "not_proposed") {
    if (!reasonCode(row.reason) || row.proposal_json !== null) throw invalid();
    return {
      ...base,
      outcome: "not_proposed",
      reason: row.reason,
      bankSourceId: null,
      bankSourceAccount: null,
      visibleDigitCount: null,
    };
  }
  if (row.outcome !== "supports" && row.outcome !== "names_other_account") throw invalid();
  if (row.reason !== null || row.proposal_json === null) throw invalid();
  const proposal: unknown = JSON.parse(row.proposal_json);
  if (
    proposal === null ||
    typeof proposal !== "object" ||
    !("bankSourceId" in proposal) ||
    !("bankSourceAccount" in proposal) ||
    !("visibleDigitCount" in proposal) ||
    typeof proposal.bankSourceId !== "string" ||
    typeof proposal.bankSourceAccount !== "string" ||
    typeof proposal.visibleDigitCount !== "number" ||
    !Number.isSafeInteger(proposal.visibleDigitCount) ||
    proposal.visibleDigitCount < 1
  )
    throw invalid();
  return {
    ...base,
    outcome: row.outcome,
    reason: null,
    bankSourceId: proposal.bankSourceId,
    bankSourceAccount: proposal.bankSourceAccount,
    visibleDigitCount: proposal.visibleDigitCount,
  };
}

/** No evidence row: only MyJCB has a debit-account statement (ADR 0032). */
function absentDebitAccount(sourceId: string): CardSettlementDebitAccountReview {
  return {
    outcome: "absent",
    reason:
      sourceId === "myjcb" ? "evidence_not_recorded" : "source_has_no_debit_account_statement",
    policy: CARD_DEBIT_ACCOUNT_POLICY,
    statementRef: null,
    bankSourceId: null,
    bankSourceAccount: null,
    visibleDigitCount: null,
    recordedAt: null,
  };
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
    debitAccount: absentDebitAccount(facts.statement.sourceId),
  };
}

/**
 * The reviews `chosen` names (`?1` a proposal id, `?2` the page size plus one,
 * `?3` the offset), newest first, with their `card_settlement_readiness`
 * flags. The page is chosen first and only its candidates are judged, through
 * the keyed form of the view (card-settlement-readiness.ts): joined whole, the
 * view ranked every statement total and bank debit row and resolved the owners of
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
    const evidence = await sql.all<DebitAccountRow>(CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL, [
      JSON.stringify(items.map((item) => item.proposalId)),
      CARD_DEBIT_ACCOUNT_POLICY,
    ]);
    for (const item of items) {
      const row = evidence.find((entry) => entry.candidate_id === item.proposalId);
      if (row) item.debitAccount = debitAccountReview(row);
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
