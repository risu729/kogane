import { describe, expect, test } from "bun:test";
import {
  accountOptions,
  matchesDates,
  matchesSourceAccount,
  pageWindow,
  recordedDate,
} from "../web/src/filters.ts";

describe("record filters preserve source and date boundaries", () => {
  test("same account label at two sources remains two different accounts", () => {
    const rows = [
      { source_id: "bank-a", source_account: "普通" },
      { source_id: "bank-b", source_account: "普通" },
    ];
    const options = accountOptions(rows, "");
    expect(options).toHaveLength(2);
    expect(
      rows.filter((row) => matchesSourceAccount(row, { source: "", account: options[0]!.value })),
    ).toHaveLength(1);
    expect(accountOptions(rows, "bank-b")).toHaveLength(1);
    expect(
      matchesSourceAccount(rows[0]!, {
        source: "bank-b",
        account: options[0]!.value,
      }),
    ).toBe(false);
  });
  test("date range uses recorded calendar days without timezone conversion", () => {
    expect(matchesDates("2026-09-05T23:30:00-10:00", "2026-09-05", "2026-09-05")).toBe(true);
    expect(matchesDates("2026-09-06T00:00:00+09:00", "2026-09-05", "2026-09-05")).toBe(false);
    expect(matchesDates("2026-09-05", "2026-09-05", "2026-09-05")).toBe(true);
    expect(matchesDates(null, "", "")).toBe(true);
    expect(matchesDates(null, "2026-09-01", "")).toBe(false);
    expect(matchesDates("not-a-date", "", "2026-09-05")).toBe(false);
    expect(matchesDates("2026-09-05", "2026-09-06", "2026-09-01")).toBe(false);
  });
  test("invalid calendar days are not made into apparently dated records", () => {
    expect(recordedDate("2026-02-29")).toBe(null);
    expect(recordedDate("2024-02-29")).toBe("2024-02-29");
    expect(recordedDate("2026-04-31")).toBe(null);
    expect(recordedDate("2026-13-01")).toBe(null);
  });
  test("rendering is bounded and shrinking results clamp a stale page", () => {
    const rows = Array.from({ length: 121 }, (_, id) => ({
      id,
      money: "900719925474099312345",
    }));
    expect(pageWindow(rows, 0).rows).toHaveLength(50);
    expect(pageWindow(rows, 1).rows[0]!.id).toBe(50);
    expect(pageWindow(rows, 2)).toMatchObject({
      start: 101,
      end: 121,
      page: 2,
      pages: 3,
    });
    expect(pageWindow(rows.slice(0, 2), 2)).toMatchObject({
      start: 1,
      end: 2,
      page: 0,
      pages: 1,
    });
    expect(pageWindow([], 4)).toMatchObject({
      start: 0,
      end: 0,
      page: 0,
      pages: 1,
    });
    expect(pageWindow(rows, 0).rows[0]!.money).toBe("900719925474099312345");
    expect(rows).toHaveLength(121);
  });
});
