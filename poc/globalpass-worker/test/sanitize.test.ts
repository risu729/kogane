import { describe, expect, test } from "bun:test";
import {
  NABLARCH_HIDDEN_SENTINEL,
  sanitizeGlobalPassActivityHtml,
} from "../src/sanitize";

describe("GLOBAL PASS HTML sanitizer", () => {
  test("redacts only the four nonempty dynamic values in variant A", async () => {
    const input = fixture("a");
    const output = sanitizeGlobalPassActivityHtml(input);
    expect(output.match(new RegExp(NABLARCH_HIDDEN_SENTINEL, "gu")))
      .toHaveLength(4);
    expect(output).not.toContain("opaque-");
    expect(output).toContain('name="W131301.referenceDate" value="2099-01"');
    expect(output.match(/name="nablarch_hidden" value=""/gu)).toHaveLength(2);
    expect(output).toContain('href="#"');
    expect(output).toContain('onclick="return false;"');
    expect(output).toContain('onchange="return false;"');
    expect(output).not.toContain("#activity");
    expect(output).not.toContain("sel_submit(this)");
    expect(sanitizeGlobalPassActivityHtml(input)).toBe(output);
    expect(await sha256(output)).not.toBe(await sha256(input));
  });

  test("accepts the reviewed no-reference-date variant B", () => {
    const output = sanitizeGlobalPassActivityHtml(fixture("b"));
    expect(output.match(new RegExp(NABLARCH_HIDDEN_SENTINEL, "gu")))
      .toHaveLength(3);
    expect(output).not.toContain("W131301.referenceDate");
  });

  test("fails closed on hidden-name, form-action and count drift", () => {
    expect(() => sanitizeGlobalPassActivityHtml(
      fixture("a").replace('name="cc"', 'name="unknown_state"'),
    )).toThrow("globalpass_html_contract_invalid");
    expect(() => sanitizeGlobalPassActivityHtml(
      fixture("a").replace(
        "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301",
        "https://example.invalid/write",
      ),
    )).toThrow("globalpass_html_contract_invalid");
    expect(() => sanitizeGlobalPassActivityHtml(
      fixture("a").replace(
        /<input type="hidden" name="nablarch_hidden" value="" data-index="4">/u,
        "",
      ),
    )).toThrow("globalpass_html_shape_unreviewed");
    expect(() => sanitizeGlobalPassActivityHtml(
      fixture("a").replace("/js/run.js", "/js/run.js?token=opaque"),
    )).toThrow("globalpass_html_contract_invalid");
    expect(() => sanitizeGlobalPassActivityHtml(
      fixture("a").replace('onclick="click()"', 'onload="click()"'),
    )).toThrow("globalpass_html_contract_invalid");
    expect(() => sanitizeGlobalPassActivityHtml(
      fixture("a").replace("<form", '<form action=""'),
    )).toThrow("globalpass_html_contract_invalid");
  });

  test("rejects login state, forbidden markers and invalid UTF-8 scalars", () => {
    expect(() => sanitizeGlobalPassActivityHtml(
      fixture("a").replace(
        "</body>",
        '<input type="password" id="password"></body>',
      ),
    )).toThrow("globalpass_html_contract_invalid");
    expect(() => sanitizeGlobalPassActivityHtml(
      fixture("a").replace("</body>", "<script>session</script></body>"),
    )).toThrow("globalpass_html_contract_invalid");
    expect(() => sanitizeGlobalPassActivityHtml(fixture("a") + "\ud800"))
      .toThrow("globalpass_html_utf8_invalid");
  });

  test("rejects unreviewed network and navigation sinks", () => {
    const valid = fixture("a");
    for (const injected of [
      '<img src="/en/01006/img/logo.jpg" srcset="https://example.invalid/x 1x">',
      '<a href="#activity" ping="https://example.invalid/p">x</a>',
      '<div style="background:url(https://example.invalid/x)"></div>',
      '<style>@import "https://example.invalid/x";</style>',
      '<meta http-equiv="refresh" content="0;url=https://example.invalid/x">',
      '<svg><use href="https://example.invalid/x"></use></svg>',
      '<base href="https://example.invalid/">',
      '<object data="https://example.invalid/x"></object>',
      '<embed src="https://example.invalid/x">',
      '<iframe src="https://example.invalid/x"></iframe>',
    ]) {
      expect(() => sanitizeGlobalPassActivityHtml(
        valid.replace("</body>", `${injected}</body>`),
      )).toThrow("globalpass_html_contract_invalid");
    }
    expect(() => sanitizeGlobalPassActivityHtml(
      valid.replace('name="cc"', 'id="one" id="two" name="cc"'),
    )).toThrow("globalpass_html_contract_invalid");
  });
});

function fixture(variant: "a" | "b"): string {
  const dynamic = variant === "a"
    ? ["opaque-1", "opaque-2", "opaque-3", "opaque-4", "", ""]
    : ["opaque-1", "opaque-2", "opaque-3", ""];
  const submits = Array.from({ length: variant === "a" ? 6 : 4 }, () =>
    '<input type="hidden" name="nablarch_submit" value="1">'
  ).join("");
  const forms = Array.from({ length: variant === "a" ? 6 : 5 }, (_, index) => {
    const action = variant === "a" && index === 0
      ? ' action="https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301"'
      : "";
    return `<form${action}></form>`;
  }).join("");
  return "<!DOCTYPE html><html><head>" +
    '<link rel="stylesheet" href="/en//01006/css/master.css">' +
    '<script src="/js/run.js"></script></head><body><h1>ご利用明細</h1>' +
    '<a href="#activity" onclick="click()">明細</a>' +
    '<select onchange="sel_submit(this)"></select>' +
    '<input type="hidden" name="cc" value="01006">' +
    '<input type="hidden" name="engUseFlg" value="0">' +
    '<input type="hidden" name="nablarch_needs_hidden_encryption" value="1">' +
    dynamic.map((value, index) =>
      `<input type="hidden" name="nablarch_hidden" value="${value}" data-index="${index}">`
    ).join("") +
    submits +
    (variant === "a"
      ? '<input type="hidden" name="W131301.referenceDate" value="2099-01">'
      : "") +
    forms +
    "</body></html>";
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
