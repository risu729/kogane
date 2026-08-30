import { describe, expect, test } from "bun:test";
import { encode } from "iconv-lite";
import { historySearchBody, parseHistoryRows, parseSessionEnvelope } from "../src/mobile-suica";

describe("Mobile Suica session replay", () => {
  test("validates the source-scoped envelope", () => {
    const envelope = parseSessionEnvelope(JSON.stringify({
      cookieHeader: "ASP.NET_SessionId=a; sc_auth=b; TS0184138d=c",
      formBody: "baseVariable=opaque&specifyYearMonth=2026%2F08&specifyDay=30&SEARCH=%8C%9F%8D%F5",
      userAgent: "test-agent",
    }));
    expect(envelope.userAgent).toBe("test-agent");
  });

  test("preserves the Shift_JIS search label", () => {
    const body = historySearchBody("opaque", "2026-08-31");
    expect(body).toContain("specifyYearMonth=2026%2F08");
    expect(body).toContain("SEARCH=%8C%9F%8D%F5");
  });

  test("parses the eight-column history rows", () => {
    const html = `
      <table><tr><td></td><td>月日</td><td>種別</td><td>利用場所</td><td>種別</td><td>利用場所</td><td>残高</td><td>入金・利用額</td></tr>
      <tr><td><input name="printCheck"></td><td>08/30</td><td>物販</td><td>店舗</td><td></td><td></td><td>\\1,234</td><td>-100</td></tr></table>`;
    const decoded = new TextDecoder("utf-8").decode(encode(html, "utf-8"));
    expect(parseHistoryRows(decoded, "2026-08-31")).toEqual([
      {
        date: "2026-08-30",
        typeFrom: "物販",
        placeFrom: "店舗",
        typeTo: "",
        placeTo: "",
        balanceText: "\\1,234",
        amountText: "-100",
        balance: 1234,
        amount: -100,
        kind: "payment",
      },
    ]);
  });

  test("preserves two identical same-day observations", () => {
    const row = `<tr><td></td><td>08/30</td><td>物販</td><td>店舗</td><td></td><td></td><td>\\1,234</td><td>-100</td></tr>`;
    expect(parseHistoryRows(`<table>${row}${row}</table>`, "2026-08-31")).toHaveLength(2);
  });

  test("does not decode generated entity text a second time", () => {
    const row = `<tr><td></td><td>08/30</td><td>物販</td><td>&amp;#38;</td><td></td><td></td><td>\\1</td><td>-1</td></tr>`;
    expect(parseHistoryRows(`<table>${row}</table>`, "2026-08-31")[0]?.placeFrom).toBe("&#38;");
  });
});
