import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCardInventory, parseStatementPeriods, redactedStatementHtml } from "../src/parsers";

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
});
