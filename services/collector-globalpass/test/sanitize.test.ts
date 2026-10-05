import { describe, expect, test } from "bun:test";
import { safeShape } from "../../../packages/collector-diagnostics/src/index";
import {
  GLOBALPASS_SANITIZER_ATTRIBUTES,
  GLOBALPASS_SANITIZER_CODES,
  GLOBALPASS_SANITIZER_ELEMENTS,
  GLOBALPASS_SANITIZER_EXPECTATIONS,
  GlobalPassSanitizerError,
  globalPassRefusalShape,
  NABLARCH_HIDDEN_SENTINEL,
  sanitizeGlobalPassActivityHtml,
  sanitizerCode,
  sanitizerExpectation,
} from "../src/sanitize";
import { fixture } from "./activity-fixture";

describe("GLOBAL PASS HTML sanitizer", () => {
  test("redacts only the four nonempty dynamic values in variant A", async () => {
    const input = fixture("a");
    const output = sanitizeGlobalPassActivityHtml(input);
    expect(output.match(new RegExp(NABLARCH_HIDDEN_SENTINEL, "gu"))).toHaveLength(4);
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

  test("accepts the activity page in English as well as in Japanese", () => {
    // The collector's session is English: the live page's title is
    // `Account Activities` and its heading `Viewing Monthly Account
    // Activities`, with no Japanese statement name anywhere.
    const english = fixture("a")
      .replace("<head>", "<head><title>Account Activities</title>")
      .replace("<h1>ご利用明細</h1>", "<h2>Viewing Monthly Account Activities</h2>")
      .replace(">明細</a>", ">Account Activities</a>");
    expect(english).not.toMatch(/明細/u);
    const output = sanitizeGlobalPassActivityHtml(english);
    expect(output.match(new RegExp(NABLARCH_HIDDEN_SENTINEL, "gu"))).toHaveLength(4);
    expect(output).toContain("<title>Account Activities</title>");
    expect(sanitizeGlobalPassActivityHtml(fixture("a"))).toContain("ご利用明細");
    // The refusal diagnostic reads the same landmark in either language.
    const shape = globalPassRefusalShape(
      english,
      new GlobalPassSanitizerError("globalpass_html_contract_invalid", {
        expectation: "forbidden_token",
        phase: "input",
      }),
    ) as { landmarks: { activityHeading: boolean; activityHeadingInTitle: boolean } };
    expect(shape.landmarks.activityHeading).toBe(true);
    expect(shape.landmarks.activityHeadingInTitle).toBe(true);
    // The English name in the title alone is enough, as 「ご利用明細」 alone is.
    const titleOnly = fixture("a")
      .replace("<head>", "<head><title>Account Activities</title>")
      .replace("<h1>ご利用明細</h1>", "");
    expect(() => sanitizeGlobalPassActivityHtml(titleOnly)).not.toThrow();
    // Neither name, nor a near miss: still refused.
    for (const heading of ["Account", "Activities", "account activities"]) {
      const page = fixture("a").replace("<h1>ご利用明細</h1>", `<h1>${heading}</h1>`);
      expect(sanitizerExpectation(captured(() => sanitizeGlobalPassActivityHtml(page)))).toBe(
        "activity_heading_missing",
      );
    }
  });

  test("accepts a Japanese month page with its pager and table labels (2026-10-04)", () => {
    // The display language is a browser cookie the collector does not set, so
    // a run may receive the Japanese page: title 利用明細照会, the month as an
    // h3, the twelve Japanese th labels in either line-break notation, and the
    // pager in Japanese with the same markup as in English.
    const labels = [
      "お取引日",
      "お取引内容",
      "お取引通貨<br>金額",
      "お取引手数料",
      "ATM手数料",
      "為替手数料",
      "確定状態",
      "承認番号",
      "備考",
      "ご利用通貨<br>金額",
      "ご利用手数料",
      "換算レート",
    ];
    const pager =
      '<div class="nablarch_paging"><div class="resultCountHeader">検索結果 16件</div>' +
      '<div class="nablarch_currentPageNumber">[1/2ページ]</div>' +
      '<div class="nablarch_prevSubmit">前へ</div><div class="nablarch_nextSubmit">' +
      '<a class="nablarch_nextSubmit" name="nextSubmit" href="/p/statementInquiry/RW1313010201" ' +
      'onclick="return window.nablarch_submit(event, this);" tabindex="0">次へ</a></div></div>';
    const japanese = fixture("b")
      .replace("<head>", "<head><title>利用明細照会</title>")
      .replace("<h1>ご利用明細</h1>", "<h1></h1><h3>2099年2月</h3>")
      .replace(
        "</body>",
        `${pager}<table class="tableStyle4"><tr>${labels.map((label) => `<th>${label}</th>`).join("")}</tr></table>` +
          `<table class="tableStyle4"><tr><td>SYNTHETIC</td></tr></table>${pager}</body>`,
      );
    const output = sanitizeGlobalPassActivityHtml(japanese);
    expect(output).toContain("<title>利用明細照会</title>");
    expect(output).toContain("[1/2ページ]");
    expect(output).toContain("ご利用通貨<br>金額");
    // The pager link keeps its path; its handler is stored as `return false;`.
    expect(output).toContain('href="/p/statementInquiry/RW1313010201" onclick="return false;"');
    expect(output.match(new RegExp(NABLARCH_HIDDEN_SENTINEL, "gu"))).toHaveLength(3);
  });

  test("accepts the English page's relative download action and menu toggle, exactly", () => {
    // What the live English page (2026-09-29) writes where the reviewed pages
    // differ: the download form's action as a relative path, and the
    // `Manage Services` menu toggle, whose `<` a DOM serializer may write as
    // `&lt;`.
    const toggle = (lessThan: string) =>
      `if (window.innerWidth ${lessThan} 640) { $(this.parentNode).toggleClass('closed'); } ` +
      "else { $('#chgAccountSettingMenu')[0].click(); } return false;";
    const english = (lessThan: string) =>
      fixture("a")
        .replace("<head>", "<head><title>Account Activities</title>")
        .replace("<h1>ご利用明細</h1>", "<h2>Viewing Monthly Account Activities</h2>")
        .replace(
          'action="https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301"',
          'action="/p/statementInquiry/RW1313010301"',
        )
        .replace("</body>", `<a href="#" onclick="${toggle(lessThan)}">x</a></body>`);
    for (const lessThan of ["<", "&lt;"]) {
      const output = sanitizeGlobalPassActivityHtml(english(lessThan));
      // Variant A still: the relative action is the one static-action form.
      expect(output.match(new RegExp(NABLARCH_HIDDEN_SENTINEL, "gu"))).toHaveLength(4);
      expect(output).toContain('action="/p/statementInquiry/RW1313010301"');
      // Every handler is stored as `return false;`, the toggle included.
      expect(output).not.toContain("innerWidth");
      expect(output).not.toContain("chgAccountSettingMenu");
      expect(sanitizeGlobalPassActivityHtml(english(lessThan))).toBe(output);
    }

    // Anything else is still refused.
    const page = english("<");
    const refusedAs = (html: string) =>
      sanitizerExpectation(captured(() => sanitizeGlobalPassActivityHtml(html)));
    for (const action of [
      "/p/statementInquiry/RW1313010201",
      "p/statementInquiry/RW1313010301",
      // Only the exact path: no other host, scheme-relative host, query,
      // fragment, trailing slash, dot segment, case change or padding.
      "//www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301",
      "//example.com/p/statementInquiry/RW1313010301",
      "https://example.com/p/statementInquiry/RW1313010301",
      "http://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301",
      "/p/statementInquiry/RW1313010301?next=1",
      "/p/statementInquiry/RW1313010301#x",
      "/p/statementInquiry/RW1313010301/",
      "/p/statementInquiry/../statementInquiry/RW1313010301",
      "/P/statementInquiry/RW1313010301",
      " /p/statementInquiry/RW1313010301",
    ]) {
      expect(
        refusedAs(page.replace('action="/p/statementInquiry/RW1313010301"', `action="${action}"`)),
      ).toBe("action_unallowed");
    }
    for (const handler of [
      toggle("<").replace("closed", "open"),
      toggle("<").replace("#chgAccountSettingMenu", "#other"),
      toggle("<").replace("return false;", "fetch(); return false;"),
      toggle("&gt;"),
      `${toggle("<")} `,
      ` ${toggle("<")}`,
      toggle("<").replaceAll("'", "&#39;"),
      "if (true) { click(); }",
    ]) {
      expect(refusedAs(page.replace(toggle("<"), handler))).toBe("event_handler_unallowed");
    }
    // The toggle is admitted as an onclick only, not as any other handler.
    expect(
      refusedAs(page.replace(`onclick="${toggle("<")}"`, `onmouseover="${toggle("<")}"`)),
    ).toBe("event_handler_unallowed");
    expect(refusedAs(page.replace(`onclick="${toggle("<")}"`, `onchange="${toggle("<")}"`))).toBe(
      "event_handler_unallowed",
    );
  });

  test("accepts the reviewed no-reference-date variant B", () => {
    const output = sanitizeGlobalPassActivityHtml(fixture("b"));
    expect(output.match(new RegExp(NABLARCH_HIDDEN_SENTINEL, "gu"))).toHaveLength(3);
    expect(output).not.toContain("W131301.referenceDate");
  });

  test("fails closed on hidden-name, form-action and count drift", () => {
    expect(() =>
      sanitizeGlobalPassActivityHtml(fixture("a").replace('name="cc"', 'name="unknown_state"')),
    ).toThrow("globalpass_html_contract_invalid");
    expect(() =>
      sanitizeGlobalPassActivityHtml(
        fixture("a").replace(
          "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301",
          "https://example.invalid/write",
        ),
      ),
    ).toThrow("globalpass_html_contract_invalid");
    expect(() =>
      sanitizeGlobalPassActivityHtml(
        fixture("a").replace(
          /<input type="hidden" name="nablarch_hidden" value="" data-index="4">/u,
          "",
        ),
      ),
    ).toThrow("globalpass_html_shape_unreviewed");
    expect(() =>
      sanitizeGlobalPassActivityHtml(fixture("a").replace("/js/run.js", "/js/run.js?token=opaque")),
    ).toThrow("globalpass_html_contract_invalid");
    expect(() =>
      sanitizeGlobalPassActivityHtml(fixture("a").replace('onclick="click()"', 'onload="click()"')),
    ).toThrow("globalpass_html_contract_invalid");
    expect(() =>
      sanitizeGlobalPassActivityHtml(fixture("a").replace("<form", '<form action=""')),
    ).toThrow("globalpass_html_contract_invalid");
  });

  test("rejects login state, forbidden markers and invalid UTF-8 scalars", () => {
    expect(() =>
      sanitizeGlobalPassActivityHtml(
        fixture("a").replace("</body>", '<input type="password" id="password"></body>'),
      ),
    ).toThrow("globalpass_html_contract_invalid");
    expect(() =>
      sanitizeGlobalPassActivityHtml(
        fixture("a").replace("</body>", "<script>session</script></body>"),
      ),
    ).toThrow("globalpass_html_contract_invalid");
    expect(() => sanitizeGlobalPassActivityHtml(fixture("a") + "\ud800")).toThrow(
      "globalpass_html_utf8_invalid",
    );
  });

  test("every refusal is a typed error whose code is one of four and equals its message", () => {
    const thrown = (html: string): unknown => {
      try {
        sanitizeGlobalPassActivityHtml(html);
      } catch (error) {
        return error;
      }
      throw new Error("expected a refusal");
    };
    const cases: Array<[string, string]> = [
      [
        fixture("a").replace('name="cc"', 'name="unknown_state"'),
        "globalpass_html_contract_invalid",
      ],
      [
        fixture("a").replace("</body>", '<input name="nablarch_hidden" value="opaque-x"></body>'),
        "globalpass_html_redaction_failed",
      ],
      [
        fixture("a").replace('<input type="hidden" name="nablarch_submit" value="1">', ""),
        "globalpass_html_shape_unreviewed",
      ],
      [fixture("a") + "\ud800", "globalpass_html_utf8_invalid"],
    ];
    for (const [html, code] of cases) {
      const error = thrown(html);
      expect(error).toBeInstanceOf(GlobalPassSanitizerError);
      expect(error).toMatchObject({ name: "GlobalPassSanitizerError", code, message: code });
      expect(sanitizerCode(error)).toBe(code as (typeof GLOBALPASS_SANITIZER_CODES)[number]);
    }
    expect(cases.map(([, code]) => code)).toEqual([...GLOBALPASS_SANITIZER_CODES]);
    expect(sanitizerCode(new Error("globalpass_html_contract_invalid"))).toBeUndefined();
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
      expect(() =>
        sanitizeGlobalPassActivityHtml(valid.replace("</body>", `${injected}</body>`)),
      ).toThrow("globalpass_html_contract_invalid");
    }
    expect(() =>
      sanitizeGlobalPassActivityHtml(valid.replace('name="cc"', 'id="one" id="two" name="cc"')),
    ).toThrow("globalpass_html_contract_invalid");
  });
});

describe("GLOBAL PASS sanitizer refusals name the failed expectation", () => {
  const append = (markup: string) => fixture("a").replace("</body>", `${markup}</body>`);
  // [expectation, page, code, element, attribute]
  const cases: Array<[string, () => string, string, string?, string?]> = [
    ["utf8_invalid", () => fixture("a") + "\ud800", "globalpass_html_utf8_invalid"],
    [
      "doctype_missing",
      () => fixture("a").replace("<!DOCTYPE html>", ""),
      "globalpass_html_contract_invalid",
    ],
    [
      "activity_heading_missing",
      () => fixture("a").replace("ご利用明細", "Account"),
      "globalpass_html_contract_invalid",
    ],
    ["forbidden_token", () => append("<p>csrf</p>"), "globalpass_html_contract_invalid"],
    [
      "sentinel_present",
      () => append(`<p>${NABLARCH_HIDDEN_SENTINEL}</p>`),
      "globalpass_html_contract_invalid",
    ],
    [
      "size_out_of_range",
      () => append(`<p>${"x".repeat(2 * 1024 * 1024)}</p>`),
      "globalpass_html_contract_invalid",
    ],
    [
      "css_url",
      () => append('<div style="background:url(x)"></div>'),
      "globalpass_html_contract_invalid",
    ],
    [
      "blocked_element",
      () => append("<iframe></iframe>"),
      "globalpass_html_contract_invalid",
      "iframe",
    ],
    [
      "duplicate_attribute",
      () => append('<a href="#one" href="#two">x</a>'),
      "globalpass_html_contract_invalid",
      "a",
      "href",
    ],
    [
      "http_equiv_unallowed",
      () => append('<meta http-equiv="refresh" content="0">'),
      "globalpass_html_contract_invalid",
      "meta",
      "http_equiv",
    ],
    [
      "url_attribute",
      () => append('<img src="/en/01006/img/logo.jpg" srcset="x 1x">'),
      "globalpass_html_contract_invalid",
      "img",
      "url_attribute",
    ],
    [
      "action_unallowed",
      () => append('<form action="https://example.invalid/write"></form>'),
      "globalpass_html_contract_invalid",
      "form",
      "action",
    ],
    [
      "href_unallowed",
      () => append('<a href="https://example.invalid/">x</a>'),
      "globalpass_html_contract_invalid",
      "a",
      "href",
    ],
    [
      "src_unallowed",
      () => append('<script src="/js/other.js"></script>'),
      "globalpass_html_contract_invalid",
      "script",
      "src",
    ],
    [
      "event_handler_unallowed",
      () => append('<a href="#" onclick="fetch()">x</a>'),
      "globalpass_html_contract_invalid",
      "a",
      "event_handler",
    ],
    [
      "credential_field",
      () => append('<input type="password" id="password">'),
      "globalpass_html_contract_invalid",
      "input",
    ],
    [
      "hidden_name_unallowed",
      () => fixture("a").replace('name="cc"', 'name="unknown_state"'),
      "globalpass_html_contract_invalid",
      "input",
      "name",
    ],
    [
      "hidden_value_missing",
      () => append('<input type="hidden" name="nablarch_hidden">'),
      "globalpass_html_contract_invalid",
      "input",
      "value",
    ],
    [
      "variant_unmatched",
      () => fixture("a").replace('<input type="hidden" name="nablarch_submit" value="1">', ""),
      "globalpass_html_shape_unreviewed",
    ],
    [
      "redaction_count_mismatch",
      () => append('<input name="nablarch_hidden" value="opaque-x">'),
      "globalpass_html_redaction_failed",
    ],
  ];
  // Checks of the redacted output that no input can reach while the
  // redaction and canonicalisation are correct; they stay as fail-closed guards.
  const defensive = ["redacted_value_unexpected", "variant_changed"];

  for (const [expectation, page, code, element, attribute] of cases) {
    test(expectation, () => {
      let error: unknown;
      try {
        sanitizeGlobalPassActivityHtml(page());
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GlobalPassSanitizerError);
      expect(sanitizerCode(error)).toBe(code as (typeof GLOBALPASS_SANITIZER_CODES)[number]);
      expect(sanitizerExpectation(error)).toBe(
        expectation as (typeof GLOBALPASS_SANITIZER_EXPECTATIONS)[number],
      );
      const detail = (error as GlobalPassSanitizerError).detail;
      expect(detail.element).toBe(element as never);
      expect(detail.attribute).toBe(attribute as never);
      const shape = globalPassRefusalShape(page(), error);
      // The redaction count is checked after redaction, on the output.
      const phase = expectation === "redaction_count_mismatch" ? "output" : "input";
      expect(shape).toMatchObject({ expectation, phase, summarized: true });
      // The shape survives the diagnostics allowlist unchanged: every value in
      // it is closed or a count.
      expect(safeShape(shape)).toEqual(JSON.parse(JSON.stringify(shape)));
    });
  }

  test("the cases cover every expectation except the output-only guards", () => {
    expect([...cases.map(([expectation]) => expectation), ...defensive].sort()).toEqual(
      [...GLOBALPASS_SANITIZER_EXPECTATIONS].sort(),
    );
  });

  test("counts the page's markup and landmarks, not its text", () => {
    const page = fixture("a")
      .replace("<head>", "<head><title>ご利用明細</title>")
      .replace(
        "</body>",
        "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>" +
          '<input type="text" id="usrId"><iframe></iframe></body>',
      );
    const shape = globalPassRefusalShape(
      page,
      new GlobalPassSanitizerError("globalpass_html_contract_invalid", {
        expectation: "blocked_element",
        phase: "input",
        element: "iframe",
      }),
    );
    expect(shape).toEqual({
      expectation: "blocked_element",
      phase: "input",
      element: "iframe",
      summarized: true,
      byteMagnitude: String(new TextEncoder().encode(page).byteLength).length,
      textMagnitude: 2,
      elements: {
        table: 1,
        tr: 2,
        th: 2,
        td: 2,
        form: 6,
        input: 17,
        select: 1,
        button: 0,
        script: 1,
        style: 0,
        a: 1,
        link: 1,
        img: 0,
        meta: 0,
        title: 1,
        blocked: 1,
      },
      contract: {
        forms: 6,
        staticActionForms: 1,
        hiddenInputs: 16,
        hiddenUnlisted: 0,
        cc: 1,
        engUseFlg: 1,
        nablarchHidden: 6,
        nablarchHiddenNonempty: 4,
        nablarchNeedsHiddenEncryption: 1,
        nablarchSubmit: 6,
        referenceDate: 1,
      },
      landmarks: {
        doctype: true,
        activityHeading: true,
        title: true,
        activityHeadingInTitle: true,
        loginForm: true,
        passwordField: false,
        monthSelect: true,
        sentinel: false,
      },
      forbiddenTokens: {
        jsessionid: 0,
        token: 0,
        csrf: 0,
        turnstile: 0,
        session: 0,
        localStorage: 0,
      },
    });
  });

  test("an error that is not a sanitizer refusal gives an unknown expectation", () => {
    expect(globalPassRefusalShape(fixture("a"), new Error("private-text"))).toMatchObject({
      expectation: "unknown",
      phase: "unknown",
      summarized: true,
    });
    expect(sanitizerExpectation(new Error("globalpass_html_contract_invalid"))).toBeUndefined();
  });

  test("every closed code the shape can carry passes the diagnostics allowlist", () => {
    for (const value of [
      ...GLOBALPASS_SANITIZER_EXPECTATIONS,
      ...GLOBALPASS_SANITIZER_ELEMENTS,
      ...GLOBALPASS_SANITIZER_ATTRIBUTES,
      "input",
      "output",
      "unknown",
    ]) {
      expect(safeShape({ expectation: value })).toEqual({ expectation: value });
    }
  });

  test("an adversarial page gives a bounded shape of closed codes and counts", () => {
    // Synthetic: text placed in tag names, attribute names, attribute values,
    // a class list of 1000 entries, a title and the visible text.
    const marker = "SYNTHETICMARKER";
    const classes = Array.from({ length: 1000 }, (_, i) => `c${i}${marker}`).join(" ");
    const pages = [
      `<!doctype html><html><head><title>${marker} ご利用明細</title></head><body>` +
        `<div ${marker}="1" data-${marker}=x class="${classes}"><${marker}x a=${marker}></${marker}x>` +
        `<iframe ${marker}></iframe><input type="hidden" name="${marker}" value="${marker}">` +
        `<p>${marker} 12,345 2099-01-01</p></div></body></html>`,
      `<!doctype html><${marker} on${marker}="${marker}">ご利用明細`,
      `<!doctype html><body>ご利用明細<a href="https://${marker}.example.invalid/">x</a></body>`,
    ];
    for (const page of pages) {
      let error: unknown;
      try {
        sanitizeGlobalPassActivityHtml(page);
      } catch (caught) {
        error = caught;
      }
      const shape = globalPassRefusalShape(page, error);
      const logged = JSON.stringify(safeShape(shape));
      expect(logged).toBe(JSON.stringify(shape));
      expect(logged).not.toContain(marker);
      expect(logged).not.toContain("12,345");
      expect(logged).not.toContain("2099");
      expect(logged.length).toBeLessThan(1024);
    }
  });
});

function captured(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
