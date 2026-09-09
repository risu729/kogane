import { describe, expect, test } from "bun:test";
import {
  addDays,
  addMonths,
  compareTemporal,
  daysBetween,
  daysInMonth,
  formatLocalDate,
  isLeapYear,
  monthPeriod,
  parseInstant,
  parseLocalDate,
  periodBounds,
  periodContainsDate,
  periodDays,
  temporalOrderingKey,
  validTemporalReference,
  validTemporalValue,
  type TemporalValue,
} from "../src/time.ts";

const date = (value: string, zone: string | null = "Asia/Tokyo"): TemporalValue => ({
  kind: "local-date",
  value,
  zone,
  basis: "provider",
});
const instant = (value: string, zone = "Asia/Tokyo"): TemporalValue => ({
  kind: "instant",
  value,
  zone,
  basis: "provider",
});

describe("civil calendar", () => {
  test("leap years and month lengths", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(parseLocalDate("2023-02-29")).toBeNull();
    expect(parseLocalDate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseLocalDate("2024-13-01")).toBeNull();
    expect(parseLocalDate("2024-2-1")).toBeNull();
  });

  test("month arithmetic honours month ends under both policies", () => {
    const at = (text: string) => parseLocalDate(text)!;
    expect(formatLocalDate(addMonths(at("2024-01-31"), 1, "clamp"))).toBe("2024-02-29");
    expect(formatLocalDate(addMonths(at("2023-01-31"), 1, "clamp"))).toBe("2023-02-28");
    expect(formatLocalDate(addMonths(at("2024-02-29"), 12, "clamp"))).toBe("2025-02-28");
    expect(formatLocalDate(addMonths(at("2024-02-29"), 1, "preserve-end-of-month"))).toBe(
      "2024-03-31",
    );
    expect(formatLocalDate(addMonths(at("2024-03-31"), -1, "clamp"))).toBe("2024-02-29");
    expect(formatLocalDate(addMonths(at("2025-11-30"), 3, "clamp"))).toBe("2026-02-28");
    expect(formatLocalDate(addMonths(at("2026-01-15"), -13, "clamp"))).toBe("2024-12-15");
  });

  test("day arithmetic is DST-free and leap-aware", () => {
    const at = (text: string) => parseLocalDate(text)!;
    // 2026-03-08 is a DST transition day in North America; civil days do not care.
    expect(daysBetween(at("2026-03-08"), at("2026-03-09"))).toBe(1);
    expect(daysBetween(at("2024-02-28"), at("2024-03-01"))).toBe(2);
    expect(daysBetween(at("2023-02-28"), at("2023-03-01"))).toBe(1);
    expect(formatLocalDate(addDays(at("2024-12-31"), 1))).toBe("2025-01-01");
    expect(formatLocalDate(addDays(at("2000-03-01"), -1))).toBe("2000-02-29");
    expect(daysBetween(at("1970-01-01"), at("2026-09-09"))).toBe(20705);
  });

  test("periods have half-open civil bounds for every granularity", () => {
    expect(periodBounds(monthPeriod(2026, 2, null))).toEqual({
      start: { year: 2026, month: 2, day: 1 },
      endExclusive: { year: 2026, month: 3, day: 1 },
    });
    expect(periodDays(monthPeriod(2024, 2, null))).toBe(29);
    const year: TemporalValue = {
      kind: "period",
      start: "2024",
      end: "2025",
      endExclusive: true,
      zone: null,
      granularity: "year",
    };
    expect(periodDays(year as never)).toBe(366);
    const days: TemporalValue = {
      kind: "period",
      start: "2026-08-01",
      end: "2026-08-31",
      endExclusive: false,
      zone: "Asia/Tokyo",
      granularity: "day",
    };
    expect(periodDays(days as never)).toBe(31);
    expect(periodContainsDate(days as never, parseLocalDate("2026-08-31")!)).toBe(true);
    expect(periodContainsDate(days as never, parseLocalDate("2026-09-01")!)).toBe(false);
    expect(validTemporalValue({ ...days, end: "2026-07-31" })).toBe(false);
    expect(
      validTemporalValue({ ...days, start: "2026-08-01", end: "2026-08-01", endExclusive: true }),
    ).toBe(false);
  });
});

describe("instants", () => {
  test("parse with offsets and compare by absolute time", () => {
    expect(parseInstant("2026-03-01T00:30:00+09:00")).toEqual({
      epochSeconds: parseInstant("2026-02-28T15:30:00Z")!.epochSeconds,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    expect(parseInstant("2026-03-01T00:30:00.5Z")!.nanoseconds).toBe(500_000_000);
    expect(parseInstant("2026-03-01T24:00:00Z")).toBeNull();
    expect(parseInstant("2026-03-01T00:00:00")).toBeNull();
    expect(parseInstant("2026-03-01")).toBeNull();
    expect(
      compareTemporal(instant("2026-03-01T00:30:00+09:00"), instant("2026-02-28T15:30:00Z", "UTC")),
    ).toEqual({ kind: "ordered", order: 0 });
    expect(
      compareTemporal(instant("2026-03-01T00:30:00.000000001Z"), instant("2026-03-01T00:30:00Z")),
    ).toEqual({ kind: "ordered", order: 1 });
  });
});

describe("semantic comparison", () => {
  test("a date is never given a time-of-day", () => {
    expect(compareTemporal(instant("2026-03-01T10:00:00+09:00"), date("2026-03-01"))).toEqual({
      kind: "incomparable",
      reasonCode: "within_day",
    });
    expect(compareTemporal(instant("2026-03-01T00:00:00+09:00"), date("2026-03-01"))).toEqual({
      kind: "incomparable",
      reasonCode: "within_day",
    });
    expect(compareTemporal(instant("2026-02-28T23:59:59+09:00"), date("2026-03-01"))).toEqual({
      kind: "ordered",
      order: -1,
    });
    expect(compareTemporal(date("2026-03-01"), instant("2026-03-02T00:00:00+09:00"))).toEqual({
      kind: "ordered",
      order: -1,
    });
    // The instant's own offset defines its calendar date; the zone label is not re-projected.
    expect(
      compareTemporal(instant("2026-03-01T15:00:00Z", "UTC"), date("2026-03-02", "UTC")),
    ).toEqual({
      kind: "ordered",
      order: -1,
    });
  });

  test("unknown time and zone mismatches are incomparable, periods overlap", () => {
    const unknown: TemporalValue = { kind: "unknown", reasonCode: "no_date_in_source" };
    expect(compareTemporal(unknown, date("2026-03-01"))).toEqual({
      kind: "incomparable",
      reasonCode: "unknown_time",
    });
    expect(
      compareTemporal(date("2026-03-01", "Asia/Tokyo"), date("2026-03-02", "America/New_York")),
    ).toEqual({
      kind: "incomparable",
      reasonCode: "zone_mismatch",
    });
    expect(
      compareTemporal(date("2026-03-01", null), date("2026-03-02", "America/New_York")),
    ).toEqual({
      kind: "ordered",
      order: -1,
    });
    expect(compareTemporal(date("2026-03-01"), date("2026-03-01"))).toEqual({
      kind: "ordered",
      order: 0,
    });
    expect(compareTemporal(monthPeriod(2026, 3, null), date("2026-03-15", null))).toEqual({
      kind: "incomparable",
      reasonCode: "overlap",
    });
    expect(compareTemporal(monthPeriod(2026, 3, null), monthPeriod(2026, 4, null))).toEqual({
      kind: "ordered",
      order: -1,
    });
    expect(
      compareTemporal(instant("2026-03-15T00:00:00+09:00"), monthPeriod(2026, 3, "Asia/Tokyo")),
    ).toEqual({ kind: "incomparable", reasonCode: "within_period" });
  });

  test("ordering keys are total and put unknown times last", () => {
    const keys = [
      { kind: "unknown", reasonCode: "b" } as TemporalValue,
      instant("2026-03-01T00:00:00Z"),
      date("2026-03-01"),
      monthPeriod(2026, 3, null),
      { kind: "unknown", reasonCode: "a" } as TemporalValue,
      instant("1969-12-31T23:59:59Z"),
    ].map(temporalOrderingKey);
    const sorted = [...keys].sort();
    expect(sorted[0]).toBe(temporalOrderingKey(instant("1969-12-31T23:59:59Z")));
    expect(sorted[1]).toBe(temporalOrderingKey(instant("2026-03-01T00:00:00Z")));
    expect(sorted[2]).toBe("1:2026-03-01");
    expect(sorted[3]).toBe("2:2026-03-01:2026-04-01");
    expect(sorted.slice(4)).toEqual(["3:a", "3:b"]);
  });
});

describe("validators", () => {
  test("accept every kind and reject unknown keys or malformed values", () => {
    expect(validTemporalValue(instant("2026-03-01T00:00:00+09:00"))).toBe(true);
    expect(validTemporalValue(date("2026-02-29"))).toBe(false);
    expect(validTemporalValue(date("2024-02-29"))).toBe(true);
    expect(validTemporalValue({ ...date("2024-02-29"), value: "2024-02-29T00:00:00Z" })).toBe(
      false,
    );
    expect(validTemporalValue({ ...date("2024-02-29"), hour: 0 })).toBe(false);
    expect(
      validTemporalValue({
        kind: "instant",
        value: "2026-03-01T00:00:00+09:00",
        basis: "provider",
      }),
    ).toBe(false);
    expect(
      validTemporalValue({
        kind: "instant",
        value: "2026-03-01T00:00:00+09:00",
        zone: "Asia/Tokyo",
        basis: "guess",
      }),
    ).toBe(false);
    expect(validTemporalValue({ kind: "unknown", reasonCode: "" })).toBe(false);
    expect(validTemporalValue({ kind: "unknown", reasonCode: "x" })).toBe(true);
    expect(validTemporalValue({ kind: "date", value: "2024-02-29" })).toBe(false);
    expect(validTemporalReference({ role: "trade", time: date("2024-02-29") })).toBe(true);
    expect(validTemporalReference({ role: "purchase", time: date("2024-02-29") })).toBe(false);
    expect(validTemporalReference({ role: "trade", time: date("2024-02-29"), note: 1 })).toBe(
      false,
    );
  });
});
