// Synthetic `GET /api/v2/card-purchases` payloads for the contract and browser
// tests. Every id, account, merchant and amount is invented.
import { CARD_USAGE_EXCLUSIONS } from "../../domain/src/card-purchase.ts";
import type {
  CardPurchaseCandidate,
  CardPurchasePage,
  CardPurchaseView,
} from "../../domain/src/card-purchase-view.ts";
import type { TemporalValue } from "../../domain/src/time.ts";
import { exactQuantity, integerDecimal, type Quantity } from "../../domain/src/values.ts";

const jpy = (amount: number | bigint): Quantity =>
  exactQuantity("JPY", integerDecimal(amount), "decimal-v1");
const date = (value: string): TemporalValue => ({
  kind: "local-date",
  value,
  zone: "Asia/Tokyo",
  basis: "provider",
});
const eventId = (kind: "purchase" | "refund", digit: string) => `${kind}_${digit.repeat(64)}`;

/** A captured Vpass purchase whose statement was settled by an accepted SMBC debit. */
export function capturedPurchase(): CardPurchaseView {
  const id = eventId("purchase", "1");
  return {
    eventId: id,
    revision: 1,
    kind: "purchase",
    state: "captured",
    unknownReason: null,
    sourceId: "vpass",
    accountId: "acct-card",
    usageDate: "2026-08-15",
    statementPeriod: "2026-09",
    amount: jpy(1234),
    lastKnownAmount: jpy(1234),
    sourceRows: [
      {
        role: "posted",
        ref: { kind: "transaction", id: "transaction:21", revision: "parse_run:7" },
        usageDate: "2026-08-15",
        counterparty: "架空の書店",
        current: true,
        rawLocator: "json:$.rows[0]",
      },
    ],
    statement: {
      status: "linked",
      ref: { kind: "balance", id: "balance:31", revision: "parse_run:8" },
      period: "2026-09",
      paymentDate: date("2026-10-10"),
      providerTotal: jpy(1734),
    },
    settlement: {
      proposalId: "cs_synthetic",
      reviewStatus: "accepted",
      decisionRevisionId: "dr_synthetic_settlement",
      settlementEventId: "event_synthetic_settlement",
      allocationId: "allocation_synthetic_settlement",
      bankDebit: {
        ref: { kind: "transaction", id: "transaction:41", revision: "parse_run:9" },
        sourceId: "smbc-bank",
        amount: jpy(1734),
        occurred: date("2026-10-10"),
      },
    },
    history: [
      {
        revision: 1,
        action: "recognize",
        state: "captured",
        unknownReason: null,
        decisionRevisionId: `dr_cp_${"2".repeat(64)}`,
        createdAt: "2026-09-24T00:00:00.000Z",
      },
    ],
    historyTruncated: false,
    candidates: [],
    explanationRefs: [
      `event:${id}@1`,
      `leg:${id}@1#0`,
      "transaction:21@parse_run:7",
      "balance:31@parse_run:8",
      "card-settlement:cs_synthetic",
      "event:event_synthetic_settlement",
      "allocation:allocation_synthetic_settlement",
      "transaction:41@parse_run:9",
    ],
  };
}

/** A pending (authorized) MyJCB purchase: not yet on a statement. */
function pendingPurchase(): CardPurchaseView {
  const id = eventId("purchase", "3");
  return {
    ...capturedPurchase(),
    eventId: id,
    state: "authorized",
    sourceId: "myjcb",
    accountId: "acct-jcb",
    usageDate: "2026-09-02",
    statementPeriod: "2026-10",
    amount: jpy(1200),
    lastKnownAmount: jpy(1200),
    sourceRows: [
      {
        role: "pending",
        ref: { kind: "transaction", id: "transaction:22", revision: "parse_run:7" },
        usageDate: "2026-09-02",
        counterparty: "架空の喫茶店",
        current: true,
        rawLocator: "json:$.rows[1]",
      },
    ],
    statement: { status: "unlinked", reasonCode: "not_posted" },
    settlement: null,
    history: [
      {
        revision: 1,
        action: "recognize",
        state: "authorized",
        unknownReason: null,
        decisionRevisionId: `dr_cp_${"4".repeat(64)}`,
        createdAt: "2026-09-24T00:00:00.000Z",
      },
    ],
    explanationRefs: [`event:${id}@1`, "transaction:22@parse_run:7"],
  };
}

/** A pending row the provider no longer displays: unresolved, no live amount. */
export function retiredPurchase(): CardPurchaseView {
  const id = eventId("purchase", "5");
  return {
    ...pendingPurchase(),
    eventId: id,
    revision: 2,
    state: "unknown",
    unknownReason: "provider_status_absent",
    usageDate: "2026-08-03",
    amount: null,
    lastKnownAmount: jpy(800),
    sourceRows: [
      {
        role: "pending",
        ref: { kind: "transaction", id: "transaction:23", revision: "parse_run:6" },
        usageDate: "2026-08-03",
        counterparty: "架空の売店",
        current: false,
        rawLocator: "json:$.rows[2]",
      },
    ],
    history: [
      {
        revision: 2,
        action: "retire",
        state: "unknown",
        unknownReason: "provider_status_absent",
        decisionRevisionId: `dr_cp_${"6".repeat(64)}`,
        createdAt: "2026-09-24T00:00:00.000Z",
      },
      {
        revision: 1,
        action: "recognize",
        state: "authorized",
        unknownReason: null,
        decisionRevisionId: `dr_cp_${"7".repeat(64)}`,
        createdAt: "2026-09-23T00:00:00.000Z",
      },
    ],
    explanationRefs: [`event:${id}@2`, "transaction:23@parse_run:6"],
  };
}

/** A captured refund whose original purchase is not identified. */
function capturedRefund(): CardPurchaseView {
  const id = eventId("refund", "8");
  return {
    ...capturedPurchase(),
    eventId: id,
    kind: "refund",
    usageDate: "2026-08-20",
    amount: jpy(300),
    lastKnownAmount: jpy(300),
    sourceRows: [
      {
        role: "posted",
        ref: { kind: "transaction", id: "transaction:24", revision: "parse_run:7" },
        usageDate: "2026-08-20",
        counterparty: "架空の書店",
        current: true,
        rawLocator: "json:$.rows[3]",
      },
    ],
    explanationRefs: [`event:${id}@1`, "transaction:24@parse_run:7"],
  };
}

/**
 * A heuristic pending-to-posted candidate between the retired pending row of
 * `retiredPurchase` (transaction:23) and the posted row of `capturedPurchase`
 * (transaction:21), still open: it may be accepted (merge) or rejected.
 */
export function linkCandidate(
  overrides: Partial<CardPurchaseCandidate> = {},
): CardPurchaseCandidate {
  const proposalId = `rp_${"9".repeat(64)}`;
  const pending = { kind: "transaction" as const, id: "transaction:23", revision: "parse_run:6" };
  const posted = { kind: "transaction" as const, id: "transaction:21", revision: "parse_run:7" };
  return {
    proposalId,
    proposalStatus: "proposed",
    proposalRevision: 0,
    relationStatus: null,
    relationRevision: 0,
    providerLinked: false,
    rationaleCodes: [
      "status_pending_to_posted",
      "same_identifier_namespace",
      "same_source_account",
      "no_provider_link_id",
      "same_statement_period",
    ],
    rejectionConditions: [
      "provider_link_absent",
      "counterparty_differs",
      "amount_differs",
      "candidate_not_unique",
    ],
    pending: {
      ref: pending,
      eventId: eventId("purchase", "5"),
      revision: 2,
      state: "unknown",
      displayedAmount: jpy(-800),
      usageDate: "2026-08-03",
    },
    posted: {
      ref: posted,
      eventId: eventId("purchase", "1"),
      revision: 1,
      state: "captured",
      displayedAmount: jpy(-1234),
      usageDate: "2026-08-15",
    },
    actions: ["accept", "reject"],
    blockers: [],
    relation: {
      relationKind: "pending_to_posted",
      fromRef: pending.id,
      toRef: posted.id,
      validFrom: null,
      validTo: null,
      evidenceRefs: [
        `reconciliation-proposal:${proposalId}`,
        "transaction:23@parse_run:6",
        "transaction:21@parse_run:7",
      ],
    },
    ...overrides,
  };
}

export function purchasePage(
  items: CardPurchaseView[] = [
    pendingPurchase(),
    capturedRefund(),
    capturedPurchase(),
    retiredPurchase(),
  ],
): CardPurchasePage {
  return {
    items,
    nextOffset: null,
    summary: {
      units: [
        {
          unitRef: "JPY",
          captured: jpy(1234),
          authorized: jpy(1200),
          capturedRefunds: jpy(300),
          authorizedRefunds: jpy(0),
        },
      ],
      unresolved: 1,
      events: items.length,
      statementTotals: [
        {
          sourceId: "vpass",
          accountId: "acct-card",
          period: "2026-09",
          ref: { kind: "balance", id: "balance:31", revision: "parse_run:8" },
          total: jpy(1734),
        },
      ],
      settlementAddsPurchaseExpense: false,
    },
    coverage: {
      scope: "card-purchase-recognition",
      completeTransactionHistory: false,
      unsupportedShapes: [...CARD_USAGE_EXCLUSIONS],
      unrecognizedCurrentRows: 3,
      limit: 50,
    },
  };
}
