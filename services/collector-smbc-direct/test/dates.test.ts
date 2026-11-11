import { describe, expect, test } from "bun:test";
import {
  compactDate,
  foreignOrdinaryRange,
  japanToday,
  lastFinishedJapanDay,
  monthRanges,
  nextJapanMidnight,
  validateDate,
} from "../src/dates";

describe("monthRanges", () => {
  test("splits an inclusive range at calendar month boundaries", () => {
    expect(monthRanges("2026-01-15", "2026-03-02")).toEqual([
      { start: "2026-01-15", end: "2026-01-31" },
      { start: "2026-02-01", end: "2026-02-28" },
      { start: "2026-03-01", end: "2026-03-02" },
    ]);
  });

  test("handles leap years", () => {
    expect(monthRanges("2024-02-01", "2024-02-29")).toEqual([
      { start: "2024-02-01", end: "2024-02-29" },
    ]);
  });
});
describe("date helpers", () => {
  test("foreign ordinary retention follows the JST month and includes only closed days", () => {
    expect(foreignOrdinaryRange(new Date("2099-01-01T01:00:00.000Z"))).toEqual({
      start: "2098-10-01",
      end: "2098-12-31",
    });
    expect(foreignOrdinaryRange(new Date("2099-03-31T15:00:00.000Z"))).toEqual({
      start: "2099-01-01",
      end: "2099-03-31",
    });
  });
  test("uses the Japan calendar date", () => {
    expect(japanToday(new Date("2026-08-31T21:15:00Z"))).toBe("2026-09-01");
  });

  test("closes a day exactly at JST midnight, including leap and year boundaries", () => {
    expect(lastFinishedJapanDay(new Date("2024-02-29T14:59:59.999Z"))).toBe("2024-02-28");
    expect(lastFinishedJapanDay(new Date("2024-02-29T15:00:00.000Z"))).toBe("2024-02-29");
    expect(lastFinishedJapanDay(new Date("2026-01-01T01:00:00.000Z"))).toBe("2025-12-31");
    expect(nextJapanMidnight(new Date("2026-01-01T01:00:00.000Z"))).toBe(
      Date.parse("2026-01-01T15:00:00.000Z"),
    );
  });

  test("validates and compacts dates", () => {
    expect(compactDate("2026-09-01")).toBe("20260901");
    expect(() => validateDate("2026-02-29", "date")).toThrow("date_invalid");
  });
});
