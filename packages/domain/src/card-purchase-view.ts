import type { CardSettlementStatus } from "./card-settlement.ts";
import type {
  CardPurchaseAction,
  CardPurchaseKeyRole,
  CardPurchaseKind,
  CardPurchaseSourceId,
  CardPurchaseUnitTotals,
  CardUsageExclusion,
  CardUsageUnrecognizedReason,
} from "./card-purchase.ts";
import type { EventState, SourceFactRef, UnknownStateReason } from "./events.ts";
import type {
  PendingPostedAction,
  PendingPostedBlocker,
  PendingPostedRelation,
} from "./pending-posted-review.ts";
import type { ProposalStatus, RationaleCode, RejectionConditionCode } from "./reconcile.ts";
import type { TemporalValue } from "./time.ts";
import { decimalToString, type Quantity } from "./values.ts";

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
    /** Current provider rows no live event holds, across every card source and month. */
    unrecognizedCurrentRows: number;
    /** Why those rows are outside the list, per source and closed reason. */
    unrecognizedReasons: CardPurchaseUnrecognizedReasons;
    /**
     * No refund is allocated to the purchase it refunds: the review kind
     * `card-refund.allocate` exists, but nothing plans or writes an
     * allocation, so a refund is shown and summed apart from purchases and
     * never subtracted from one. Stated, not implied, as the page says it.
     */
    refundsAllocated: false;
    limit: number;
  };
}

/**
 * The unrecognised current rows counted per source and reason: each row is
 * classified by `classifyCardUsage`, the recognition writer's own rule, when
 * the page is read. `complete` is false when there were more rows than one
 * request classifies (`CARD_PURCHASE_UNRECOGNIZED_LIMIT`); the counts then
 * cover the rows of lowest observation id only and add up to less than
 * `unrecognizedCurrentRows`. Only reasons some row has are listed.
 */
export interface CardPurchaseUnrecognizedReasons {
  complete: boolean;
  counts: {
    sourceId: CardPurchaseSourceId;
    reasonCode: CardUsageUnrecognizedReason;
    rows: number;
  }[];
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

// ---------------------------------------------------------------------------
// Per card (ADR 0125)
// ---------------------------------------------------------------------------

/**
 * One amount in the compact form of the per-card view: decimal text when it
 * is exact, else its status and reason, never a zero (INV05).
 */
export type CompactAmount =
  | { unit: string; value: string }
  | { unit: string; status: "missing" | "unparsed" | "conflict"; reason: string };

/** A provider civil date as `YYYY-MM-DD`, or the reason there is none (INV05). */
export type CompactDate = string | { reason: string };

/**
 * `CardPurchaseUnitTotals` as decimal text. Every figure is the exact sum
 * `cardPurchaseSummary` computed (it refuses a leg without an exact amount),
 * so each one is exact; the states stay apart and there is no combined total.
 */
export interface CardPurchaseCardFigures {
  unit: string;
  captured: string;
  authorized: string;
  capturedRefunds: string;
  authorizedRefunds: string;
}

/** A provider statement that the filter's posted purchases of one card were posted to. */
export interface CardPurchaseCardStatement {
  period: string;
  /** The provider's own total, never compared with or reduced by the purchases. */
  total: CompactAmount;
  paymentDate: CompactDate;
  /**
   * The status of the statement's settlement review (accepted first, as the
   * page picks it), or null when it has none.
   */
  settlement: CardSettlementStatus | null;
  /**
   * The bank debit an accepted review cites: its source and date; null unless
   * the review is accepted. Its amount and account are the review's
   * (`kogane.card-settlements.read`, `kogane.card-settlements.debit-accounts`).
   */
  debit: { sourceId: string; date: CompactDate } | null;
}

/** One card: a resolved account and the card source its purchases were recognised from. */
export interface CardPurchaseCard {
  accountId: string;
  sourceId: CardPurchaseSourceId;
  /** The account's stored label (`accounts.label`), or null when the store has no row for it. */
  label: string | null;
  /** Live purchase and refund events of this card in the filter. */
  events: number;
  /** Of them, those in state `unknown`: counted, never summed. */
  unresolved: number;
  figures: CardPurchaseCardFigures[];
  /**
   * Events without a statement figure, by the closed reason the page gives
   * each one; only reasons some event has, in the closed order.
   */
  withoutStatement: { reasonCode: CardPurchaseStatementReason; events: number }[];
  /** The statements this card's posted events in the filter belong to, newest period first. */
  statements: CardPurchaseCardStatement[];
}

/** A quantity in the compact form: decimal text when exact, else its status and reason. */
export function compactAmount(quantity: Quantity): CompactAmount {
  const { value } = quantity;
  return value.status === "exact"
    ? { unit: quantity.unitRef, value: decimalToString(value.value) }
    : { unit: quantity.unitRef, status: value.status, reason: value.reasonCode };
}

/**
 * A provider time as a civil date: a local date is its `YYYY-MM-DD`; an
 * unknown time keeps its reason; an instant or a period is not a civil date
 * and says so rather than being cut to one.
 */
export function compactDate(time: TemporalValue): CompactDate {
  if (time.kind === "local-date") return time.value;
  if (time.kind === "unknown") return { reason: time.reasonCode };
  return { reason: `not_a_civil_date:${time.kind}` };
}

/**
 * The figures of one unit as decimal text. `cardPurchaseSummary` returns only
 * exact sums; a figure that is not exact here is a broken invariant, so it
 * fails the answer instead of being shown as anything.
 */
export function cardFigures(totals: CardPurchaseUnitTotals): CardPurchaseCardFigures {
  const text = (quantity: Quantity): string => {
    if (quantity.value.status !== "exact" || quantity.unitRef !== totals.unitRef)
      throw new Error("card_purchase_amount_invalid");
    return decimalToString(quantity.value.value);
  };
  return {
    unit: totals.unitRef,
    captured: text(totals.captured),
    authorized: text(totals.authorized),
    capturedRefunds: text(totals.capturedRefunds),
    authorizedRefunds: text(totals.authorizedRefunds),
  };
}

/** The most cards one per-card answer lists; `cardsTruncated` says when more exist. */
export const CARD_PURCHASE_CARDS_MAX = 100;

/**
 * The per-card answer of the card purchase read (`view: cards`, ADR 0125):
 * the same whole-filter selection and figures as `CardPurchasePage.summary`,
 * grouped by card, without the per-event explanation.
 */
export interface CardPurchaseCardsPage {
  view: "cards";
  /** What selected the events: one statement period, or one month of provider usage dates. */
  frame: "statement-period" | "usage-month";
  /** Every card with a live event in the filter, by source and then account; at most 100. */
  cards: CardPurchaseCard[];
  /** True when more cards than `cards` lists have events in the filter; `totals` still covers them. */
  cardsTruncated: boolean;
  /** The figures of every card together: `CardPurchasePage.summary.units` for the same filter. */
  totals: CardPurchaseCardFigures[];
  events: number;
  unresolved: number;
  /** Accepting a card settlement never adds purchase expense. */
  settlementAddsPurchaseExpense: false;
  coverage: Omit<CardPurchasePage["coverage"], "limit">;
}
