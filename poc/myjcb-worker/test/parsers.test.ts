import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  discoverCreditExports,
  extractCreditMenuLinkId,
  extractGeneralJsonDiscriminator,
  parseCardInventory,
  parseCreditMenuMonths,
  parseCreditLedger,
  parsePastMonthAvailability,
  parseStatementPeriods,
  redactedStatementHtml,
} from "../src/parsers";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("MyJCB synthetic parsers", () => {
  test("enumerates pseudonymous cards and statement periods", () => {
    const html = fixture("debit-menu.html");
    expect(parseCardInventory(html).map((card) => card.productHint)).toEqual([
      "JCB W",
      "京銀JCBデビット",
    ]);
    expect(parseStatementPeriods(html).map((period) => period.sequence)).toEqual([0, 1]);
  });

  test("redacts synthetic tokens and card numbers before preservation", () => {
    const redacted = redactedStatementHtml(fixture("debit-detail.html"));
    expect(redacted).not.toContain("synthetic-secret-token");
    expect(redacted).not.toContain("3540 0000 0000 0000");
    expect(redacted).toContain("[redacted]");
    expect(redacted).toContain("架空商店");
  });

  test("enumerates only API-reported available older credit months", () => {
    expect(extractCreditMenuLinkId(fixture("credit-mypage.html")))
      .toBe("synthetic_credit_menu");
    expect(parseCreditMenuMonths(fixture("credit-menu.html"))).toEqual([0, 1, 8]);
    const past = parsePastMonthAvailability(fixture("credit-past.json"));
    expect(past.filter((month) => month.available).map((month) => month.detailMonth))
      .toEqual([10, 13]);
    expect(past.find((month) => month.detailMonth === 10)?.settlementYM)
      .toBe("2025年10月お支払い分");
  });

  test("extracts the hidden discriminator and excludes the notice PDF", () => {
    const html = fixture("credit-detail.html");
    expect(extractGeneralJsonDiscriminator(html)).toBe("synthetic-discriminator");
    expect(discoverCreditExports(html, 10)).toEqual(["csv", "pdf", "ofx"]);
  });

  test("parses confirmed and mutable unconfirmed ledger components", () => {
    const confirmed = parseCreditLedger(fixture("credit-detail.html"), "confirmed");
    expect(confirmed?.rows).toHaveLength(1);
    expect(confirmed?.rows[0]?.summaryCells).toEqual([
      "2026/01/01",
      "架空商店",
      "一回払い",
      "1,000円",
    ]);
    expect(confirmed?.rows[0]?.expanded["ご利用金額"]).toBe("1,000円");

    const unconfirmed = parseCreditLedger(fixture("credit-unconfirmed.html"), "unconfirmed");
    expect(unconfirmed?.rows).toHaveLength(1);
    expect(unconfirmed?.rows[0]?.expanded["今回のお支払い金額"]).toBe("2,000円");
  });
});
