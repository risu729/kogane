import type {
  CardSettlementImpact,
  CardSettlementReview as StoredReview,
  CardSettlementStatus,
} from "./card-settlement.ts";
import type { CardDebitAccountReason } from "./card-debit-account.ts";
import type { SourceFactRef } from "./events.ts";

/**
 * Why a review carries no provider-stated debit-account evidence: the card
 * source has no debit-account statement (Vpass, ADR 0032), or the sweep has
 * recorded no evidence row for this candidate under the current policy.
 */
type CardSettlementDebitAccountAbsence =
  | "source_has_no_debit_account_statement"
  | "evidence_not_recorded";

/**
 * What the card provider's own statement of the debit account says about the
 * candidate (`card_settlement_debit_account_evidence`, the latest row under
 * `CARD_DEBIT_ACCOUNT_POLICY`). Read-only evidence for the reviewer: it sets
 * no owner and changes no blocker or eligibility (INV07).
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
