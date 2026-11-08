// `collection-freshness-v1` (src/collection-freshness.ts): ages in Asia/Tokyo
// civil days, the `dated-state-freshness-v1` thresholds, and what a source
// waits on explaining a capture that is not fresh. Synthetic instants only.
import { describe, expect, test } from "bun:test";
import {
  COLLECTION_FRESHNESS_STATES,
  collectionFreshness,
  consistentFreshness,
  tokyoDate,
  type CollectionWait,
} from "../src/collection-freshness.ts";

describe("tokyoDate", () => {
  test("is the civil date in Asia/Tokyo of any instant", () => {
    expect(tokyoDate("2099-01-01T14:59:59.999Z")).toBe("2099-01-01");
    expect(tokyoDate("2099-01-01T15:00:00Z")).toBe("2099-01-02");
    expect(tokyoDate("2099-01-02T00:00:00+09:00")).toBe("2099-01-02");
    expect(tokyoDate("2098-12-31T23:59:59-10:00")).toBe("2099-01-01");
    expect(tokyoDate("2099-01-01")).toBeNull();
    expect(tokyoDate("not an instant")).toBeNull();
  });
});

describe("collectionFreshness", () => {
  test.each([
    ["2099-03-01T00:00:00Z", 0, "same-day"],
    ["2099-02-28T15:00:00Z", 0, "same-day"],
    ["2099-02-28T14:59:59Z", 1, "recent"],
    ["2099-02-26T00:00:00Z", 3, "recent"],
    ["2099-02-25T00:00:00Z", 4, "stale"],
    ["2098-03-01T00:00:00Z", 365, "stale"],
  ] as const)("%s on 2099-03-01 is %d days, %s", (capturedAt, ageDays, state) => {
    expect(collectionFreshness(capturedAt, "2099-03-01", null)).toEqual({ state, ageDays });
  });

  test("a capture after the as-of date is age 0, never negative", () => {
    expect(collectionFreshness("2099-03-05T00:00:00Z", "2099-03-01", null)).toEqual({
      state: "same-day",
      ageDays: 0,
    });
  });

  test("a wait explains a stale or missing capture, never a fresh one", () => {
    for (const wait of ["human-required", "disabled"] as const) {
      expect(collectionFreshness("2099-02-26T00:00:00Z", "2099-03-01", wait)).toEqual({
        state: "recent",
        ageDays: 3,
      });
      expect(collectionFreshness("2099-02-01T00:00:00Z", "2099-03-01", wait)).toEqual({
        state: wait,
        ageDays: 28,
      });
      expect(collectionFreshness(null, "2099-03-01", wait)).toEqual({ state: wait, ageDays: null });
    }
    expect(collectionFreshness(null, "2099-03-01", null)).toEqual({
      state: "no-capture",
      ageDays: null,
    });
  });

  test("refuses an as-of date or a capture time that is not one", () => {
    expect(() => collectionFreshness(null, "2099-02-30", null)).toThrow("invalid_as_of");
    expect(() => collectionFreshness("yesterday", "2099-03-01", null)).toThrow(
      "invalid_capture_time",
    );
  });
});

describe("consistentFreshness", () => {
  test("accepts every answer the policy gives and nothing else", () => {
    const given = new Set<string>();
    const waits: CollectionWait[] = [null, "human-required", "disabled"];
    for (const wait of waits)
      for (const capturedAt of [
        null,
        ...Array.from({ length: 8 }, (_, day) => `2099-03-0${day + 1}T00:00:00Z`),
      ]) {
        const value = collectionFreshness(capturedAt, "2099-03-08", wait);
        expect(consistentFreshness(value)).toBe(true);
        given.add(
          JSON.stringify([value.state, value.ageDays === null ? null : Math.min(value.ageDays, 4)]),
        );
      }
    for (const state of COLLECTION_FRESHNESS_STATES)
      for (const ageDays of [null, 0, 1, 3, 4, 40]) {
        const key = JSON.stringify([state, ageDays === null ? null : Math.min(ageDays, 4)]);
        expect(consistentFreshness({ state, ageDays })).toBe(given.has(key));
      }
    expect(consistentFreshness({ state: "stale", ageDays: -1 })).toBe(false);
    expect(consistentFreshness({ state: "stale", ageDays: 4.5 })).toBe(false);
  });
});
