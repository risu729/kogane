import { INCOME_HISTORY_SCHEMA, type IncomeHistoryKind, type IncomeHistoryBundle } from "../../src/parsers/sbi-income-history-schema.ts";

export function incomeRow(foreign = false): Record<string, unknown> {
  return {
    category: foreign ? "FOREIGN_STOCK_US" : "DOMESTIC_STOCK_SPOT",
    dispositionDate: "20990903", accountType: "NISA_GROWTH", productCode: foreign ? "SYNTH" : "1234", productName: "Synthetic security", quantity: 10,
    interestAmount: null, dividendUnitCost: 2, dividendTotal: 20, specialDividend: null, taxTotal: 6, incomeTax: 4, residentTax: 2, receivedAmount: 14,
    interestAmountLc: null, dividendUnitCostLc: foreign ? 0.03 : null, dividendTotalLc: foreign ? 0.3 : null, specialDividendLc: null, taxTotalLc: foreign ? 0.01 : null, incomeTaxLc: foreign ? 0.01 : null, residentTaxLc: foreign ? 0 : null, receivedAmountLc: foreign ? 0.29 : null, currencyCode: foreign ? "USD" : null,
  };
}
export function incomeFixture() {
  const dividends = [incomeRow(), incomeRow(true), incomeRow(true)];
  return {
    rows: { dividends },
    summary: { dividendsSummaries: [
      { receivedTotal: 14, dividendTotal: 20, taxTotal: 6, receivedTotalLc: null, dividendTotalLc: null, taxTotalLc: null, count: 1, currencyCode: null, category: "DOMESTIC_STOCK_SPOT" },
      { receivedTotal: 28, dividendTotal: 40, taxTotal: 12, receivedTotalLc: 0.58, dividendTotalLc: 0.6, taxTotalLc: 0.02, count: 2, currencyCode: "USD", category: "FOREIGN_STOCK_US" },
    ], receivedTotal: 42, countTotal: 3 },
  };
}
export function gainFixture() {
  return {
    rows: { profitLosses: [{ category: "DOMESTIC_STOCK_SPOT", contractDate: "20990901", dispositionDate: "20990903", accountType: "NISA_GROWTH", productCode: "1234", productName: "Synthetic security", transactionType: "SELL", quantity: 10, amount: 120, price: 12.3456, acquisitionCost: 10.1234, profitLoss: 20 }] },
    summary: { profitLossSummary: { assetsErrorType: null, total: 1, profitLoss: 20, profit: 20, loss: 0, profitLossLc: 0, profitLc: 0, lossLc: 0 }, profitLossSummaryDetails: [{ assetsErrorType: null, assetsBalanceCategory: "DOMESTIC_STOCK_SPOT", total: 1, profitLoss: 20, profit: 20, loss: 0, profitLossLc: null, profitLc: null, lossLc: null, currencyCode: null }] },
  };
}
export function incomeBundle(kind: IncomeHistoryKind): IncomeHistoryBundle {
  const fixture = kind === "income" ? incomeFixture() : gainFixture();
  return { schemaVersion: INCOME_HISTORY_SCHEMA, kind, requestedRange: { from: "2021-08-01", to: "2099-12-31" }, summaryText: JSON.stringify(fixture.summary), rowsText: JSON.stringify(fixture.rows), allSummaryText: kind === "gains" ? JSON.stringify(fixture.summary) : null };
}
