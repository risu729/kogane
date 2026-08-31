import { describe, expect, test } from "bun:test";
import { runPrefix } from "../src/storage";

describe("SBI Shinsei raw storage", () => {
  test("uses a source/date/run isolated prefix", () => {
    expect(runPrefix(
      "2026-08-31T01:02:03.000Z",
      "00000000-0000-4000-8000-000000000000",
    )).toBe(
      "raw/sbi-shinsei/2026/08/31/00000000-0000-4000-8000-000000000000",
    );
  });
});
