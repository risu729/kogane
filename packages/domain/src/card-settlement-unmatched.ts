// Why a card statement has no settlement candidate (docs/card-settlements.md,
// Unmatched statements; ADR 0009's 2026-11-06 amendment, ADR 0074's
// 2026-11-07 amendment). One closed code per statement, decided only from the
// statement itself and the bank rows the sweep's own read returns for its
// window, so the sweep's tick counts and the review read agree.
//
// Pure: no storage, no clock. No amount, date or provider text leaves here.
import { validQuantity, type Quantity } from "./values.ts";
import type { CardStatementAllocationPolicy } from "./card-settlement-allocation.ts";

/**
 * The codes the sweep counts per tick and the review read names per
 * statement, in the order they are checked:
 *
 * - `statement_total_refund_or_zero`: an exact total of zero or below (a
 *   refund or a month with nothing to pay). The positive-debit matcher never
 *   compares one, and refund allocation is not modelled (ADR 0004, #548);
 * - `statement_not_comparable`: no exact total with a valid unit, no valid due
 *   date or no period, so no debit can be compared with it;
 * - `no_debit_in_window`: the bank read around its due date returned no row;
 * - `no_equal_amount_debit`: it returned rows, and none has an exact amount
 *   equal to the total.
 */
export const CARD_SETTLEMENT_UNMATCHED_CODES = [
  "statement_total_refund_or_zero",
  "statement_not_comparable",
  "no_debit_in_window",
  "no_equal_amount_debit",
] as const;
export type CardSettlementUnmatchedCode = (typeof CARD_SETTLEMENT_UNMATCHED_CODES)[number];

/**
 * The code the review read names per statement without a candidate: the
 * sweep's, or `equal_amount_debit_awaiting_sweep` when its window holds a
 * debit the sweep's matcher would pair with it, so a candidate appears on the
 * sweep's next pass over it.
 */
export const UNMATCHED_STATEMENT_CODES = [
  ...CARD_SETTLEMENT_UNMATCHED_CODES,
  "equal_amount_debit_awaiting_sweep",
] as const;
export type UnmatchedStatementCode = (typeof UNMATCHED_STATEMENT_CODES)[number];

/** An exact total of zero or below: a refund or nothing to pay. */
export function refundOrZeroTotal(total: Quantity | null): boolean {
  return (
    total !== null &&
    validQuantity(total) &&
    total.value.status === "exact" &&
    BigInt(total.value.value.coefficient) <= 0n
  );
}

/** A total the positive-debit matcher can compare: exact, valid and above zero. */
export function comparableTotal(total: Quantity | null): total is Quantity {
  return (
    total !== null &&
    validQuantity(total) &&
    total.value.status === "exact" &&
    BigInt(total.value.value.coefficient) > 0n
  );
}

/**
 * The code for a statement that yielded no candidate. `datedAndPeriod`: it has
 * a valid due date and a period. `bankRows`: how many rows the window read
 * returned, or null when no read was made.
 */
export function unmatchedStatementCode(
  total: Quantity | null,
  datedAndPeriod: boolean,
  bankRows: number | null,
): CardSettlementUnmatchedCode {
  if (refundOrZeroTotal(total)) return "statement_total_refund_or_zero";
  if (!comparableTotal(total) || !datedAndPeriod) return "statement_not_comparable";
  return bankRows === null || bankRows === 0 ? "no_debit_in_window" : "no_equal_amount_debit";
}

/**
 * The owner's policy for the read-only planner answer on statements without
 * a candidate (owner, 2026-11-07 03:58 UTC, Phase 2 plan question 3): the
 * sweep's own window of three days either side of the due date, and at most
 * three debits per allocation. Display only: no lane, table or writer uses
 * it, and no allocation it lists can be accepted.
 */
export const CARD_STATEMENT_UNMATCHED_ALLOCATION_POLICY: CardStatementAllocationPolicy = {
  policyVersion: "card-statement-unmatched-display-v1",
  window: { minDaysFromDue: -3, maxDaysFromDue: 3 },
  maxDebitsPerAllocation: 3,
};
