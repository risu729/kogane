// Array bounds of the browser's wire validators against what the server can
// legally return. A validator stricter than its server makes the page show a
// format error in place of data the server was right to send, so each bound
// here is the server's own: a legal answer at the server's limit is accepted,
// and one past it is still refused. Synthetic values only.
import { describe, expect, test } from "bun:test";
import { purchasePage } from "../../application/test/card-purchase-view-fixture.ts";
import { CARD_PURCHASE_SUMMARY_LIMIT } from "../../application/src/query/card-purchases.ts";
import {
  CARD_STATEMENT_ALLOCATION_DEBITS_MAX,
  CARD_STATEMENT_ALLOCATION_LISTED_MAX,
  CARD_STATEMENT_ALLOCATION_SIZE_MAX,
  planCardStatementAllocations,
  type AllocationDebitInput,
  type StatementAllocationOutcome,
} from "../../domain/src/card-settlement-allocation.ts";
import { CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY } from "../../domain/src/card-settlement-unmatched.ts";
import { exactQuantity, integerDecimal } from "../../domain/src/values.ts";
import {
  CARD_PURCHASE_STATEMENT_TOTALS_LIMIT,
  validCardPurchasePage,
} from "../src/card-purchase-contract.ts";
import {
  UNMATCHED_ALLOCATIONS_LIMIT,
  validUnmatchedCardStatementsReview,
} from "../src/card-statements-unmatched-contract.ts";

const yen = (amount: number) => exactQuantity("JPY", integerDecimal(amount));
const day = (value: string) =>
  ({ kind: "local-date", value, zone: "Asia/Tokyo", basis: "provider" }) as const;

describe("card purchase statement totals", () => {
  // `queryCardPurchases` lists one statement per (account, source, period) of
  // the filter's posted events, uncapped, and refuses only past
  // `CARD_PURCHASE_SUMMARY_LIMIT` live events: every listed statement rests
  // on at least one of them.
  const withTotals = (count: number) => {
    const page = purchasePage();
    const template = page.summary.statementTotals[0]!;
    page.summary.statementTotals = Array.from({ length: count }, (_, index) => ({
      ...template,
      accountId: `acct-card-${index}`,
      ref: { kind: "balance" as const, id: `balance:${index + 1}`, revision: "parse_run:8" },
    }));
    return page;
  };

  test("the bound is the server's event limit", () => {
    expect(CARD_PURCHASE_STATEMENT_TOTALS_LIMIT).toBe(CARD_PURCHASE_SUMMARY_LIMIT);
  });

  test("accepts more than a thousand statements, as the server may list", () => {
    expect(validCardPurchasePage(withTotals(1_001))).toBe(true);
    expect(validCardPurchasePage(withTotals(CARD_PURCHASE_SUMMARY_LIMIT))).toBe(true);
  });

  test("refuses more statements than the server can have events", () => {
    expect(validCardPurchasePage(withTotals(CARD_PURCHASE_SUMMARY_LIMIT + 1))).toBe(false);
  });
});

describe("unmatched statement planner allocations", () => {
  // The display policy plans up to three debits per allocation over at most
  // 32 debits a run, and counts every exact allocation it finds: 32 debits of
  // a third of the statement total give C(32, 3) of them. It lists the first
  // `CARD_STATEMENT_ALLOCATION_LISTED_MAX` (ADR 0074, amendment 2026-11-07).
  const debits: AllocationDebitInput[] = Array.from(
    { length: CARD_STATEMENT_ALLOCATION_DEBITS_MAX },
    (_, index) => ({
      bankKey: `["synthetic-bank","synthetic-account","transaction",${index + 1}]`,
      aliasClass: `["synthetic-bank",["synthetic-row-${index + 1}"],"acct-bank"]`,
      debit: {
        ref: {
          kind: "transaction",
          id: `transaction:${index + 1}`,
          revision: `parse_run:${index + 100}`,
        },
        sourceId: "smbc-bank",
        sourceAccount: "smbc-bank:synthetic-account",
        accountId: "acct-bank",
        ownerRef: "party:synthetic-owner",
        amount: yen(1_000),
        occurred: day("2026-09-10"),
      },
    }),
  );
  const statement = {
    ref: { kind: "balance" as const, id: "balance:1", revision: "parse_run:1" },
    sourceId: "vpass" as const,
    sourceAccount: "vpass:synthetic-card",
    accountId: "acct-card",
    ownerRef: "party:synthetic-owner",
    amount: yen(3_000),
    paymentDate: day("2026-09-10"),
    period: "2026-09",
  };

  /** The planner's own answer, mapped as `card-statements-unmatched.ts` maps it. */
  function plannerAnswer(): Exclude<StatementAllocationOutcome, { status: "refused" }> {
    const run = planCardStatementAllocations({
      statements: [{ statement, statementKey: '["vpass","synthetic-card","2026-09"]' }],
      debits,
      policy: CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY,
      held: { bankKeys: [], aliasClasses: [], statementKeys: [] },
    });
    if (!run.ok) throw new Error(run.refusal);
    const outcome = run.statements[0]!.outcome;
    if (outcome.status === "refused") throw new Error(outcome.code);
    return outcome;
  }

  const review = (outcome: Exclude<StatementAllocationOutcome, { status: "refused" }>) => ({
    schemaVersion: "kogane-card-statements-unmatched-v1",
    manifest: { acceptance: "single-debit-candidates-only" },
    items: [
      {
        statement: {
          ref: statement.ref,
          sourceId: statement.sourceId,
          sourceAccount: statement.sourceAccount,
          accountId: statement.accountId,
          period: statement.period,
          amount: statement.amount,
          paymentDate: statement.paymentDate,
        },
        code: "no_equal_amount_debit",
        debitsInWindow: debits.length,
        acceptable: false,
        planner: {
          status: outcome.status,
          codes: [...outcome.codes],
          allocations: outcome.allocations.map((allocation) => ({
            kind: allocation.kind,
            members: allocation.members.map((member) => ({
              ref: member.ref,
              sourceId: member.sourceId,
              sourceAccount: member.sourceAccount,
              accountId: member.accountId,
              amount: member.allocated,
            })),
            ownership: allocation.ownership,
            rejectionConditions: [...allocation.rejectionConditions],
          })),
          allocationCount: outcome.allocationCount,
          allocationsTruncated: outcome.allocationsTruncated,
        },
      },
    ],
    nextOffset: null,
    nextPage: "none",
  });

  test("the count's bound is every allocation one run can find", () => {
    const choose = (n: number, k: number): number => (k === 0 ? 1 : (choose(n - 1, k - 1) * n) / k);
    let expected = 0;
    for (let size = 1; size <= CARD_STATEMENT_ALLOCATION_SIZE_MAX; size++)
      expected += choose(CARD_STATEMENT_ALLOCATION_DEBITS_MAX, size);
    expect(UNMATCHED_ALLOCATIONS_LIMIT).toBe(expected);
  });

  test("accepts the planner's answer counting more than a thousand allocations", () => {
    const outcome = plannerAnswer();
    expect(outcome.status).toBe("needs_review");
    expect(outcome.allocationCount).toBe(4_960);
    expect(outcome.allocations.length).toBe(CARD_STATEMENT_ALLOCATION_LISTED_MAX);
    expect(validUnmatchedCardStatementsReview(review(outcome))).toBe(true);
  });

  test("refuses more allocations listed than the server lists", () => {
    const outcome = plannerAnswer();
    const body = review(outcome);
    const planner = body.items[0]!.planner;
    const first = planner.allocations[0]!;
    planner.allocations = Array.from(
      { length: CARD_STATEMENT_ALLOCATION_LISTED_MAX + 1 },
      () => first,
    );
    expect(validUnmatchedCardStatementsReview(body)).toBe(false);
  });

  test("refuses a count above what one run can find", () => {
    const outcome = plannerAnswer();
    const body = review(outcome);
    body.items[0]!.planner.allocationCount = UNMATCHED_ALLOCATIONS_LIMIT;
    expect(validUnmatchedCardStatementsReview(body)).toBe(true);
    body.items[0]!.planner.allocationCount = UNMATCHED_ALLOCATIONS_LIMIT + 1;
    expect(validUnmatchedCardStatementsReview(body)).toBe(false);
  });
});
