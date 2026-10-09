import { describe, expect, test } from "bun:test";
import {
  addDays,
  addMonths,
  civilFromDays,
  compareTemporal,
  daysBetween,
  daysFromCivil,
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
  validInstantText,
  validLocalDateText,
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

  test("century leap days and civil day-number round-trips", () => {
    // 1900 and 2100 are common centuries; 2000 and proleptic year 0 are 400-year leaps.
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(0, 2)).toBe(29);
    expect(isLeapYear(0)).toBe(true);
    expect(parseLocalDate("1900-02-29")).toBeNull();
    expect(parseLocalDate("2100-02-29")).toBeNull();
    expect(parseLocalDate("2000-02-29")).toEqual({ year: 2000, month: 2, day: 29 });
    expect(parseLocalDate("0000-02-29")).toEqual({ year: 0, month: 2, day: 29 });

    const serials: Array<[string, number]> = [
      ["1970-01-01", 0],
      ["1969-12-31", -1],
      ["1900-02-28", -25_509],
      ["1900-03-01", -25_508],
      ["2000-02-28", 11_015],
      ["2000-02-29", 11_016],
      ["2000-03-01", 11_017],
      ["2100-02-28", 47_540],
      ["2100-03-01", 47_541],
      ["0000-02-28", -719_470],
      ["0000-02-29", -719_469],
      ["0000-03-01", -719_468],
    ];
    for (const [text, serial] of serials) {
      const date = parseLocalDate(text)!;
      expect(daysFromCivil(date)).toBe(serial);
      expect(civilFromDays(serial)).toEqual(date);
      expect(formatLocalDate(civilFromDays(daysFromCivil(date)))).toBe(text);
    }
    expect(daysBetween(parseLocalDate("1900-02-28")!, parseLocalDate("1900-03-01")!)).toBe(1);
    expect(daysBetween(parseLocalDate("2000-02-28")!, parseLocalDate("2000-03-01")!)).toBe(2);
    expect(daysBetween(parseLocalDate("2100-02-28")!, parseLocalDate("2100-03-01")!)).toBe(1);
    expect(daysBetween(parseLocalDate("0000-02-28")!, parseLocalDate("0000-03-01")!)).toBe(2);
    expect(formatLocalDate(addDays(parseLocalDate("2100-02-28")!, 1))).toBe("2100-03-01");
    expect(formatLocalDate(addDays(parseLocalDate("1900-03-01")!, -1))).toBe("1900-02-28");
    expect(formatLocalDate(addDays(parseLocalDate("0000-03-01")!, -1))).toBe("0000-02-29");
  });

  test("thirty-day months and empty month or day numbers are rejected", () => {
    for (const month of [4, 6, 9, 11]) {
      expect(daysInMonth(2026, month)).toBe(30);
      const prefix = `2026-${String(month).padStart(2, "0")}`;
      expect(parseLocalDate(`${prefix}-30`)).toEqual({ year: 2026, month, day: 30 });
      expect(parseLocalDate(`${prefix}-31`)).toBeNull();
    }
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(parseLocalDate("2026-01-31")).toEqual({ year: 2026, month: 1, day: 31 });
    expect(parseLocalDate("2026-01-32")).toBeNull();
    expect(parseLocalDate("2026-00-15")).toBeNull();
    expect(parseLocalDate("2026-03-00")).toBeNull();
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

  test("offset spellings of one instant share an absolute epoch", () => {
    expect(parseInstant("1970-01-01T00:00:00Z")).toEqual({
      epochSeconds: 0,
      nanoseconds: 0,
      localDate: "1970-01-01",
    });
    expect(parseInstant("1969-12-31T23:59:59Z")).toEqual({
      epochSeconds: -1,
      nanoseconds: 0,
      localDate: "1969-12-31",
    });
    // 23:00 at offset -01:00 is midnight Z on the next civil day.
    expect(parseInstant("1969-12-31T23:00:00-01:00")).toEqual({
      epochSeconds: 0,
      nanoseconds: 0,
      localDate: "1969-12-31",
    });
    expect(parseInstant("2026-03-01T00:30:00Z")).toEqual({
      epochSeconds: 1_772_325_000,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    expect(parseInstant("2026-03-01T00:30:00+00:00")).toEqual({
      epochSeconds: 1_772_325_000,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    expect(parseInstant("2026-03-01T00:30:00-00:00")).toEqual({
      epochSeconds: 1_772_325_000,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    // 00:30 at -05:00 is 05:30Z the same civil day.
    expect(parseInstant("2026-03-01T00:30:00-05:00")).toEqual({
      epochSeconds: 1_772_343_000,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    expect(parseInstant("2026-03-01T05:30:00Z")).toEqual({
      epochSeconds: 1_772_343_000,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    // 00:30 at +05:30 is 19:00Z the previous civil day.
    expect(parseInstant("2026-03-01T00:30:00+05:30")).toEqual({
      epochSeconds: 1_772_305_200,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    expect(parseInstant("2026-02-28T19:00:00Z")).toEqual({
      epochSeconds: 1_772_305_200,
      nanoseconds: 0,
      localDate: "2026-02-28",
    });
    // +18:59 is the largest accepted offset; it is midnight Z the same civil day.
    expect(parseInstant("2026-03-01T18:59:00+18:59")).toEqual({
      epochSeconds: 1_772_323_200,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    expect(parseInstant("2026-03-01T00:00:00Z")).toEqual({
      epochSeconds: 1_772_323_200,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    expect(parseInstant("2026-03-01T00:30:00.5+09:00")).toEqual({
      epochSeconds: 1_772_292_600,
      nanoseconds: 500_000_000,
      localDate: "2026-03-01",
    });
    expect(parseInstant("2026-03-01T00:30:00.12Z")!.nanoseconds).toBe(120_000_000);
    expect(parseInstant("2026-03-01T00:30:00.123456789Z")!.nanoseconds).toBe(123_456_789);
    expect(temporalOrderingKey(instant("2026-03-01T00:30:00-05:00"))).toBe(
      temporalOrderingKey(instant("2026-03-01T05:30:00Z", "UTC")),
    );
  });

  test("invalid clock, offset, and fraction boundaries stay null", () => {
    expect(parseInstant("2026-03-01T23:59:59Z")).toEqual({
      epochSeconds: 1_772_409_599,
      nanoseconds: 0,
      localDate: "2026-03-01",
    });
    expect(parseInstant("2026-03-01T00:60:00Z")).toBeNull();
    expect(parseInstant("2026-03-01T23:59:60Z")).toBeNull();
    expect(parseInstant("2026-03-01T00:00:00+19:00")).toBeNull();
    expect(parseInstant("2026-03-01T00:00:00-19:00")).toBeNull();
    expect(parseInstant("2026-03-01T00:00:00+18:60")).toBeNull();
    expect(parseInstant("2026-03-01T00:00:00z")).toBeNull();
    expect(parseInstant("2026-03-01T00:30:00.Z")).toBeNull();
    expect(parseInstant("2026-03-01T00:30:00.1234567890Z")).toBeNull();
    expect(parseInstant("2026-3-01T00:00:00Z")).toBeNull();
    expect(parseInstant("2026-04-31T00:00:00Z")).toBeNull();
  });

  test("instant order uses epoch seconds before nanoseconds", () => {
    expect(
      compareTemporal(instant("2026-03-01T00:00:00Z"), instant("2026-03-01T00:00:01Z")),
    ).toEqual({ kind: "ordered", order: -1 });
    expect(
      compareTemporal(instant("2026-03-01T00:00:01Z"), instant("2026-03-01T00:00:00Z")),
    ).toEqual({ kind: "ordered", order: 1 });
    expect(
      compareTemporal(instant("2026-03-01T00:30:00Z"), instant("2026-03-01T00:30:00.000000001Z")),
    ).toEqual({ kind: "ordered", order: -1 });
    expect(
      compareTemporal(instant("2026-03-01T00:00:01Z"), instant("2026-03-01T00:00:00.999999999Z")),
    ).toEqual({ kind: "ordered", order: 1 });
    expect(
      compareTemporal(
        instant("2026-03-01T00:30:00.000000002+09:00"),
        instant("2026-02-28T15:30:00.000000001Z", "UTC"),
      ),
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
    expect(validInstantText("1970-01-01T00:00:00Z")).toBe(true);
    expect(validInstantText("2026-03-01T23:59:60Z")).toBe(false);
    expect(validInstantText(1)).toBe(false);
    expect(validInstantText(null)).toBe(false);
    expect(validLocalDateText("2000-02-29")).toBe(true);
    expect(validLocalDateText("1900-02-29")).toBe(false);
    expect(validLocalDateText("2026-04-31")).toBe(false);
    expect(validLocalDateText(null)).toBe(false);
  });
});
