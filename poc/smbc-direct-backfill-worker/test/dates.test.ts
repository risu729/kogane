import { describe, expect, test } from "bun:test";
import { compactDate, japanToday, monthRanges, validateDate } from "../src/dates";

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
  test("uses the Japan calendar date", () => {
    expect(japanToday(new Date("2026-08-31T21:15:00Z"))).toBe("2026-09-01");
  });

  test("validates and compacts dates", () => {
    expect(compactDate("2026-09-01")).toBe("20260901");
    expect(() => validateDate("2026-02-29", "date")).toThrow("date_invalid");
  });
});
