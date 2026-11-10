// A card settlement page whose next page the row budget withholds still has
// rows after it, so its audit record says it was cut (ADR 0081, 2026-11-08
// amendment).
import { describe, expect, it } from "vitest";
import { rowsFollow } from "../src/audit";

describe("card settlement audit truncation", () => {
  it("counts a withheld next page as rows that follow", () => {
    expect(rowsFollow({ nextOffset: 50, nextPage: "offered" })).toBe(true);
    expect(rowsFollow({ nextOffset: null, nextPage: "budget_exceeded" })).toBe(true);
    expect(rowsFollow({ nextOffset: null, nextPage: "none" })).toBe(false);
  });
});
