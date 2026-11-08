// The load fixture's shape comes from the environment of whoever runs a
// measurement, so every value it reads is refused when it is not one the
// generator can use, rather than turned into a different fixture than the one
// asked for. Synthetic inputs only.
import { describe, expect, test } from "bun:test";
import { DEFAULT_SHAPE, balanceRows, shapeFromEnv } from "./load-fixture.ts";

describe("the load fixture's shape from the environment", () => {
  test("unset values keep the default shape", () => {
    expect(shapeFromEnv({})).toEqual(DEFAULT_SHAPE);
  });

  test("a calendar start date is the first civil day of the history", () => {
    const shape = shapeFromEnv({ KOGANE_LOAD_START: "2024-02-29", KOGANE_LOAD_DAYS: "2" });
    expect(shape.startDate).toBe("2024-02-29");
    expect(
      [...balanceRows({ ...shape, units: 1, observationsPerDay: 1 })].map((row) => row.asOf),
    ).toEqual(["2024-02-29", "2024-03-01"]);
  });

  test("a start date that is not a calendar day is refused, not rolled over", () => {
    for (const value of [
      "",
      "2026-1-01",
      "2026/01/01",
      "2026-01-01T00:00:00Z",
      " 2026-01-01",
      "2026-02-30",
      "2025-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "tomorrow",
    ])
      expect(() => shapeFromEnv({ KOGANE_LOAD_START: value })).toThrow(
        new RangeError("KOGANE_LOAD_START must be a calendar date YYYY-MM-DD"),
      );
  });
});
