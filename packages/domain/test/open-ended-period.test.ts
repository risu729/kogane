import { describe, expect, test } from "bun:test";
import { compareToOpenEnded, validOpenEndedPeriodValue } from "../src/open-ended-period.ts";
import { monthPeriod, validTemporalValue, type TemporalValue } from "../src/time.ts";

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

describe("open-ended periods", () => {
  const standing = { kind: "open-ended", start: "2026-04-01", zone: "Asia/Tokyo" } as const;

  test("only a first day and a zone are stored; there is no end", () => {
    expect(validOpenEndedPeriodValue(standing)).toBe(true);
    expect(validOpenEndedPeriodValue({ ...standing, zone: null })).toBe(true);
    expect(validOpenEndedPeriodValue({ ...standing, start: "2026-02-30" })).toBe(false);
    expect(validOpenEndedPeriodValue({ ...standing, start: "2026-04" })).toBe(false);
    expect(validOpenEndedPeriodValue({ ...standing, end: null })).toBe(false);
    expect(validOpenEndedPeriodValue({ ...standing, zone: "not a zone" })).toBe(false);
    // It is not a TemporalValue, so a field that does not opt in rejects it.
    expect(validTemporalValue(standing)).toBe(false);
  });

  test("a day before the first day is outside; the first day and every later day are inside", () => {
    expect(compareToOpenEnded(date("2026-03-31"), standing)).toEqual({
      kind: "ordered",
      order: -1,
    });
    expect(compareToOpenEnded(date("2026-04-01"), standing)).toEqual({ kind: "ordered", order: 0 });
    expect(compareToOpenEnded(date("9999-12-31"), standing)).toEqual({ kind: "ordered", order: 0 });
    expect(compareToOpenEnded(date("2026-04-01", null), standing)).toEqual({
      kind: "ordered",
      order: 0,
    });
  });

  test("an instant counts by its own calendar date", () => {
    expect(compareToOpenEnded(instant("2026-04-01T00:00:00+09:00"), standing)).toEqual({
      kind: "ordered",
      order: 0,
    });
    expect(compareToOpenEnded(instant("2026-03-31T23:59:59+09:00"), standing)).toEqual({
      kind: "ordered",
      order: -1,
    });
  });

  test("a period straddling the first day overlaps; zone mismatch and unknown stay incomparable", () => {
    expect(compareToOpenEnded(monthPeriod(2026, 3, "Asia/Tokyo"), standing)).toEqual({
      kind: "ordered",
      order: -1,
    });
    expect(compareToOpenEnded(monthPeriod(2026, 4, "Asia/Tokyo"), standing)).toEqual({
      kind: "ordered",
      order: 0,
    });
    expect(
      compareToOpenEnded(
        {
          kind: "period",
          start: "2026-03-31",
          end: "2026-04-01",
          endExclusive: false,
          zone: "Asia/Tokyo",
          granularity: "day",
        },
        standing,
      ),
    ).toEqual({ kind: "incomparable", reasonCode: "overlap" });
    expect(compareToOpenEnded(date("2026-04-01", "Europe/London"), standing)).toEqual({
      kind: "incomparable",
      reasonCode: "zone_mismatch",
    });
    expect(compareToOpenEnded({ kind: "unknown", reasonCode: "not_observed" }, standing)).toEqual({
      kind: "incomparable",
      reasonCode: "unknown_time",
    });
  });
});
