import { describe, expect, test } from "bun:test";
import { encode } from "iconv-lite";
import {
  collectionCompleteness,
  historySearchBody,
  parseHistoryRows,
  parseSessionEnvelope,
} from "../src/mobile-suica";

describe("Mobile Suica session replay", () => {
  test("validates the source-scoped envelope", () => {
    const envelope = parseSessionEnvelope(
      JSON.stringify({
        cookieHeader: "ASP.NET_SessionId=a; sc_auth=b; TS0184138d=c",
        formBody:
          "baseVariable=opaque&specifyYearMonth=2026%2F08&specifyDay=30&SEARCH=%8C%9F%8D%F5",
        userAgent: "test-agent",
      }),
    );
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

  test("counts identical same-day rows toward the 100-row boundary", () => {
    const row = `<tr><td></td><td>08/30</td><td>物販</td><td>店舗</td><td></td><td></td><td>\\1,234</td><td>-100</td></tr>`;
    const rows = parseHistoryRows(`<table>${row.repeat(100)}</table>`, "2026-08-31");
    expect(rows).toHaveLength(100);
    expect(rows.every((entry) => entry.date === "2026-08-30")).toBe(true);
    expect(collectionCompleteness(rows.length)).toBe(false);
  });

  test("does not decode generated entity text a second time", () => {
    const row = `<tr><td></td><td>08/30</td><td>物販</td><td>&amp;#38;</td><td></td><td></td><td>\\1</td><td>-1</td></tr>`;
    expect(parseHistoryRows(`<table>${row}</table>`, "2026-08-31")[0]?.placeFrom).toBe("&#38;");
  });

  test("treats only a sub-100 single page as complete", () => {
    expect(collectionCompleteness(0)).toBe(true);
    expect(collectionCompleteness(99)).toBe(true);
    expect(collectionCompleteness(100)).toBe(false);
    expect(() => collectionCompleteness(101)).toThrow("history_row_count_invalid");
  });

  test("walks a January cursor backward across the year boundary", () => {
    const rows = parseHistoryRows(historyTable(["01/14", "01/01", "12/31", "12/01"]), "2026-01-15");
    const dates = rows.map((row) => row.date);
    expect(rows).toHaveLength(4);
    expect(dates).toEqual(["2026-01-14", "2026-01-01", "2025-12-31", "2025-12-01"]);
    expectDatesNonIncreasing(dates);
    expect(rows[0]).toEqual({
      date: "2026-01-14",
      typeFrom: "物販",
      placeFrom: "店舗",
      typeTo: "",
      placeTo: "",
      balanceText: "\\1,234",
      amountText: "-100",
      balance: 1234,
      amount: -100,
      kind: "payment",
    });
  });

  test("keeps duplicate rows on both sides of a January year boundary", () => {
    const rows = parseHistoryRows(historyTable(["01/01", "01/01", "12/31", "12/31"]), "2026-01-02");
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.date)).toEqual([
      "2026-01-01",
      "2026-01-01",
      "2025-12-31",
      "2025-12-31",
    ]);
  });

  test("keeps the cursor day when the cursor is January 1", () => {
    const rows = parseHistoryRows(historyTable(["01/01", "01/01", "12/31", "12/31"]), "2026-01-01");
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.date)).toEqual([
      "2026-01-01",
      "2026-01-01",
      "2025-12-31",
      "2025-12-31",
    ]);
  });

  test("rolls December once on a 99-row and a 100-row January page", () => {
    for (const spec of [
      { julyCount: 91, rowCount: 99, complete: true },
      { julyCount: 92, rowCount: 100, complete: false },
    ] as const) {
      const monthDays = [
        ...repeated("01/14", 2),
        ...repeated("01/01", 2),
        ...repeated("12/31", 2),
        ...repeated("12/01", 2),
        ...repeated("07/20", spec.julyCount),
      ];
      const rows = parseHistoryRows(historyTable(monthDays, true), "2026-01-15");
      const dates = rows.map((row) => row.date);
      expect(rows).toHaveLength(spec.rowCount);
      expect(collectionCompleteness(rows.length)).toBe(spec.complete);
      expectDatesNonIncreasing(dates);
      expect(dates.filter((date) => date === "2026-01-14")).toHaveLength(2);
      expect(dates.filter((date) => date === "2026-01-01")).toHaveLength(2);
      expect(dates.filter((date) => date === "2025-12-31")).toHaveLength(2);
      expect(dates.filter((date) => date === "2025-12-01")).toHaveLength(2);
      expect(dates.filter((date) => date === "2025-07-20")).toHaveLength(spec.julyCount);
    }
  });
});

const HISTORY_HEADER =
  "<tr><td></td><td>月日</td><td>種別</td><td>利用場所</td><td>種別</td><td>利用場所</td><td>残高</td><td>入金・利用額</td></tr>";

function paymentRow(monthDay: string): string {
  return `<tr><td><input name="printCheck"></td><td>${monthDay}</td><td>物販</td><td>店舗</td><td></td><td></td><td>\\1,234</td><td>-100</td></tr>`;
}

function historyTable(monthDays: readonly string[], header = false): string {
  const head = header ? HISTORY_HEADER : "";
  return `<table>${head}${monthDays.map(paymentRow).join("")}</table>`;
}

function repeated(monthDay: string, count: number): string[] {
  return Array.from({ length: count }, () => monthDay);
}

function expectDatesNonIncreasing(dates: readonly string[]): void {
  for (let index = 1; index < dates.length; index += 1) {
    expect(dates[index]! <= dates[index - 1]!).toBe(true);
  }
}
