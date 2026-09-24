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
import type {
  PendingPostedAction,
  PendingPostedBlocker,
  PendingPostedRelation,
} from "./pending-posted-review.ts";
import type { ProposalStatus, RationaleCode, RejectionConditionCode } from "./reconcile.ts";
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

/** One side of a pending-to-posted candidate: the row the matcher compared and its live event. */
export interface CardPurchaseCandidateSide {
  /** The proposal's target, pinned to the parse run the matcher read it in. */
  ref: SourceFactRef;
  /** The live recognised event holding that row's recognition key, or null when none does. */
  eventId: string | null;
  /** That event's live revision; a plan pins it as `card-purchase:<eventId>`. */
  revision: number | null;
  state: EventState | null;
  /** The row's own decimal-v1 amount as the provider displayed it (outflow negative). */
  displayedAmount: Quantity | null;
  /** The row's provider usage date, `YYYY-MM-DD`. */
  usageDate: string | null;
}

/**
 * A stage-B reconciliation proposal that names one of this event's provider
 * rows: the pending row and the posted row it may be the same purchase as.
 * Reviewing it is `relation.accept` (merge) or `relation.reject` (reject, or
 * withdraw an accepted link, which splits the merged event) with `relation`
 * plus a reason as the payload.
 */
export interface CardPurchaseCandidate {
  /** `reconciliation_proposals.id`. */
  proposalId: string;
  proposalStatus: ProposalStatus;
  /** Decisions recorded on `proposal:<id>`; a plan pins it under that subject. */
  proposalRevision: number;
  /** The latest `entity_relations` status of the triple, or null when it has none. */
  relationStatus: "proposed" | "accepted" | "rejected" | "released" | null;
  /** Rows of the triple; a plan pins it as `relation:pending_to_posted|<from>|<to>`. */
  relationRevision: number;
  /** The provider itself linked the pair (a provider link id); otherwise a heuristic candidate. */
  providerLinked: boolean;
  rationaleCodes: RationaleCode[];
  rejectionConditions: RejectionConditionCode[];
  pending: CardPurchaseCandidateSide;
  posted: CardPurchaseCandidateSide;
  /** What a review may do now (`pendingPostedReview`); empty when closed. */
  actions: PendingPostedAction[];
  /** Why `accept` (or `withdraw`) is not offered. */
  blockers: PendingPostedBlocker[];
  /** The relation payload to plan, apart from its `reason`. */
  relation: PendingPostedRelation;
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
  /** Pending-to-posted candidates naming one of this event's rows, newest first (at most 10). */
  candidates: CardPurchaseCandidate[];
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

/**
 * The candidate fields that are review affordances rather than facts: what an
 * operator may do now, and the exact payload a review plans. The agent API
 * (`kogane.purchases.explain`, docs/agent-api.md) never hands either to a
 * caller: an agent does not decide a link, so it is not offered one.
 */
export const CARD_PURCHASE_REVIEW_AFFORDANCES = ["actions", "relation"] as const;

/** A candidate as an agent reads it: every fact of the operator's, no action and no plan payload. */
export type AgentCardPurchaseCandidate = Omit<
  CardPurchaseCandidate,
  (typeof CARD_PURCHASE_REVIEW_AFFORDANCES)[number]
>;

export interface AgentCardPurchaseView extends Omit<CardPurchaseView, "candidates"> {
  candidates: AgentCardPurchaseCandidate[];
}

/** The operator's page with each candidate's review affordances removed; nothing else differs. */
export interface AgentCardPurchasePage extends Omit<CardPurchasePage, "items"> {
  items: AgentCardPurchaseView[];
}
