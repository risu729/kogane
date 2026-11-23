// The capture date of a stored instant (src/reported-state.ts, ADR 0019).
import { describe, expect, test } from "bun:test";
import { tokyoDate } from "../src/collection-freshness.ts";
import { captureDate, snapshotFreshness } from "../src/reported-state.ts";

describe("captureDate", () => {
  test("is the Asia/Tokyo civil date of a stored UTC instant, across days, months and years", () => {
    const cases: [string, string][] = [
      ["2026-09-09T14:59:59.999Z", "2026-09-09"],
      ["2026-09-09T15:00:00.000Z", "2026-09-10"],
      ["2026-01-31T15:00:00.000Z", "2026-02-01"],
      ["2024-02-28T15:00:00.000Z", "2024-02-29"],
      ["2024-02-29T15:00:00.000Z", "2024-03-01"],
      ["2026-12-31T14:59:59Z", "2026-12-31"],
      ["2026-12-31T15:00:00Z", "2027-01-01"],
      ["2026-09-09T23:59:59.123456789Z", "2026-09-10"],
      ["0050-01-01T00:00:00.000Z", "0050-01-01"],
      ["9999-12-31T14:59:59.999Z", "9999-12-31"],
    ];
    for (const [at, date] of cases) {
      expect([at, captureDate(at)]).toEqual([at, date]);
      expect([at, tokyoDate(at)]).toEqual([at, date]);
    }
  });

  test("an impossible calendar time is not an instant, never rolled over to another date", () => {
    for (const at of [
      // 2026 is not a leap year.
      "2026-02-29T10:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      "2026-04-31T16:00:00.000Z",
      "2026-01-31T24:00:00.000Z",
      "2026-01-31T23:60:00.000Z",
      "2026-01-31T23:59:60.000Z",
      "2026-13-01T00:00:00.000Z",
      "2026-00-10T00:00:00.000Z",
    ]) {
      expect([at, captureDate(at)]).toEqual([at, null]);
      expect([at, tokyoDate(at)]).toEqual([at, null]);
    }
    expect(() => snapshotFreshness("2026-02-30T00:00:00.000Z", "2026-03-02")).toThrow(
      "invalid_capture_time",
    );
  });

  test("a Tokyo date past 9999-12-31 is not written as a date", () => {
    expect(captureDate("9999-12-31T15:00:00.000Z")).toBeNull();
  });

  test("only the stored UTC form is read", () => {
    for (const at of ["2026-09-09T15:00:00+09:00", "2026-09-09T15:00Z", "2026-09-09", ""])
      expect([at, captureDate(at)]).toEqual([at, null]);
  });
});
