import type {
  CardSettlementImpact,
  CardSettlementReview as StoredReview,
  CardSettlementStatus,
} from "./card-settlement.ts";

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
