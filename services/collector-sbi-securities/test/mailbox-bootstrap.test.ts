import { expect, test } from "bun:test";
import { mailboxBootstrap } from "../src/mailbox-bootstrap";

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
    script.replace("window.location.href", "location.href"),
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
