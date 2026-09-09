import { expect, test } from "bun:test";
import { classifyActivity, validActivityMeaning } from "../src/activity-semantics.ts";

test("withdrawal direction is evidence, not the positive raw amount", () => {
  const value = classifyActivity({
    sourceId: "sbi-securities",
    parserName: "sbi-yen-detail-history",
    status: "posted",
    extra: { _kogane: { direction: "debit" } },
  });
  expect(value).toMatchObject({
    kind: "cash_movement",
    direction: "debit",
    statusLabel: "履歴に記録",
  });
  expect(validActivityMeaning(value)).toBe(true);
  expect(
    classifyActivity({
      sourceId: "other",
      parserName: "sbi-yen-detail-history",
      status: "posted",
      extra: { _kogane: { direction: "debit" } },
    }).direction,
  ).toBe("unknown");
});
test("card usage, this month's payment and bank settlement remain separate", () => {
  const input = { sourceId: "myjcb", parserName: "myjcb-credit-ledger", status: "confirmed" };
  const payment = classifyActivity({
    ...input,
    extra: { _kogane: { amountBasis: "current-statement-payment", period: "2026-09" } },
  });
  expect(payment).toMatchObject({
    kind: "statement_item",
    amountLabel: "今回の支払額",
    dateLabel: "利用日",
    period: "2026-09",
  });
  expect(payment.statusLabel).toContain("請求確定");
  expect(
    classifyActivity({
      ...input,
      status: "unconfirmed",
      extra: { _kogane: { amountBasis: "unconfirmed-usage" } },
    }).amountLabel,
  ).toBe("未確定の利用額");
  expect(classifyActivity(input).amountLabel).toContain("未判定");
});
test("trades preserve settlement date and exact quantity/price without inventing cash or P&L", () => {
  const foreign = classifyActivity({
    sourceId: "sbi-securities",
    parserName: "sbi-foreign-trade-records",
    status: "posted",
    extra: { _kogane: { valueDate: "2026-09-10", quantityText: "9007199254740993.001" } },
  });
  expect(foreign).toMatchObject({
    kind: "trade",
    amountLabel: "受渡金額",
    settlementDate: "2026-09-10",
    direction: "unknown",
    quantity: "9007199254740993.001",
  });
  const crypto = classifyActivity({
    sourceId: "sbi-vc-trade",
    parserName: "sbi-vc-executions",
    status: null,
    extra: {
      _kogane: {
        direction: "buy",
        quantity: { text: "0.0001", currency: "BTC" },
        price: { text: "9999999", currency: "JPY" },
      },
    },
  });
  expect(crypto).toMatchObject({
    kind: "trade",
    direction: "buy",
    quantity: "0.0001",
    quantityUnit: "BTC",
    price: "9999999",
    priceUnit: "JPY",
  });
  expect(validActivityMeaning(crypto)).toBe(true);
});
test("notification and malformed evidence cannot become a settled cash movement", () => {
  const value = classifyActivity({
    sourceId: "v-point-pay",
    parserName: "v-point-pay-notification-event",
    status: "declined",
  });
  expect(value).toMatchObject({ kind: "notification", statusLabel: "利用拒否" });
  expect(validActivityMeaning(value)).toBe(true);
  for (const patch of [
    { kind: ["trade"] },
    { direction: ["buy"] },
    { period: 0 },
    { reason: "x".repeat(257) },
    { policyVersion: "future" },
  ])
    expect(validActivityMeaning({ ...value, ...patch })).toBe(false);
});
