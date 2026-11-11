import { expect, test } from "bun:test";
import {
  portfolioValuationHistorySql,
  type PortfolioValuationHistoryQuery,
} from "../src/portfolio-valuation-history";

test("weekly history query rejects unsupported profiles, categories, dates and page inputs", () => {
  const valid: PortfolioValuationHistoryQuery = { profile: "full", offset: 0 };
  for (const patch of [
    { profile: "without-ideco" },
    { category: "UNKNOWN" },
    { metric: "profit_loss_rate" },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { from: "2099-02-29" },
    { to: "2099-01-01' OR 1=1" },
    { from: "2099-01-10", to: "2099-01-03" },
  ])
    expect(() =>
      portfolioValuationHistorySql({ ...valid, ...patch } as PortfolioValuationHistoryQuery),
    ).toThrow("portfolio_valuation_history_query_invalid");
  expect(
    portfolioValuationHistorySql({ ...valid, from: "2096-02-29", to: "2096-03-01" }).args,
  ).toEqual(["portfolio:weekly:full:ALL", null, "2096-02-29", "2096-03-01", 0]);
});
