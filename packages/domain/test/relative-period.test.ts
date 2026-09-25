// relative-statement-period-v1 (src/relative-period.ts): a relative statement
// label resolved from the capture time of the artifact that carries it
// (docs/observations.md, "Relative period labels are resolved from the capture
// time"). Every capture time here is synthetic.
import { describe, expect, test } from "bun:test";
import { cardStatementPeriod } from "../src/card-purchase.ts";
import {
  civilDateInZone,
  MYJCB_CLOSING_DAY,
  RELATIVE_PERIOD_RULE,
  RELATIVE_PERIOD_ZONE,
  resolveRelativePeriod,
} from "../src/relative-period.ts";

const myjcb = (label: string | null, fetchedAt: string | null) =>
  resolveRelativePeriod({ sourceId: "myjcb", label, fetchedAt });

describe("the capture day in Asia/Tokyo", () => {
  test("an instant is read on the Japanese civil day, not the UTC one", () => {
    // 23:59:59.999 and 00:00 JST on either side of the UTC date's own midnight.
    expect(civilDateInZone("2026-09-15T14:59:59.999Z", "Asia/Tokyo")).toEqual({
      year: 2026,
      month: 9,
      day: 15,
    });
    expect(civilDateInZone("2026-09-15T15:00:00.000Z", "Asia/Tokyo")).toEqual({
      year: 2026,
      month: 9,
      day: 16,
    });
    expect(civilDateInZone("2026-09-16T00:30:00+09:00", "Asia/Tokyo")).toEqual({
      year: 2026,
      month: 9,
      day: 16,
    });
    expect(civilDateInZone("2026-12-31T15:00:00Z", "Asia/Tokyo")).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
  });

  test("a zone without a fixed offset here, or text that is not an instant, has no day", () => {
    expect(civilDateInZone("2026-09-15T15:00:00Z", "Australia/Sydney")).toBeNull();
    expect(civilDateInZone("2026-09-15", "Asia/Tokyo")).toBeNull();
    expect(civilDateInZone("2026-09-15 15:00:00", "Asia/Tokyo")).toBeNull();
    expect(civilDateInZone("2026-02-30T00:00:00Z", "Asia/Tokyo")).toBeNull();
  });
});

describe("MyJCB detailMonth-N under relative-statement-period-v1", () => {
  test("the rule is versioned and names its zone and closing day", () => {
    expect(RELATIVE_PERIOD_RULE).toBe("relative-statement-period-v1");
    expect(RELATIVE_PERIOD_ZONE).toBe("Asia/Tokyo");
    expect(MYJCB_CLOSING_DAY).toBe(15);
  });

  test("detailMonth-0 is the payment month of the capture day's cycle; detailMonth-1 the one before", () => {
    // Captured on the 5th: the cycle closing on the 15th is paid next month.
    expect(myjcb("detailMonth-0", "2026-09-05T00:00:00.000Z")).toBe("2026-10");
    expect(myjcb("detailMonth-1", "2026-09-05T00:00:00.000Z")).toBe("2026-09");
    // Captured after the 15th: usage belongs to the cycle paid the month after next.
    expect(myjcb("detailMonth-0", "2026-09-26T00:00:00.000Z")).toBe("2026-11");
    expect(myjcb("detailMonth-1", "2026-09-26T00:00:00.000Z")).toBe("2026-10");
  });

  test("the positions follow the billing cycle, not the calendar month", () => {
    // The last day of a month and the first of the next are one cycle, so
    // the same position names the same payment month on both sides (what the
    // production captures showed); "N months before the capture month" would not.
    for (const fetchedAt of ["2026-08-31T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]) {
      expect(myjcb("detailMonth-0", fetchedAt)).toBe("2026-10");
      expect(myjcb("detailMonth-1", fetchedAt)).toBe("2026-09");
    }
  });

  test("the closing day is read in Asia/Tokyo, so a capture near midnight UTC lands on its JST day", () => {
    // 2026-09-15 23:59:59.999 JST: still the cycle that closes that day.
    expect(myjcb("detailMonth-0", "2026-09-15T14:59:59.999Z")).toBe("2026-10");
    // 2026-09-16 00:00 JST, though the UTC date is still the 15th: the next cycle.
    expect(myjcb("detailMonth-0", "2026-09-15T15:00:00.000Z")).toBe("2026-11");
    expect(myjcb("detailMonth-1", "2026-09-15T15:00:00.000Z")).toBe("2026-10");
    // An explicit offset is honoured the same way.
    expect(myjcb("detailMonth-0", "2026-09-16T08:59:59+09:00")).toBe("2026-11");
    expect(myjcb("detailMonth-0", "2026-09-16T08:59:59-00:00")).toBe("2026-11");
  });

  test("month arithmetic crosses year boundaries", () => {
    expect(myjcb("detailMonth-0", "2026-11-20T00:00:00.000Z")).toBe("2027-01");
    expect(myjcb("detailMonth-1", "2026-11-20T00:00:00.000Z")).toBe("2026-12");
    expect(myjcb("detailMonth-0", "2026-12-20T00:00:00.000Z")).toBe("2027-02");
    expect(myjcb("detailMonth-1", "2026-12-20T00:00:00.000Z")).toBe("2027-01");
    expect(myjcb("detailMonth-0", "2026-12-10T00:00:00.000Z")).toBe("2027-01");
    expect(myjcb("detailMonth-1", "2026-12-10T00:00:00.000Z")).toBe("2026-12");
    expect(myjcb("detailMonth-1", "2027-01-05T00:00:00.000Z")).toBe("2027-01");
    // New Year's Day in Tokyo is still New Year's Eve in UTC.
    expect(myjcb("detailMonth-0", "2026-12-31T15:00:00.000Z")).toBe("2027-02");
    expect(myjcb("detailMonth-1", "2026-12-31T14:59:59.000Z")).toBe("2027-01");
  });

  test("positions the evidence does not place, and every other shape, are null", () => {
    const at = "2026-09-05T00:00:00.000Z";
    for (let position = 2; position <= 17; position += 1)
      expect(myjcb(`detailMonth-${position}`, at)).toBeNull();
    for (const label of [
      "detailMonth-18",
      "detailMonth-01",
      "detailMonth--1",
      "detailMonth-",
      "detailMonth-0 ",
      "detailmonth-0",
      "detailMonth-０",
      "2026年9月お支払い分",
      "202609",
      "",
    ])
      expect(myjcb(label, at)).toBeNull();
    expect(myjcb(null, at)).toBeNull();
    expect(myjcb("detailMonth-0", null)).toBeNull();
    expect(myjcb("detailMonth-0", "2026-09-05")).toBeNull();
    expect(myjcb("detailMonth-0", "not a time")).toBeNull();
    // Only MyJCB's labels are relative; nothing else is resolved.
    expect(
      resolveRelativePeriod({ sourceId: "vpass", label: "detailMonth-0", fetchedAt: at }),
    ).toBeNull();
  });

  test("a usage row's period: its absolute label first, else its relative label and capture time", () => {
    const row = (statementPeriod: string | null, capturedAt: string | null, sourceId = "myjcb") =>
      cardStatementPeriod({ sourceId, statementPeriod, capturedAt });
    expect(row("2026年7月お支払い分", "2026-09-05T00:00:00.000Z")).toBe("2026-07");
    expect(row("2026年7月お支払い分", null)).toBe("2026-07");
    expect(row("202609", null, "vpass")).toBe("2026-09");
    expect(row("detailMonth-0", "2026-09-05T00:00:00.000Z")).toBe("2026-10");
    expect(row("detailMonth-1", "2026-09-26T00:00:00.000Z")).toBe("2026-10");
    expect(row("detailMonth-0", null)).toBeNull();
    expect(row("detailMonth-2", "2026-09-05T00:00:00.000Z")).toBeNull();
    expect(row(null, "2026-09-05T00:00:00.000Z")).toBeNull();
  });
});
