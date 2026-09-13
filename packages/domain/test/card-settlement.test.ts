import { test, expect } from "bun:test";
import {
  cardSettlementCandidate,
  cardSettlementEligible,
  cardSettlementImpact,
  validCardSettlementFacts,
  type CardStatementFact,
  type CardBankDebitFact,
} from "../src/card-settlement.ts";
import { exactQuantity, integerDecimal, normalizeDecimal } from "../src/values.ts";
const time = {
  kind: "local-date",
  value: "2026-09-10",
  zone: "Asia/Tokyo",
  basis: "provider",
} as const;
const statement: CardStatementFact = {
  ref: { kind: "balance", id: "balance:1", revision: "parse_run:1" },
  sourceId: "vpass",
  sourceAccount: "card",
  accountId: "a",
  ownerRef: "party:p",
  amount: exactQuantity("JPY", integerDecimal(3000)),
  paymentDate: time,
  period: "2026-09",
};
const bank: CardBankDebitFact = {
  ref: { kind: "transaction", id: "transaction:2", revision: "parse_run:2" },
  sourceId: "smbc-bank",
  sourceAccount: "bank",
  accountId: "b",
  ownerRef: "party:p",
  amount: statement.amount,
  occurred: time,
};
test("candidate is never acceptance; cash/purchases are already observed and principal reduction is unknown", () => {
  const facts = cardSettlementCandidate(statement, bank, ["proof"])!;
  expect(cardSettlementEligible(facts)).toBe(true);
  expect(cardSettlementImpact(facts, "proposed")).toMatchObject({
    allocationState: "proposed",
    liabilityBalanceDelta: null,
    netWorthDelta: null,
  });
  expect(cardSettlementImpact(facts, "accepted").addedPurchaseExpense).toEqual(
    exactQuantity("JPY", integerDecimal(0)),
  );
  expect(cardSettlementImpact(facts, "withdrawn").liabilityAllocation).toEqual(
    exactQuantity("JPY", integerDecimal(0)),
  );
});
test("unknown owners stay reviewable but ineligible; unit/amount/date mismatches cannot become candidates", () => {
  expect(
    cardSettlementEligible(cardSettlementCandidate({ ...statement, ownerRef: null }, bank)!),
  ).toBe(false);
  expect(
    cardSettlementCandidate(statement, {
      ...bank,
      amount: exactQuantity("USD", integerDecimal(3000)),
    }),
  ).toBeNull();
  expect(
    cardSettlementCandidate(statement, { ...bank, occurred: { ...time, value: "2026-09-14" } }),
  ).toBeNull();
  expect(
    cardSettlementCandidate(
      { ...statement, paymentDate: { kind: "unknown", reasonCode: "not_reported" } },
      bank,
    ),
  ).toBeNull();
  expect(
    validCardSettlementFacts({ statement: { ...statement, paymentDate: null }, bankDebit: bank }),
  ).toBe(false);
});
test("different decimal scales compare exactly and malformed fractions never use binary floating point", () => {
  const a = { ...statement, amount: exactQuantity("JPY", normalizeDecimal(30000n, 1)) };
  expect(cardSettlementCandidate(a, bank)).not.toBeNull();
  expect(
    cardSettlementCandidate(statement, {
      ...bank,
      amount: exactQuantity("JPY", { coefficient: "30000000000000000000000000001", scale: 25 }),
    }),
  ).toBeNull();
});
