import { describe, expect, test } from "bun:test";
import { defaultWindow } from "../src/worker";

// The window names Japanese calendar dates: Sony Bank books in JST, so the
// window ends on yesterday's JST date (the last finished JST day), whatever
// the Worker's UTC clock says, and starts on the first of that day's month.
describe("defaultWindow", () => {
  test("the daily 06:00 JST run ends on the previous JST day", () => {
    // 2026-03-17T06:00+09:00 is 2026-03-16T21:00Z.
    expect(defaultWindow(new Date("2026-03-16T21:00:00Z"))).toEqual({
      from: "2026-03-01",
      to: "2026-03-16",
    });
  });

  test("a run after 09:00 JST still ends on the previous JST day", () => {
    // 2026-03-16T12:00+09:00: the UTC date is already the 16th, which is not over.
    expect(defaultWindow(new Date("2026-03-16T03:00:00Z"))).toEqual({
      from: "2026-03-01",
      to: "2026-03-15",
    });
  });

  test("every JST day of a month is requested after it ends, the last one included", () => {
    // Daily 06:00 JST runs from 2026-03-30 to 2026-04-02.
    const windows = [
      "2026-03-29T21:00:00Z",
      "2026-03-30T21:00:00Z",
      "2026-03-31T21:00:00Z",
      "2026-04-01T21:00:00Z",
    ].map((instant) => defaultWindow(new Date(instant)));
    expect(windows).toEqual([
      { from: "2026-03-01", to: "2026-03-29" },
      { from: "2026-03-01", to: "2026-03-30" },
      { from: "2026-03-01", to: "2026-03-31" },
      { from: "2026-04-01", to: "2026-04-01" },
    ]);
  });

  test("a run late on the first JST day of a month requests the whole previous month", () => {
    // 2026-04-01T22:00+09:00 is 2026-04-01T13:00Z: the UTC date is the 1st too.
    expect(defaultWindow(new Date("2026-04-01T13:00:00Z"))).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
  });

  test("the JST year boundary", () => {
    // 2026-12-31T23:59:59.999+09:00.
    expect(defaultWindow(new Date("2026-12-31T14:59:59.999Z"))).toEqual({
      from: "2026-12-01",
      to: "2026-12-30",
    });
    // 2027-01-01T00:00+09:00.
    expect(defaultWindow(new Date("2026-12-31T15:00:00Z"))).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });
});
