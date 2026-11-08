import { expect, test } from "bun:test";
import { civilDateInZone } from "../src/relative-period.ts";

test("every inherited object key is an unsupported zone", () => {
  for (const zone of Object.getOwnPropertyNames(Object.prototype)) {
    expect(civilDateInZone("2026-09-15T15:00:00Z", zone)).toBeNull();
    expect(civilDateInZone("invalid", zone)).toBeNull();
  }
});

test("only the registered zone resolves across the JST day boundary", () => {
  for (const zone of ["", "UTC", "Asia/Tokyo ", "asia/tokyo", "Australia/Sydney"]) {
    expect(civilDateInZone("2026-09-15T15:00:00Z", zone)).toBeNull();
  }
  expect(civilDateInZone("2026-09-15T14:59:59Z", "Asia/Tokyo")).toEqual({
    year: 2026,
    month: 9,
    day: 15,
  });
  expect(civilDateInZone("2026-09-15T15:00:00Z", "Asia/Tokyo")).toEqual({
    year: 2026,
    month: 9,
    day: 16,
  });
});
