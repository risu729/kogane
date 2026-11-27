import { expect, test } from "bun:test";
import { BootstrapRefusal, mailboxBootstrap } from "../src/mailbox-bootstrap";

const keys = [
  "dp-csrf",
  "dp-riyoCd",
  "dp-dId",
  "dp-userName",
  "dp-lastLoginTime",
  "dp-sentakukino",
  "dp-hyoujiseigyo",
  "dp-sfn",
];
const script = `window.onload = function() {
${keys.map((key) => `sessionStorage.setItem(${JSON.stringify(key)}, "synthetic-${key}");`).join("\n")}
autoRedirect();
};
function autoRedirect() {
window.location.href = "https://plus.e-shishobako.ne.jp" + "/dp_apl/usr/";
}`;
const html = (source = script) =>
  `<!doctype html><html><head></head><body><script>${source}</script></body></html>`;

test("extracts only the two required opaque literals from the complete witnessed grammar", () => {
  expect(mailboxBootstrap(html())).toEqual({
    csrf: "synthetic-dp-csrf",
    riyoCd: "synthetic-dp-riyoCd",
  });
  expect(mailboxBootstrap(html(script.replaceAll('"', "'")))).toEqual(mailboxBootstrap(html()));
  const fallback = '<a href="#" onclick="autoRedirect()">こちら</a>';
  expect(mailboxBootstrap(html().replace("</body>", `${fallback}</body>`))).toEqual(
    mailboxBootstrap(html()),
  );
  expect(() =>
    mailboxBootstrap(html().replace("</body>", `${fallback}${fallback}</body>`)),
  ).toThrow("sbi_mailbox_bootstrap_unobserved");
  expect(() =>
    mailboxBootstrap(
      html().replace(
        "</body>",
        fallback.replace('href="#"', 'href="https://evil.invalid/"') + "</body>",
      ),
    ),
  ).toThrow("sbi_mailbox_bootstrap_unobserved");
  for (const changed of [
    fallback.replace('href="#"', 'href="javascript:autoRedirect()"'),
    fallback.replace('onclick="autoRedirect()"', 'onclick="autoRedirect(); other()"'),
    fallback.replace(
      'onclick="autoRedirect()"',
      'onclick="autoRedirect()" onmouseover="autoRedirect()"',
    ),
  ])
    expect(() => mailboxBootstrap(html().replace("</body>", `${changed}</body>`))).toThrow(
      "sbi_mailbox_bootstrap_unobserved",
    );
  expect(() =>
    mailboxBootstrap(html().replace("<body>", '<body onclick="autoRedirect()">')),
  ).toThrow("sbi_mailbox_bootstrap_unobserved");
});

test("rejects executable variations and incomplete or ambiguous storage material without executing them", () => {
  const variants = [
    script + "\nglobalThis.mailboxExecuted = true;",
    script.replace('"synthetic-dp-csrf"', "(globalThis.mailboxExecuted = true)"),
    script.replace('"synthetic-dp-csrf"', "`synthetic-${globalThis.mailboxExecuted = true}`"),
    script.replace('"dp-riyoCd"', '"dp-csrf"'),
    script.replace('"dp-sfn"', '"dp-unknown"'),
    script.replace('"synthetic-dp-csrf"', '""'),
    script.replace('"synthetic-dp-csrf"', '"synthetic\\r\\nheader"'),
    script.replace('sessionStorage.setItem("dp-sfn", "synthetic-dp-sfn");', ""),
    script.replace("window.onload", 'window["onload"]'),
    script.replace("sessionStorage.setItem", 'sessionStorage["setItem"]'),
    script.replace("function()", "async function()"),
    script.replace("function()", "function(parameter)"),
    script.replace("autoRedirect();", "autoRedirect(1);"),
    script.replace("autoRedirect();", "autoRedirect?.();"),
    script.replace('plus.e-shishobako.ne.jp" +', 'plus.e-shishobako.ne.jp.evil.invalid" +'),
    script.replace('"/dp_apl/usr/"', '"/dp_apl/usr/?unexpected=1"'),
    script.replace('"/dp_apl/usr/"', '"/dp_apl/usr/#fragment"'),
    script.replace("function autoRedirect()", "function autoRedirect(argument)"),
    script.replace(
      "window.location.href =",
      "globalThis.mailboxExecuted = true; window.location.href =",
    ),
    "/* synthetic private sentinel */ broken JavaScript <<",
  ];
  for (const source of variants)
    expect(() => mailboxBootstrap(html(source))).toThrow("sbi_mailbox_bootstrap_unobserved");
  expect("mailboxExecuted" in globalThis).toBe(false);
});

test("refuses additional scripts, forms, event handlers, redirects and ambiguous HTML", () => {
  for (const page of [
    html().replace("</body>", "<script>void 0;</script></body>"),
    html().replace("<script>", '<script src="https://example.invalid/unknown.js">'),
    html().replace("<script>", '<script type="module">'),
    html().replace("<script>", '<script type="text/javascript" type="module">'),
    html().replace("<body>", '<body onload="autoRedirect()">'),
    html().replace("<body>", '<body><form action="/unexpected"></form>'),
    html().replace("<head>", '<head><base href="https://example.invalid/">'),
    html().replace("<head>", '<head><meta http-equiv="refresh" content="0;url=/unexpected">'),
    html().replace("<body>", "<body><template><script>void 0;</script></template>"),
    html().replace("<body>", "<body>" + "<div>".repeat(65)),
    html(" ".repeat(32 * 1024 + 1)),
    " ".repeat(256 * 1024 + 1),
  ])
    expect(() => mailboxBootstrap(page)).toThrow("sbi_mailbox_bootstrap_unobserved");
});

test("parser failures expose only a closed code and no source or opaque value", () => {
  try {
    mailboxBootstrap(html('sessionStorage.setItem("dp-csrf", "SYNTHETIC_PRIVATE_SENTINEL"'));
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("sbi_mailbox_bootstrap_unobserved");
    expect(JSON.stringify(error)).not.toContain("SYNTHETIC_PRIVATE_SENTINEL");
    expect((error as Error).cause).toBeUndefined();
  }
});

test("a refused bootstrap names the grammar part it departed from, never the page text", () => {
  const rule = (page: string) => {
    try {
      mailboxBootstrap(page);
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapRefusal);
      expect((error as Error).message).toBe("sbi_mailbox_bootstrap_unobserved");
      const { rule, count } = error as BootstrapRefusal;
      return count === undefined ? { rule } : { rule, count };
    }
    throw new Error("accepted");
  };
  const extra = 'sessionStorage.setItem("dp-synthetic-secret", "synthetic-secret");';
  for (const [page, expected] of [
    ["x".repeat(300 * 1024), { rule: "html" }],
    [html().replace("<body>", "<body><template>synthetic</template>"), { rule: "html" }],
    [
      html().replace("</body>", '<form action="/synthetic-secret"></form></body>'),
      { rule: "elements" },
    ],
    [
      html().replace("</body>", "<script>var synthetic = 1;</script></body>"),
      { rule: "script-element", count: 2 },
    ],
    [html().replace("<script>", '<script src="/synthetic-secret.js">'), { rule: "script-element" }],
    [html("window.onload = function( {"), { rule: "script-parse" }],
    [html(`${script}\nvar synthetic = 1;`), { rule: "statements", count: 3 }],
    [html(script.replace("window.onload", "document.onload")), { rule: "onload" }],
    [
      html(script.replace("autoRedirect();\n}", `${extra}\nautoRedirect();\n}`)),
      { rule: "onload", count: 10 },
    ],
    [html(script.replace('"dp-sfn"', '"dp-synthetic-secret"')), { rule: "storage" }],
    [html(script.replace("autoRedirect();\n}", "synthetic();\n}")), { rule: "redirect-call" }],
    [html(script.replace('"/dp_apl/usr/"', '"/synthetic-secret/"')), { rule: "redirect-path" }],
    [
      html(
        script.replace('"https://plus.e-shishobako.ne.jp"', '"https://synthetic-secret.invalid"'),
      ),
      { rule: "redirect-origin" },
    ],
    [html(script.replace('"/dp_apl/usr/"', "secret")), { rule: "redirect-dynamic" }],
    [
      html(
        script
          .replace("window.location.href =", "fetch(")
          .replace('"/dp_apl/usr/";', '"/dp_apl/usr/");'),
      ),
      { rule: "redirect-navigation" },
    ],
    [
      html(script.replace("window.location.href =", "document.location.href =")),
      { rule: "redirect-navigation" },
    ],
    [
      html(
        script.replace(
          "function autoRedirect() {\n",
          "function autoRedirect() {\nvar synthetic = 1;\n",
        ),
      ),
      { rule: "redirect-function", count: 2 },
    ],
  ] as const)
    expect(rule(page)).toEqual(expected);
});

test("any spelling of the redirect is accepted only when it names the application", () => {
  const witnessed = mailboxBootstrap(html());
  const navigation = 'window.location.href = "https://plus.e-shishobako.ne.jp" + "/dp_apl/usr/";';
  expect(script).toContain(navigation);
  for (const spelling of [
    'window.location.href = "https://plus.e-shishobako.ne.jp/dp_apl/usr/";',
    'location.href = "https://plus.e-shishobako.ne.jp/dp_apl/usr/";',
    'window.location = "https://plus.e-shishobako.ne.jp" + "/dp_apl/" + "usr/";',
    'location.replace("https://plus.e-shishobako.ne.jp" + "/dp_apl/usr/");',
    "window.location.assign(`https://plus.e-shishobako.ne.jp/dp_apl/usr/`);",
  ])
    expect(mailboxBootstrap(html(script.replace(navigation, spelling)))).toEqual(witnessed);
  for (const spelling of [
    'window.location.href += "https://plus.e-shishobako.ne.jp/dp_apl/usr/";',
    'location.reload("https://plus.e-shishobako.ne.jp/dp_apl/usr/");',
    "location.href = `https://plus.e-shishobako.ne.jp/${secret}`;",
    'window["location"].href = "https://plus.e-shishobako.ne.jp/dp_apl/usr/";',
    'location?.replace("https://plus.e-shishobako.ne.jp/dp_apl/usr/");',
    'location.replace("https://plus.e-shishobako.ne.jp/dp_apl/usr/", 1);',
  ])
    expect(() => mailboxBootstrap(html(script.replace(navigation, spelling)))).toThrow(
      "sbi_mailbox_bootstrap_unobserved",
    );
});
