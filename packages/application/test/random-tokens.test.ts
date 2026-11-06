import { describe, expect, test } from "bun:test";
import { maskRandomTokens } from "./random-tokens.ts";

describe("maskRandomTokens", () => {
  test("a planted amount inside a random id, digest or clock is masked", () => {
    const text = JSON.stringify({
      audit_id: "aud_3987658a-0b1c-4d2e-8f30-123456789abc",
      correlation_id: "0198765f-1234-4abc-9def-0123456789ab",
      payload_digest: `0${"98765".repeat(12)}abc`,
      rule: "maintenance-rule:vpass-a98765123456",
      started_at_ms: 1798765432101,
    });
    const masked = maskRandomTokens(text);
    expect(masked).not.toContain("98765");
    expect(masked).not.toContain("1234");
    expect(masked).toContain("aud_<uuid>");
    expect(masked).toContain("vpass-<hex>");
  });

  test("a planted value written as a value of its own stays visible", () => {
    for (const leaked of [
      { amount_minor: 98765 },
      { description: "¥98765" },
      { reference: "https://example.invalid/x?a=123456" },
      { diff: "98765JPY" },
      { recorded_at: "2026-09-07T12:34:56.789Z", refs: ["decision:98765"] },
    ]) {
      const masked = maskRandomTokens(JSON.stringify(leaked));
      expect(masked).toBe(JSON.stringify(leaked));
    }
  });

  test("a planted value joined into a run of twelve or more digits is masked too (the stated limit)", () => {
    for (const hidden of [{ amount_micro: 987650000000 }, { blob: "abcdef98765012" }])
      expect(maskRandomTokens(JSON.stringify(hidden))).not.toContain("98765");
  });
});
