// Civil dates of instants in named zones (src/civil-date.ts, ADR 0056).
import { describe, expect, test } from "bun:test";
import { canonicalZone, civilDateOfInstant } from "../src/civil-date.ts";
import { captureDate } from "../src/reported-state.ts";

describe("civil date of an instant in a named zone", () => {
  test("matches the dated state's capture date in Asia/Tokyo across midnight", () => {
    for (const at of [
      "2026-09-09T14:59:59.999Z",
      "2026-09-09T15:00:00.000Z",
      "2026-09-09T15:30:00.000Z",
      "2026-12-31T15:00:00.000Z",
      "2024-02-28T15:00:00.000Z",
      "2026-09-10T00:00:00.000Z",
    ])
      expect(civilDateOfInstant(at, "Asia/Tokyo")).toBe(captureDate(at));
  });

  test("an instant's own offset is applied before the zone", () => {
    // 08:00+09:00 is 23:00Z of the previous day.
    expect(civilDateOfInstant("2026-09-07T08:00:00+09:00", "UTC")).toBe("2026-09-06");
    expect(civilDateOfInstant("2026-09-07T08:00:00+09:00", "Asia/Tokyo")).toBe("2026-09-07");
    expect(civilDateOfInstant("2026-09-06T23:59:59.999999999Z", "Asia/Tokyo")).toBe("2026-09-07");
    // Sydney is UTC+10 in September and UTC+11 in summer time (DST from 2026-10-04).
    expect(civilDateOfInstant("2026-09-06T13:59:59Z", "Australia/Sydney")).toBe("2026-09-06");
    expect(civilDateOfInstant("2026-09-06T14:00:00Z", "Australia/Sydney")).toBe("2026-09-07");
    expect(civilDateOfInstant("2026-12-06T13:00:00Z", "Australia/Sydney")).toBe("2026-12-07");
  });

  test("an unknown zone or a non-instant is null, never UTC", () => {
    expect(civilDateOfInstant("2026-09-07T00:00:00Z", "Mars/Olympus_Mons")).toBeNull();
    expect(civilDateOfInstant("2026-09-07T00:00:00Z", "+09:00")).toBeNull();
    expect(civilDateOfInstant("2026-09-07T00:00:00Z", "")).toBeNull();
    expect(civilDateOfInstant("2026-09-07", "Asia/Tokyo")).toBeNull();
    expect(civilDateOfInstant("2026-09-07T00:00:00", "Asia/Tokyo")).toBeNull();
    // Year 0 is rendered as an era year by the runtime; refused rather than misread.
    expect(civilDateOfInstant("0000-01-01T12:00:00Z", "UTC")).toBeNull();
  });

  test("the runtime's spelling of a zone, or null", () => {
    expect(canonicalZone("asia/tokyo")).toBe("Asia/Tokyo");
    expect(canonicalZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(canonicalZone("Mars/Olympus_Mons")).toBeNull();
    expect(canonicalZone("+09:00")).toBeNull();
  });
});
