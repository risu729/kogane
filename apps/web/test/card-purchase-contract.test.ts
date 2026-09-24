import { describe, expect, test } from "bun:test";
import {
  capturedPurchase,
  linkCandidate,
  purchasePage,
  retiredPurchase,
} from "../../../packages/application/test/card-purchase-view-fixture.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { validCardPurchasePage } from "../../../packages/observation-shared/src/card-purchase-contract.ts";
import {
  validApiCapabilities,
  validApiResponse,
} from "../../../packages/observation-shared/src/api-validation.ts";
import { clientFeatures } from "../src/capabilities.ts";
import {
  plannedProposalId,
  plannedPurchaseEventId,
  purchaseLinkAction,
  purchaseLinkPinsMatch,
  purchaseLinkPlanRequest,
} from "../src/card-purchases-api.ts";
import { matchRoute } from "../src/router.tsx";
import {
  authorizedCandidate,
  authorizedPendingPurchase,
  linkPlanPins,
  mergedCandidate,
  mergedPurchase,
  PENDING_EVENT,
  POSTED_EVENT,
} from "./card-purchase-link-fixture.ts";

const path = "/api/v2/card-purchases";
const clone = <T>(value: T): T => structuredClone(value);

describe("card purchase HTTP contract", () => {
  test("accepts state-separated figures and every statement and settlement shape", () => {
    expect(validApiResponse(path, purchasePage())).toBe(true);
    expect(validCardPurchasePage(purchasePage([]))).toBe(true);
    const unlinked = purchasePage([
      {
        ...capturedPurchase(),
        statement: { status: "unlinked", reasonCode: "period_unrecognized" },
        settlement: null,
      },
    ]);
    expect(validCardPurchasePage(unlinked)).toBe(true);
    const proposed = purchasePage([
      {
        ...capturedPurchase(),
        settlement: {
          proposalId: "cs_synthetic",
          reviewStatus: "proposed",
          decisionRevisionId: null,
          settlementEventId: null,
          allocationId: null,
          bankDebit: null,
        },
      },
    ]);
    expect(validCardPurchasePage(proposed)).toBe(true);
  });

  test("refuses a combined total, a settlement counted as expense or claimed completeness", () => {
    const combined = purchasePage();
    Object.assign(combined.summary.units[0]!, { total: combined.summary.units[0]!.captured });
    expect(validCardPurchasePage(combined)).toBe(false);
    const expense = clone(purchasePage()) as unknown as { summary: Record<string, unknown> };
    expense.summary.settlementAddsPurchaseExpense = true;
    expect(validCardPurchasePage(expense)).toBe(false);
    const complete = clone(purchasePage()) as unknown as { coverage: Record<string, unknown> };
    complete.coverage.completeTransactionHistory = true;
    expect(validCardPurchasePage(complete)).toBe(false);
    const unknownShape = clone(purchasePage()) as unknown as { coverage: Record<string, unknown> };
    unknownShape.coverage.unsupportedShapes = ["guessed_installment"];
    expect(validCardPurchasePage(unknownShape)).toBe(false);
  });

  test("refuses any figure the contract does not name, at every level", () => {
    const page = purchasePage();
    const unit = page.summary.units[0]!;
    const statement = page.summary.statementTotals[0]!;
    for (const tamper of [
      // A combined total beside the state-separated figures.
      (value: ReturnType<typeof purchasePage>) =>
        Object.assign(value.summary, { total: unit.captured }),
      // A statement-versus-purchases difference beside the provider total.
      (value: ReturnType<typeof purchasePage>) =>
        Object.assign(value.summary.statementTotals[0]!, { difference: statement.total }),
      (value: ReturnType<typeof purchasePage>) =>
        Object.assign(value.items[2]!.statement, { remaining: statement.total }),
      (value: ReturnType<typeof purchasePage>) =>
        Object.assign(value.items[2]!, { unexplained: statement.total }),
      (value: ReturnType<typeof purchasePage>) =>
        Object.assign(value.coverage, { completeUntil: "2026-09" }),
      (value: ReturnType<typeof purchasePage>) =>
        Object.assign(value.items[2]!.settlement!, { purchaseExpense: statement.total }),
    ]) {
      const changed = clone(page);
      tamper(changed);
      expect(validCardPurchasePage(changed)).toBe(false);
    }
    expect(validCardPurchasePage(page)).toBe(true);
  });

  test("only an accepted review carries its settlement event, allocation and bank debit", () => {
    const accepted = capturedPurchase().settlement!;
    const withSettlement = (settlement: Record<string, unknown>) =>
      validCardPurchasePage(
        purchasePage([
          { ...capturedPurchase(), settlement } as unknown as ReturnType<typeof capturedPurchase>,
        ]),
      );
    expect(withSettlement({ ...accepted })).toBe(true);
    expect(withSettlement({ ...accepted, reviewStatus: "proposed" })).toBe(false);
    expect(withSettlement({ ...accepted, reviewStatus: "withdrawn" })).toBe(false);
    expect(withSettlement({ ...accepted, bankDebit: null })).toBe(false);
    expect(withSettlement({ ...accepted, allocationId: null })).toBe(false);
    expect(
      withSettlement({
        ...accepted,
        reviewStatus: "withdrawn",
        settlementEventId: null,
        allocationId: null,
        bankDebit: null,
      }),
    ).toBe(true);
    expect(
      withSettlement({
        ...accepted,
        reviewStatus: "proposed",
        settlementEventId: null,
        allocationId: null,
        bankDebit: null,
      }),
    ).toBe(false);
  });

  test("an unresolved event carries no live amount, and a settlement needs a linked statement", () => {
    const withAmount = purchasePage([{ ...retiredPurchase(), amount: capturedPurchase().amount }]);
    expect(validCardPurchasePage(withAmount)).toBe(false);
    const noReason = purchasePage([{ ...retiredPurchase(), unknownReason: null }]);
    expect(validCardPurchasePage(noReason)).toBe(false);
    const orphan = purchasePage([
      {
        ...capturedPurchase(),
        statement: { status: "unlinked", reasonCode: "statement_not_collected" },
      },
    ]);
    expect(validCardPurchasePage(orphan)).toBe(false);
    const badAmount = clone(purchasePage());
    Object.assign(badAmount.items[0]!.lastKnownAmount!, {
      value: { status: "exact", value: { coefficient: "NaN", scale: 0 } },
    });
    expect(validCardPurchasePage(badAmount)).toBe(false);
    const badId = purchasePage([{ ...capturedPurchase(), eventId: "purchase_1" }]);
    expect(validCardPurchasePage(badId)).toBe(false);
    const badReason = clone(purchasePage()) as unknown as {
      items: { statement: Record<string, unknown> }[];
    };
    badReason.items[0]!.statement = { status: "unlinked", reasonCode: "no_statement_so_zero" };
    expect(validCardPurchasePage(badReason)).toBe(false);
  });

  test("old metadata does not imply the feature and a nonboolean capability is rejected", () => {
    expect(clientFeatures(CENTRAL_STORE_CAPABILITIES).cardPurchaseRecognition).toBe(false);
    expect(
      clientFeatures({ ...CENTRAL_STORE_CAPABILITIES, cardPurchaseRecognition: true })
        .cardPurchaseRecognition,
    ).toBe(true);
    expect(
      validApiCapabilities({ ...CENTRAL_STORE_CAPABILITIES, cardPurchaseRecognition: "true" }),
    ).toBe(false);
    const old = { ...CENTRAL_STORE_CAPABILITIES } as Record<string, unknown>;
    delete old.cardPurchaseRecognition;
    expect(validApiCapabilities(old)).toBe(true);
  });

  test("only the list and a purchase or refund event id open a purchase route", () => {
    const id = `purchase_${"a".repeat(64)}`;
    const refund = `refund_${"b".repeat(64)}`;
    expect(matchRoute("/purchases")).toEqual({ name: "purchases" });
    expect(matchRoute(`/purchases/${id}`)).toEqual({ name: "purchase", eventId: id });
    expect(matchRoute(`/purchases/${refund}`)).toEqual({ name: "purchase", eventId: refund });
    for (const path of [
      `/purchases/${id.toUpperCase()}`,
      `/purchases/event_${"a".repeat(64)}`,
      `/purchases/purchase_${"a".repeat(63)}`,
      `/purchases/${id}/extra`,
      "/purchases/arbitrary",
    ])
      expect(matchRoute(path).name).toBe("notFound");
  });
});

describe("pending-to-posted review from the web client", () => {
  test("the pages the browser tests serve are pages the client accepts", () => {
    for (const items of [
      [{ ...capturedPurchase(), candidates: [linkCandidate()] }],
      [authorizedPendingPurchase()],
      [mergedPurchase()],
    ])
      expect(validApiResponse(path, purchasePage(items))).toBe(true);
  });

  test("a plan request carries the candidate's relation unchanged, plus the reason", () => {
    const candidate = linkCandidate();
    for (const [action, kind] of [
      ["accept", "relation.accept"],
      ["reject", "relation.reject"],
      ["withdraw", "relation.reject"],
    ] as const)
      expect(purchaseLinkPlanRequest(candidate, action, "確認した")).toEqual({
        kind,
        payload: { ...candidate.relation, reason: "確認した" },
        baseContextId: `card-purchase-link:${candidate.proposalId}`,
      });
    // A planned reject of an accepted link is its withdrawal.
    expect(purchaseLinkAction("relation.accept", candidate)).toBe("accept");
    expect(purchaseLinkAction("relation.reject", candidate)).toBe("reject");
    expect(purchaseLinkAction("relation.reject", mergedCandidate())).toBe("withdraw");
    expect(purchaseLinkAction("identity.assign", candidate)).toBeNull();
  });

  test("a plan matches only when it pins every subject of the candidate at the candidate's revision", () => {
    const candidate = authorizedCandidate();
    const pins = linkPlanPins(candidate);
    // The proposal, the relation triple and both held events, whatever the action.
    expect(Object.keys(pins)).toHaveLength(4);
    expect(purchaseLinkPinsMatch(pins, candidate)).toBe(true);
    for (const ref of Object.keys(pins)) {
      expect(purchaseLinkPinsMatch({ ...pins, [ref]: pins[ref]! + 1 }, candidate)).toBe(false);
      const without = Object.fromEntries(Object.entries(pins).filter(([key]) => key !== ref));
      expect(purchaseLinkPinsMatch(without, candidate)).toBe(false);
    }
    // A merged link pins its one event once; the absorbed event pinned at 0 is the server's to check.
    const merged = mergedCandidate();
    const mergedPins = { ...linkPlanPins(merged), [`card-purchase:${POSTED_EVENT}`]: 0 };
    expect(Object.keys(linkPlanPins(merged))).toHaveLength(3);
    expect(purchaseLinkPinsMatch(mergedPins, merged)).toBe(true);
  });

  test("the confirmation screen finds the proposal and a live purchase among the planned subjects", () => {
    const merged = mergedCandidate();
    const expected = { ...linkPlanPins(merged), [`card-purchase:${POSTED_EVENT}`]: 0 };
    const subjects = Object.keys(expected);
    expect(plannedProposalId(subjects)).toBe(merged.proposalId);
    // The absorbed posted event has no live revision (and no page); the survivor is read.
    expect(plannedPurchaseEventId([...subjects].reverse(), expected)).toBe(PENDING_EVENT);
    expect(plannedPurchaseEventId(["card-purchase:event_other"], {})).toBeNull();
    expect(plannedProposalId(["proposal:a", "proposal:b"])).toBeNull();
    expect(plannedProposalId(["relation:x"])).toBeNull();
  });
});
