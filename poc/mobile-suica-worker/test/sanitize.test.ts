import { describe, expect, test } from "bun:test";
import { decode } from "iconv-lite";
import { REDACTED_BASE_VARIABLE, sanitizeHistoryHtml } from "../src/sanitize";

describe("Mobile Suica history sanitizer", () => {
  test("redacts deterministically while preserving Japanese CP932 text", () => {
    const html = `<html><body>利用履歴<input value="sensitive-state" TYPE="HiDdEn" name="BASEVARIABLE"><p>東京駅</p></body></html>`;
    const first = sanitizeHistoryHtml(html);
    const second = sanitizeHistoryHtml(html);
    expect(first).toEqual(second);
    const decoded = decode(first, "shift_jis");
    expect(decoded).toContain("利用履歴");
    expect(decoded).toContain("東京駅");
    expect(decoded).toContain(REDACTED_BASE_VARIABLE);
    expect(decoded).not.toContain("sensitive-state");
  });

  test("rejects a missing baseVariable input", () => {
    expect(() => sanitizeHistoryHtml("<html><body>履歴</body></html>"))
      .toThrow("history_base_variable_count_invalid");
  });

  test("rejects multiple baseVariable inputs", () => {
    const html = `<input type="hidden" name="baseVariable" value="a"><input type="hidden" name="baseVariable" value="b">`;
    expect(() => sanitizeHistoryHtml(html)).toThrow("history_base_variable_count_invalid");
  });

  test("rejects an empty baseVariable value", () => {
    expect(() => sanitizeHistoryHtml(`<input type="hidden" name="baseVariable" value="">`))
      .toThrow("history_base_variable_empty");
  });

  test("rejects duplicate value attributes without leaving a secret behind", () => {
    expect(() => sanitizeHistoryHtml(
      `<input type="hidden" name="baseVariable" value="first-secret" value="second-secret">`,
    )).toThrow("history_base_variable_value_count_invalid");
  });

  test("rejects a baseVariable value repeated elsewhere in the provider HTML", () => {
    expect(() => sanitizeHistoryHtml(
      `<input type="hidden" name="baseVariable" value="repeated-secret"><script>repeated-secret</script>`,
    )).toThrow("history_base_variable_redaction_incomplete");
  });

  test("rejects a non-hidden baseVariable input", () => {
    expect(() => sanitizeHistoryHtml(
      `<input type="text" name="baseVariable" value="sensitive-state">`,
    )).toThrow("history_base_variable_type_invalid");
  });

  test("rejects duplicate type attributes", () => {
    expect(() => sanitizeHistoryHtml(
      `<input type="hidden" type="text" name="baseVariable" value="sensitive-state">`,
    )).toThrow("history_base_variable_type_invalid");
  });

  test("rejects duplicate name attributes", () => {
    expect(() => sanitizeHistoryHtml(
      `<input type="hidden" name="baseVariable" name="other" value="sensitive-state">`,
    )).toThrow("history_base_variable_name_invalid");
  });

  test("finds baseVariable in any name attribute and fails closed", () => {
    expect(() => sanitizeHistoryHtml(
      `<input type="hidden" name="other" name="baseVariable" value="sensitive-state">`,
    )).toThrow("history_base_variable_name_invalid");
  });
});
