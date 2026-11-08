import type {
  CardSettlementImpact,
  CardSettlementReview as StoredReview,
  CardSettlementStatus,
} from "./card-settlement.ts";
import type { CardDebitAccountReason } from "./card-debit-account.ts";
import type { SourceFactRef } from "./events.ts";
import { CARD_INFORMATION_REFUSALS } from "./myjcb-card-information.ts";

/**
 * Why the `card_debit_account_sweep` lane refused a MyJCB page's 「カード情報」
 * table: the reader's own codes and the lane's two page-level codes, the
 * closed set of migration 0060's `refusal_code` CHECK.
 */
export const CARD_DEBIT_ACCOUNT_STATEMENT_REFUSALS = [
  ...CARD_INFORMATION_REFUSALS,
  "page_not_utf8",
  "raw_object_unreadable",
] as const;

/**
 * Why a review carries no provider-stated debit-account evidence, a closed
 * set: the card source has no debit-account statement (Vpass, ADR 0032); the
 * lane refused the candidate's own statement page under the current reader
 * version, with the lane's refusal code; or the sweep has recorded no
 * evidence row for this candidate under the current policy and reader
 * version, and the page has no refusal either.
 */
export const CARD_SETTLEMENT_DEBIT_ACCOUNT_ABSENCES = [
  "source_has_no_debit_account_statement",
  "evidence_not_recorded",
  ...CARD_DEBIT_ACCOUNT_STATEMENT_REFUSALS,
] as const;
type CardSettlementDebitAccountAbsence = (typeof CARD_SETTLEMENT_DEBIT_ACCOUNT_ABSENCES)[number];

/**
 * What the card provider's own statement of the debit account says about the
 * candidate (`card_settlement_debit_account_evidence`, the latest row under
 * `CARD_DEBIT_ACCOUNT_POLICY` that cites a reading under
 * `CARD_INFORMATION_READER_VERSION`). Read-only evidence for the reviewer: it
 * sets no owner and changes no blocker or eligibility (INV07).
 */
export type CardSettlementDebitAccountReview =
  | {
      outcome: "supports" | "names_other_account";
      reason: null;
      policy: string;
      /** The `card_debit_account_statement` reading the row cites. */
      statementRef: SourceFactRef;
      /** The bank and CORE source account the provider's statement names. */
      bankSourceId: string;
      bankSourceAccount: string;
      /** How many leading account digits the provider showed and were compared. */
      visibleDigitCount: number;
      recordedAt: string;
    }
  | {
      outcome: "not_proposed";
      reason: CardDebitAccountReason;
      policy: string;
      statementRef: SourceFactRef;
      bankSourceId: null;
      bankSourceAccount: null;
      visibleDigitCount: null;
      recordedAt: string;
    }
  | {
      outcome: "absent";
      reason: CardSettlementDebitAccountAbsence;
      policy: string;
      statementRef: null;
      bankSourceId: null;
      bankSourceAccount: null;
      visibleDigitCount: null;
      recordedAt: null;
    };

/** Read-side review metadata; stored financial facts and impact stay in the domain contract. */
export interface CardSettlementReview extends StoredReview {
  acceptanceBlockers: string[];
  impact: CardSettlementImpact;
  history: {
    revision: number;
    status: Exclude<CardSettlementStatus, "proposed">;
    decisionRevisionId: string;
    createdAt: string;
  }[];
  historyTruncated: boolean;
  debitAccount: CardSettlementDebitAccountReview;
}

export interface CardSettlementReviewPage {
  items: CardSettlementReview[];
  nextOffset: number | null;
  coverage: {
    scope: "card-statement-bank-debit-candidates";
    completeTransactionHistory: false;
    netAssets: "unknown";
    limit: number;
  };
}

/**
 * How far the grouped list looked for a statement's lead beyond its judged
 * newest candidates (ADR 0090), a closed set:
 *
 * - `not_searched`: the judged candidates hold an acceptance or a ready one,
 *   or the statement has no older candidate, so nothing older was read;
 * - `found`: an older ready candidate was found and leads;
 * - `none_ready`: every older candidate that could be ready was judged and
 *   none is, so the newest leads (the passes are separate reads: a decision
 *   recorded between two of them can make one skip a candidate, ADR 0090);
 * - `truncated`: the search judged `olderCandidatesSearched` older candidates
 *   without finding a ready one and stopped there. Older ones past them were
 *   not judged, so whether the statement has a ready candidate is unknown,
 *   never "none"; the newest leads, and the statement's full list
 *   (`queryCardSettlements({ statementKey })`) judges every one.
 */
export const CARD_SETTLEMENT_LEAD_SEARCHES = [
  "not_searched",
  "found",
  "none_ready",
  "truncated",
] as const;
export type CardSettlementLeadSearch = (typeof CARD_SETTLEMENT_LEAD_SEARCHES)[number];

/**
 * One statement's candidates (`statement_key`): the lead first (its accepted
 * candidate, else the newest one ready to accept of all its candidates the
 * search judged, else the newest; ADR 0090), then the other judged ones
 * newest first. `candidateCount` counts every candidate of the statement, so
 * `candidateCount > candidates.length` says it has candidates the group does
 * not carry. `leadSearch` says how far the lead was looked for.
 */
export interface CardSettlementStatementGroup {
  statementKey: string;
  candidateCount: number;
  candidates: CardSettlementReview[];
  leadSearch: CardSettlementLeadSearch;
}

export interface CardSettlementStatementPage {
  statements: CardSettlementStatementGroup[];
  nextOffset: number | null;
  coverage: {
    scope: "card-statement-bank-debit-candidates";
    completeTransactionHistory: false;
    netAssets: "unknown";
    /** Statements per page. */
    limit: number;
    /**
     * The newest candidates judged per statement, besides an accepted one and,
     * when none of those decides the lead, the newest older ready one.
     */
    candidatesPerStatement: number;
    /**
     * The most older candidates per statement the search for a ready lead
     * judges on one read; past them a group says `truncated` (ADR 0090).
     */
    olderCandidatesSearched: number;
  };
}
