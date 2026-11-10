import { expect, test } from "bun:test";
import type { ArtifactMeta, ValuationObservation } from "../src/types.ts";
import { sbiIncomePayments, sbiRealisedGains } from "../src/parsers/sbi-income-history.ts";
import {
  auditIncomeJson,
  incomeDecimal,
  readIncomeJson,
  validateIncomeHistory,
} from "../src/parsers/sbi-income-history-schema.ts";
import { incomeBundle } from "./fixtures/sbi-income.ts";

const meta = (dataset: string): ArtifactMeta => ({
  id: 1,
  sourceId: "sbi-securities",
  runStatus: "success",
  runFailureCount: 0,
  dataset,
  url: null,
  mime: "application/json",
  fetchedAt: "2099-12-31T00:00:00Z",
  sha256: "synthetic",
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test("one logical payment per original currency; yen equivalents and cash/trades emit no second income", () => {
  const bundle = incomeBundle("income");
  const result = sbiIncomePayments.parse(bytes(bundle), meta("income-payments"));
  expect(result.observations).toHaveLength(15);
  expect(result.observations.every((row) => row.kind === "valuation")).toBe(true);
  const nets = result.observations.filter(
    (row): row is ValuationObservation => row.kind === "valuation" && row.metric === "income_net",
  );
  expect(nets.map((row) => [row.currency, row.amountMinor])).toEqual([
    ["JPY", 14],
    ["USD", 29],
    ["USD", 29],
  ]);
  expect(new Set(nets.map((row) => row.kind === "valuation" && row.subject)).size).toBe(3);
  expect(
    sbiIncomePayments.parse(bytes(bundle), {
      ...meta("income-payments"),
      id: 2,
      fetchedAt: "2100-01-01T00:00:00Z",
    }).observations,
  ).toEqual(result.observations);
});

test("equivalent numeric spelling, labels and yen equivalents do not split original-currency payment identity", () => {
  const bundle = incomeBundle("income");
  const before = sbiIncomePayments.parse(bytes(bundle), meta("income-payments"))
    .observations as ValuationObservation[];
  bundle.rowsText = bundle.rowsText
    .replaceAll('"receivedAmountLc":0.29', '"receivedAmountLc":2.900e-1')
    .replaceAll('"productName":"Synthetic security"', '"productName":"Synthetic renamed security"')
    .replaceAll('"receivedAmount":14', '"receivedAmount":99');
  const after = sbiIncomePayments.parse(bytes(bundle), meta("income-payments"))
    .observations as ValuationObservation[];
  expect(after.filter((o) => o.currency === "USD").map((o) => o.subject)).toEqual(
    before.filter((o) => o.currency === "USD").map((o) => o.subject),
  );
});

test("sale metrics keep provider amounts and per-unit values, without recomputing gains", () => {
  const result = sbiRealisedGains.parse(bytes(incomeBundle("gains")), meta("realised-gains"));
  expect(
    result.observations.map(
      (row) => row.kind === "valuation" && [row.metric, row.amountText, row.amountMinor],
    ),
  ).toEqual([
    ["sale_proceeds", "120", 120],
    ["realised_gain_before_tax", "20", 20],
    ["sale_unit_price", "12.3456", undefined],
    ["average_acquisition_unit_cost", "10.1234", undefined],
  ]);
});

test("exact numeric tokens survive notation and binary rounding edges", () => {
  expect(incomeDecimal("2.9e-1")).toBe("0.29");
  expect(incomeDecimal("0.99999999999999999")).toBe("0.99999999999999999");
  const bundle = incomeBundle("income");
  bundle.rowsText = bundle.rowsText.replace(
    '"receivedAmountLc":0.29',
    '"receivedAmountLc":0.99999999999999999',
  );
  expect(() => validateIncomeHistory(bundle, "income")).toThrow("sbi_income_history_money");
  bundle.rowsText = incomeBundle("income").rowsText.replace('"quantity":10', '"quantity":10e0e0');
  expect(() => validateIncomeHistory(bundle, "income")).toThrow("sbi_income_history_schema");
  expect(() => incomeDecimal("1e-100000")).toThrow("sbi_income_history_money");
});

test("missing payment money is unavailable, never a zero metric", () => {
  const bundle = incomeBundle("income");
  bundle.rowsText = bundle.rowsText.replace('"taxTotal":6', '"taxTotal":null');
  const result = sbiIncomePayments.parse(bytes(bundle), meta("income-payments"));
  expect(result.observations).toHaveLength(14);
  expect(result.issues?.map((issue) => issue.message)).toEqual([
    "sbi_income_history_metric_unavailable",
  ]);
});

test("unused domestic Lc numeric metadata does not invent another currency payment", () => {
  const bundle = incomeBundle("income");
  bundle.rowsText = bundle.rowsText.replace(
    '"receivedAmountLc":null',
    '"receivedAmountLc":0.1234567890123456789',
  );
  const result = sbiIncomePayments.parse(bytes(bundle), meta("income-payments"));
  const domestic = result.observations.filter(
    (row) => row.kind === "valuation" && row.currency === "JPY",
  );
  expect(domestic).toHaveLength(5);
  expect(domestic[0]!.extra["receivedAmountLc"]).toBe("0.1234567890123456789");
});

test("duplicate decoded keys, nested secrets, original strings and malformed grammar fail before audit", () => {
  const original = incomeBundle("income").rowsText;
  for (const text of [
    '{"dividends":{"accessToken":"SYNTHETIC_SENTINEL"},' + original.slice(1),
    '{"divid\\u0065nds":{"accessToken":"SYNTHETIC_SENTINEL"},' + original.slice(1),
    original.replace(
      '"quantity":10',
      '"quantity":{"accessToken":"SYNTHETIC_SENTINEL"},"quantity":10',
    ),
    original.replace('"quantity":10', '"quantity":"10"'),
    original.replace('"quantity":10', '"quantity":10.0.0'),
  ]) {
    try {
      auditIncomeJson(readIncomeJson(text), "income", "rows");
      throw new Error("unexpected acceptance");
    } catch (error) {
      expect((error as Error).message).toBe("sbi_income_history_schema");
      expect((error as Error).cause).toBeUndefined();
    }
  }
});

test("unknown products/accounts/currencies, inconsistent controls and unobserved continuation are closed", () => {
  for (const [old, replacement, code] of [
    ['"category":"DOMESTIC_STOCK_SPOT"', '"category":"FUND"', "unknown_code"],
    ['"accountType":"NISA_GROWTH"', '"accountType":"NISA_RESERVE"', "unknown_code"],
    ['"currencyCode":"USD"', '"currencyCode":"EUR"', "unknown_code"],
  ]) {
    const bundle = incomeBundle("income");
    bundle.rowsText = bundle.rowsText.replace(old!, replacement!);
    expect(() => validateIncomeHistory(bundle, "income")).toThrow(`sbi_income_history_${code}`);
  }
  const count = incomeBundle("income");
  count.summaryText = count.summaryText.replace('"countTotal":3', '"countTotal":4');
  expect(() => validateIncomeHistory(count, "income")).toThrow("sbi_income_history_count");
  const continuation = incomeBundle("gains");
  continuation.summaryText = continuation.summaryText.replaceAll('"total":1', '"total":31');
  expect(() => validateIncomeHistory(continuation, "gains")).toThrow(
    "sbi_income_history_pagination_unobserved",
  );
  const all = incomeBundle("gains");
  all.allSummaryText = all.allSummaryText!.replace(
    '"assetsBalanceCategory":"DOMESTIC_STOCK_SPOT"',
    '"assetsBalanceCategory":"FOREIGN_STOCK_US"',
  );
  expect(() => validateIncomeHistory(all, "gains")).toThrow("sbi_income_history_unknown_code");
});
