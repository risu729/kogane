import { describe, expect, test } from "bun:test";
import { parseMode, runPrefix, safeMonth } from "../src/model";

describe("GLOBAL PASS collection model", () => {
  test("defaults to the bounded daily mode", () => {
    expect(parseMode(null)).toBe("daily");
    expect(parseMode("daily")).toBe("daily");
    expect(parseMode("backfill")).toBe("backfill");
    expect(() => parseMode("all")).toThrow();
  });

  test("accepts only canonical retained months", () => {
    expect(safeMonth("2026-08")).toBe("2026-08");
    expect(() => safeMonth("../../secret")).toThrow();
    expect(() => safeMonth("2026-13")).toThrow();
  });

  test("uses the source-specific private R2 prefix", () => {
    expect(runPrefix("2026-08-27T12:00:00.000Z", "run-id")).toBe(
      "raw/prestia-globalpass/2026/08/27/run-id",
    );
  });
});
