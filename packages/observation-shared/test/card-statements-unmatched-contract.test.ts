// The wire contract of statements without a candidate against its server
// bound (ADR 0074, amendment 2026-11-07, "a bounded list of allocations"): a
// planner answer lists at most `CARD_STATEMENT_ALLOCATION_LISTED_MAX`
// allocations beside their count, and a list shorter than its count must say
// it is truncated. Every value is invented.
import { expect, test } from "bun:test";
import {
  CARD_STATEMENT_ALLOCATION_LISTED_MAX,
  CARD_STATEMENT_ALLOCATION_SIZE_MAX,
} from "../../domain/src/card-settlement-allocation.ts";
import { validApiResponse } from "../src/api-validation.ts";
import {
  CARD_STATEMENTS_UNMATCHED_PATH,
  validUnmatchedCardStatementsReview,
} from "../src/card-statements-unmatched-contract.ts";

const yen = (coefficient: string) => ({
  unitRef: "JPY",
  value: {
    status: "exact",
    value: { coefficient, scale: 0 },
    normalizationVersion: "exact-arith-v1",
  },
});
const member = (id: number) => ({
  ref: { kind: "transaction", id: `transaction:${id}`, revision: "parse_run:6" },
  sourceId: "smbc-bank",
  sourceAccount: "synthetic-bank",
  accountId: null,
  amount: yen("1000"),
});
const allocation = (first: number, size = 3) => ({
  kind: size === 1 ? "single-debit" : "multiple-debits",
  ownership: "unknown",
  rejectionConditions: ["owner_not_established"],
  members: Array.from({ length: size }, (_, index) => member(first + index)),
});
const allocations = (n: number) => Array.from({ length: n }, (_, index) => allocation(index + 1));

function page(planner: unknown) {
  return {
    apiVersion: 2,
    schemaVersion: "kogane-card-statements-unmatched-v1",
    query: { offset: 0 },
    manifest: { acceptance: "single-debit-candidates-only" },
    items: [
      {
        statement: {
          ref: { kind: "balance", id: "balance:21", revision: "parse_run:5" },
          sourceId: "myjcb",
          sourceAccount: "synthetic-card",
          accountId: null,
          amount: yen("3000"),
          paymentDate: null,
          period: "2098-01",
        },
        code: "no_equal_amount_debit",
        debitsInWindow: 32,
        planner,
        acceptable: false,
      },
    ],
    nextOffset: null,
    nextPage: "none",
  };
}
const review = (listed: number, count: number, truncated: boolean) =>
  page({
    status: "needs_review",
    codes: ["candidate_not_unique"],
    allocations: allocations(listed),
    allocationCount: count,
    allocationsTruncated: truncated,
  });

test("the bounds are the domain's: 50 listed, three debits each", () => {
  expect(CARD_STATEMENT_ALLOCATION_LISTED_MAX).toBe(50);
  expect(CARD_STATEMENT_ALLOCATION_SIZE_MAX).toBe(3);
});

test("accepts a whole list and a truncated one that says so", () => {
  for (const value of [
    review(2, 2, false),
    review(50, 50, false),
    review(50, 51, true),
    review(50, 4960, true),
    page({
      status: "proposed",
      codes: [],
      allocations: allocations(1),
      allocationCount: 1,
      allocationsTruncated: false,
    }),
    page({
      status: "unsupported",
      codes: ["no_exact_allocation"],
      allocations: [],
      allocationCount: 0,
      allocationsTruncated: false,
    }),
    page({ status: "run_refused", code: "input_bound_exceeded" }),
    page(null),
  ]) {
    expect(validUnmatchedCardStatementsReview(value)).toBe(true);
    expect(validApiResponse(CARD_STATEMENTS_UNMATCHED_PATH, value)).toBe(true);
  }
});

test("refuses a list past the bound, a hidden remainder, a false marker or no count", () => {
  for (const value of [
    // Past the server's bound, whatever the count says.
    review(51, 51, false),
    review(51, 51, true),
    // A shorter list than its count that does not say so: hidden silently.
    review(50, 51, false),
    review(2, 3, false),
    // Truncated below the bound, or marked truncated with nothing left out.
    review(2, 3, true),
    review(50, 50, true),
    // More listed than counted.
    review(3, 2, false),
    // No count or no marker (the answer before the bound).
    page({ status: "needs_review", codes: [], allocations: allocations(2) }),
    page({
      status: "needs_review",
      codes: [],
      allocations: allocations(2),
      allocationCount: 2,
    }),
    page({
      status: "needs_review",
      codes: [],
      allocations: allocations(2),
      allocationCount: "2",
      allocationsTruncated: false,
    }),
    // A proposal is one allocation; an unsupported answer none.
    page({
      status: "proposed",
      codes: [],
      allocations: allocations(2),
      allocationCount: 2,
      allocationsTruncated: false,
    }),
    page({
      status: "unsupported",
      codes: [],
      allocations: [],
      allocationCount: 1,
      allocationsTruncated: true,
    }),
    // A member past the size bound.
    page({
      status: "needs_review",
      codes: [],
      allocations: [allocation(1, 4), allocation(5)],
      allocationCount: 2,
      allocationsTruncated: false,
    }),
  ])
    expect(validUnmatchedCardStatementsReview(value)).toBe(false);
});

test("a page's end carries its reason: the last statement, or the reader's budget", () => {
  const base = review(2, 2, false);
  for (const [nextOffset, nextPage, valid] of [
    [null, "none", true],
    [null, "budget_exceeded", true],
    [50, "offered", true],
    [1000, "offered", true],
    // No reason, or a reason the page does not know.
    [null, undefined, false],
    [null, "end", false],
    [50, undefined, false],
    // An offset beside a reason that withholds it, or none where one is offered.
    [50, "none", false],
    [1000, "budget_exceeded", false],
    [null, "offered", false],
    // Not one page in, or not a count.
    [0, "offered", false],
    [49, "offered", false],
    [50.5, "offered", false],
    ["50", "offered", false],
  ] as const) {
    const value = { ...base, nextOffset, nextPage };
    expect({ nextOffset, nextPage, valid: validUnmatchedCardStatementsReview(value) }).toEqual({
      nextOffset,
      nextPage,
      valid,
    });
    expect(validApiResponse(CARD_STATEMENTS_UNMATCHED_PATH, value)).toBe(valid);
  }
});
