import { describe, expect, test } from "bun:test";
import { findForm, summarizeHtml } from "../src/html";

const encoder = new TextEncoder();

describe("PRESTIA HTML parser", () => {
  test("extracts successful controls without exposing values in summary", () => {
    const html = `
      <form name="POSNIN1" method="post">
        <input type="hidden" name="_TOKEN" value="secret-token">
        <input name="userId" value="">
        <input type="checkbox" name="remember" value="1">
      </form>`;
    expect(findForm(html, "POSNIN1")?.fields).toEqual([
      ["_TOKEN", "secret-token"],
      ["userId", ""],
    ]);
    expect(JSON.stringify(summarizeHtml(encoder.encode(html)))).not.toContain("secret-token");
  });

  test("classifies OTP and home responses", () => {
    const otp = summarizeHtml(encoder.encode('<form name="AUOTIN1"><input name="otp"></form>'));
    expect(otp.otpFormPresent).toBe(true);
    const home = summarizeHtml(
      encoder.encode('<form name="POMHTOP"><input name="hashedCIF" value="private"></form>'),
    );
    expect(home.homeFormPresent).toBe(true);
    expect(home.hashedCifPresent).toBe(true);
    expect(JSON.stringify(home)).not.toContain("private");
  });

  test("reports an error container without exposing its text", () => {
    const summary = summarizeHtml(
      encoder.encode('<div id="errorMsgArea">account-specific private text</div>'),
    );
    expect(summary.errorBlockPresent).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("account-specific private text");
  });
});
