import { describe, expect, test } from "bun:test";
import { defaultWindow } from "../src/worker";

// The window names Japanese calendar dates: Sony Bank books in JST, so "today"
// is the JST date, whatever the Worker's UTC clock says.
describe("defaultWindow", () => {
  test("ends on the JST date before 09:00 JST", () => {
    // 2026-03-17T06:30+09:00 is still 2026-03-16 in UTC.
    expect(defaultWindow(new Date("2026-03-16T21:30:00Z"))).toEqual({
      from: "2026-03-01",
      to: "2026-03-17",
    });
  });

  test("starts the new JST month on its first morning", () => {
    // 2026-04-01T00:05+09:00 is 2026-03-31 in UTC.
    expect(defaultWindow(new Date("2026-03-31T15:05:00Z"))).toEqual({
      from: "2026-04-01",
      to: "2026-04-01",
    });
  });

  test("matches the UTC date after 09:00 JST", () => {
    expect(defaultWindow(new Date("2026-03-16T03:00:00Z"))).toEqual({
      from: "2026-03-01",
      to: "2026-03-16",
    });
  });

  test("the last instant of a JST year stays in that year", () => {
    // 2026-12-31T23:59:59.999+09:00.
    expect(defaultWindow(new Date("2026-12-31T14:59:59.999Z"))).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    // 2027-01-01T00:00+09:00.
    expect(defaultWindow(new Date("2026-12-31T15:00:00Z"))).toEqual({
      from: "2027-01-01",
      to: "2027-01-01",
    });
  });
});
