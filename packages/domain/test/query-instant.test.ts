import { describe, expect, test } from "bun:test";
import { parseQueryInstant } from "../src/query-instant.ts";
import { daysInMonth, isLeapYear } from "../src/time.ts";
import { between, pad2, pick, seededRandom, seeds } from "./property.ts";

const iso = (text: string) => {
  const parsed = parseQueryInstant(text);
  return parsed.ok ? parsed.iso : parsed.reason;
};
const pad4 = (value: number) => String(value).padStart(4, "0");

describe("parseQueryInstant", () => {
  test("takes a date, a time to the minute or the second, and a zone", () => {
    expect(parseQueryInstant("2026-11-21T09:30Z")).toEqual({
      ok: true,
      iso: "2026-11-21T09:30:00.000Z",
      epochMs: Date.UTC(2026, 10, 21, 9, 30),
    });
    expect(iso("2026-11-21T09:30:15Z")).toBe("2026-11-21T09:30:15.000Z");
    expect(iso("2026-11-21T09:30:15.5Z")).toBe("2026-11-21T09:30:15.500Z");
    expect(iso("2026-11-21T09:30:15.05Z")).toBe("2026-11-21T09:30:15.050Z");
    expect(iso("2026-11-21T09:30:15.123Z")).toBe("2026-11-21T09:30:15.123Z");
    expect(iso("2026-11-21T09:30+09:00")).toBe("2026-11-21T00:30:00.000Z");
    expect(iso("2026-11-21T09:30-00:00")).toBe("2026-11-21T09:30:00.000Z");
    expect(iso("2026-11-21T09:30:15.123-05:30")).toBe("2026-11-21T15:00:15.123Z");
  });

  test("refuses any other form", () => {
    for (const text of [
      "",
      "2026-11-21",
      "2026-11-21T09:30",
      "2026-11-21T09:30:15",
      "2026-11-21 09:30Z",
      "2026-11-21t09:30Z",
      "2026-11-21T09:30z",
      "2026-11-21T09Z",
      "2026-11-21T9:30Z",
      "2026-1-21T09:30Z",
      "26-11-21T09:30Z",
      "+002026-11-21T09:30Z",
      "-002026-11-21T09:30Z",
      "2026-11-21T09:30.5Z",
      "2026-11-21T09:30:15.Z",
      "2026-11-21T09:30:15.1234Z",
      "2026-11-21T09:30:15,5Z",
      "2026-11-21T09:30+09",
      "2026-11-21T09:30+0900",
      "2026-11-21T09:30+9:00",
      "2026-11-21T09:30UTC",
      "2026-11-21T09:30Z ",
      " 2026-11-21T09:30Z",
      "2026-11-21T09:30Z\n",
      "２０２６-11-21T09:30Z",
    ])
      expect(parseQueryInstant(text)).toEqual({ ok: false, reason: "format" });
  });

  test("refuses a date the calendar does not have", () => {
    for (const text of [
      "2026-00-01T00:00Z",
      "2026-13-01T00:00Z",
      "2026-01-00T00:00Z",
      "2026-01-32T00:00Z",
      "2026-04-31T00:00Z",
      "2026-02-29T00:00Z",
      "2026-02-30T00:00Z",
    ])
      expect(iso(text)).toBe("format");
  });

  test("leap years: every fourth, but not centuries unless every fourth century", () => {
    for (const [year, leap] of [
      [0, true],
      [4, true],
      [100, false],
      [200, false],
      [400, true],
      [1900, false],
      [2000, true],
      [2024, true],
      [2026, false],
      [2100, false],
      [9996, true],
    ] as const) {
      expect(isLeapYear(year)).toBe(leap);
      expect(iso(`${pad4(year)}-02-29T00:00Z`)).toBe(
        leap ? `${pad4(year)}-02-29T00:00:00.000Z` : "format",
      );
      expect(iso(`${pad4(year)}-02-28T00:00Z`)).toBe(`${pad4(year)}-02-28T00:00:00.000Z`);
    }
    // The years 0 to 99 are read as written, not as 1900 to 1999.
    expect(iso("0000-02-29T00:00Z")).toBe("0000-02-29T00:00:00.000Z");
    expect(iso("0100-02-29T00:00Z")).toBe("format");
    expect(iso("0004-02-29T23:59:59.999Z")).toBe("0004-02-29T23:59:59.999Z");
    expect(iso("0099-12-31T23:59:59Z")).toBe("0099-12-31T23:59:59.000Z");
  });

  test("refuses 24:00, a leap second and a minute or second past 59", () => {
    for (const text of [
      "2026-11-21T24:00Z",
      "2026-11-21T24:00:00Z",
      "2026-11-21T25:00Z",
      "2026-11-21T23:60Z",
      "2026-11-21T23:59:60Z",
      "2026-12-31T23:59:60Z",
      "2016-12-31T23:59:60Z",
      "2026-11-21T23:59:99Z",
    ])
      expect(iso(text)).toBe("format");
    expect(iso("2026-11-21T23:59:59.999Z")).toBe("2026-11-21T23:59:59.999Z");
    expect(iso("2026-11-21T00:00Z")).toBe("2026-11-21T00:00:00.000Z");
  });

  test("offsets run to ±23:59 and no further", () => {
    expect(iso("2026-11-21T00:00+23:59")).toBe("2026-11-20T00:01:00.000Z");
    expect(iso("2026-11-21T00:00-23:59")).toBe("2026-11-21T23:59:00.000Z");
    expect(iso("2026-11-21T12:00+18:00")).toBe("2026-11-20T18:00:00.000Z");
    expect(iso("2026-11-21T12:00+18:01")).toBe("2026-11-20T17:59:00.000Z");
    for (const offset of ["+24:00", "-24:00", "+00:60", "-00:60", "+23:60", "+99:99"])
      expect(iso(`2026-11-21T00:00${offset}`)).toBe("format");
  });

  test("the UTC form stays within the years 0000 to 9999", () => {
    expect(iso("0000-01-01T00:00Z")).toBe("0000-01-01T00:00:00.000Z");
    expect(iso("0000-01-01T00:30+00:30")).toBe("0000-01-01T00:00:00.000Z");
    expect(iso("0000-01-01T00:00-23:59")).toBe("0000-01-01T23:59:00.000Z");
    expect(iso("9999-12-31T23:59:59.999Z")).toBe("9999-12-31T23:59:59.999Z");
    expect(iso("9999-12-31T23:59:59.999+23:59")).toBe("9999-12-31T00:00:59.999Z");
    expect(iso("9999-12-31T23:30-00:29")).toBe("9999-12-31T23:59:00.000Z");
    // Just past each end: a real time, told apart from a malformed one.
    expect(parseQueryInstant("0000-01-01T00:00+00:01")).toEqual({
      ok: false,
      reason: "range",
      epochMs: Date.parse("-000001-12-31T23:59:00Z"),
    });
    expect(parseQueryInstant("0000-01-01T00:00:00.000+23:59")).toEqual({
      ok: false,
      reason: "range",
      epochMs: Date.parse("-000001-12-31T00:01:00Z"),
    });
    expect(parseQueryInstant("9999-12-31T23:30-00:30")).toEqual({
      ok: false,
      reason: "range",
      epochMs: Date.parse("+010000-01-01T00:00:00Z"),
    });
    expect(parseQueryInstant("9999-12-31T23:59-23:59")).toEqual({
      ok: false,
      reason: "range",
      epochMs: Date.parse("+010000-01-01T23:58:00Z"),
    });
  });

  test("every written calendar time is its UTC instant", () => {
    for (const seed of seeds(1, 200)) {
      const random = seededRandom(seed);
      for (let round = 0; round < 50; round += 1) {
        const year = between(random, 0, 9999);
        const month = between(random, 1, 12);
        const day = between(random, 1, daysInMonth(year, month));
        const hour = between(random, 0, 23);
        const minute = between(random, 0, 59);
        const second = between(random, 0, 59);
        const ms = between(random, 0, 999);
        const offset = between(random, -(23 * 60 + 59), 23 * 60 + 59);
        const zone = pick(random, [
          "Z",
          `${offset < 0 ? "-" : "+"}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`,
        ]);
        const text = `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${String(ms).padStart(3, "0")}${zone}`;
        const civil = new Date(0);
        civil.setUTCFullYear(year, month - 1, day);
        civil.setUTCHours(hour, minute, second, ms);
        const epochMs = civil.getTime() - (zone === "Z" ? 0 : offset * 60_000);
        const utc = new Date(epochMs).toISOString();
        expect(parseQueryInstant(text)).toEqual(
          /^\d{4}-/u.test(utc)
            ? { ok: true, iso: utc, epochMs }
            : { ok: false, reason: "range", epochMs },
        );
      }
    }
  });
});
