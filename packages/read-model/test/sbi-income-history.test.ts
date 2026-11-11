import { expect, test } from "bun:test";
import { sbiIncomeHistorySql, type SbiIncomeHistoryQuery } from "../src/sbi-income-history.ts";

test("income reader refuses invalid scopes, metrics, date ranges and unbounded pages", () => {
  for (const value of [
    { kind: "other", offset: 0 },
    { kind: "income", metric: "sale_proceeds", offset: 0 },
    { kind: "gains", currency: "EUR", offset: 0 },
    { kind: "income", account: "sbi-securities:gains:NISA_GROWTH", offset: 0 },
    { kind: "income", from: "2099-02-30", offset: 0 },
    { kind: "income", from: "2099-12-31", to: "2099-01-01", offset: 0 },
    { kind: "income", offset: -1 },
    { kind: "income", offset: Infinity },
  ])
    expect(() => sbiIncomeHistorySql(value as SbiIncomeHistoryQuery)).toThrow(
      "sbi_income_history_query_invalid",
    );
});
