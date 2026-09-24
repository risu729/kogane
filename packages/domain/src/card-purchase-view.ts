import type { CardSettlementStatus } from "./card-settlement.ts";
import type {
  CardPurchaseAction,
  CardPurchaseKeyRole,
  CardPurchaseKind,
  CardPurchaseSourceId,
  CardPurchaseUnitTotals,
  CardUsageExclusion,
} from "./card-purchase.ts";
import type { EventState, SourceFactRef, UnknownStateReason } from "./events.ts";
import type { TemporalValue } from "./time.ts";
import type { Quantity } from "./values.ts";

/** A provider row behind a purchase. Counterparty text is read from Layer B, never stored. */
export interface CardPurchaseSourceRow {
  role: CardPurchaseKeyRole;
  ref: SourceFactRef;
  usageDate: string | null;
  counterparty: string | null;
  /** Still in the latest complete, published snapshot. */
  current: boolean;
  rawLocator: string | null;
}

export const CARD_PURCHASE_STATEMENT_REASONS = [
  "not_posted",
  "statement_not_collected",
  "period_unrecognized",
] as const;
export type CardPurchaseStatementReason = (typeof CARD_PURCHASE_STATEMENT_REASONS)[number];

/** The provider statement a posted purchase belongs to, or why none is shown. */
export type CardPurchaseStatementLink =
  | {
      status: "linked";
      ref: SourceFactRef;
      period: string;
      paymentDate: TemporalValue;
      /** The provider's authoritative total; never compared with or reduced by purchases. */
      providerTotal: Quantity;
    }
  | { status: "unlinked"; reasonCode: CardPurchaseStatementReason };

/**
 * The reviewed statement settlement and its bank debit, derived at read time
 * from the statement's (resolved account, source, period). The settlement
 * event, the allocation and the bank debit are shown only while the review is
 * `accepted`; a proposed, rejected or withdrawn review names its status alone.
 */
export interface CardPurchaseSettlementLink {
  /** The card settlement candidate (`card_settlement_reviews.id`). */
  proposalId: string;
  reviewStatus: CardSettlementStatus;
  decisionRevisionId: string | null;
  settlementEventId: string | null;
  allocationId: string | null;
  bankDebit: {
    ref: SourceFactRef;
    sourceId: string;
    amount: Quantity;
    occurred: TemporalValue;
  } | null;
}

export interface CardPurchaseRevisionEntry {
  revision: number;
  action: CardPurchaseAction;
  state: EventState;
  unknownReason: UnknownStateReason | null;
  decisionRevisionId: string;
  createdAt: string;
}

/** Read-side view of one recognised purchase or refund; stored facts stay in the domain contract. */
export interface CardPurchaseView {
  eventId: string;
  revision: number;
  kind: CardPurchaseKind;
  state: EventState;
  unknownReason: UnknownStateReason | null;
  sourceId: CardPurchaseSourceId;
  accountId: string;
  /** The provider usage date the event is effective on (`YYYY-MM-DD`). */
  usageDate: string;
  statementPeriod: string | null;
  /** The live purchase-recognition leg; null for an `unknown` revision, which has none. */
  amount: Quantity | null;
  /** The amount of the latest revision that had a leg, shown beside an unresolved state. */
  lastKnownAmount: Quantity | null;
  sourceRows: CardPurchaseSourceRow[];
  statement: CardPurchaseStatementLink;
  settlement: CardPurchaseSettlementLink | null;
  history: CardPurchaseRevisionEntry[];
  historyTruncated: boolean;
  explanationRefs: string[];
}

export interface CardPurchasePage {
  items: CardPurchaseView[];
  nextOffset: number | null;
  /**
   * Figures of every live event the filter selects, not only this page's
   * items, so paging never changes them.
   */
  summary: {
    /** Captured, authorized and refunds per unit; there is no combined total. */
    units: CardPurchaseUnitTotals[];
    unresolved: number;
    /** Live recognised purchase and refund events the figures cover. */
    events: number;
    /** Provider statement totals shown beside the figures, never subtracted from them. */
    statementTotals: {
      sourceId: CardPurchaseSourceId;
      accountId: string;
      period: string;
      ref: SourceFactRef;
      total: Quantity;
    }[];
    /** Accepting a card settlement never adds purchase expense. */
    settlementAddsPurchaseExpense: false;
  };
  coverage: {
    scope: "card-purchase-recognition";
    completeTransactionHistory: false;
    unsupportedShapes: CardUsageExclusion[];
    unrecognizedCurrentRows: number;
    limit: number;
  };
}
