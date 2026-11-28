import { expect, test } from "bun:test";
import {
  MailboxHttp,
  MAILBOX_MAIN_LINK,
  mailboxMainLink,
  readMailboxResponse,
  updateMailboxCookies,
  type MailboxCookie,
} from "../src/mailbox-http";
import {
  mailboxForm,
  MAILBOX_ENTRY,
  MAILBOX_CONNECT,
  MAILBOX_SSO,
  MAILBOX_BOOTSTRAP,
} from "../src/mailbox-form";
import { MAILBOX_APPLICATION } from "../src/mailbox-bootstrap";
import { mailboxBootstrapHtml, mailboxFormHtml } from "./mailbox-fixture";

const html = (
  body = "<!doctype html><title>synthetic</title>",
  headers: Record<string, string> = {},
) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const cookie = (): MailboxCookie => ({
  name: "sbi",
  value: "synthetic-sbi",
  domain: "sbisec.co.jp",
  path: "/",
  secure: true,
  hostOnly: false,
});
const fields = ["sfn", "ric", "ked", "epr", "itv", "hav", "spm"];
const HANDOFF =
  "https://m.sbisec.co.jp/switchnavi?page=Edeliv&parm=synthetic%2509parm&SwitchFromSite=site4.sbisec.co.jp&admin_flg=+";
function sequence(
  extra: (url: URL, init: RequestInit) => Promise<Response> = async () =>
    new Response("{}", { headers: { "content-type": "application/json" } }),
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url: url.href, init });
    if (url.href === MAILBOX_MAIN_LINK)
      return new Response(null, { status: 302, headers: { location: HANDOFF } });
    if (url.href === HANDOFF)
      return new Response(null, {
        status: 302,
        headers: { location: "/switchnaviMain", "set-cookie": "nav=synthetic-nav; Path=/" },
      });
    if (url.href === "https://m.sbisec.co.jp/switchnaviMain") return html();
    if (url.href === MAILBOX_ENTRY) return html(mailboxFormHtml(MAILBOX_CONNECT, ["ePoboxFlag"]));
    if (url.href === MAILBOX_CONNECT) return html(mailboxFormHtml(MAILBOX_SSO, fields));
    if (url.href === MAILBOX_SSO)
      return new Response(null, {
        status: 303,
        headers: {
          location: MAILBOX_BOOTSTRAP,
          "set-cookie": "mail=synthetic-mail; Path=/; Secure; HttpOnly",
        },
      });
    if (url.href === MAILBOX_BOOTSTRAP) return html(mailboxBootstrapHtml());
    if (url.href === MAILBOX_APPLICATION) return html();
    return extra(url, init);
  };
  return { fetcher, calls };
}

test("uses exact staged forms and scopes SBI and mailbox cookies to their own origins", async () => {
  const { fetcher, calls } = sequence();
  const client = new MailboxHttp([cookie()], fetcher);
  await client.open();
  await client.api("summary");
  expect(calls.map((call) => call.url)).toEqual([
    MAILBOX_MAIN_LINK,
    HANDOFF,
    "https://m.sbisec.co.jp/switchnaviMain",
    MAILBOX_ENTRY,
    MAILBOX_CONNECT,
    MAILBOX_SSO,
    MAILBOX_BOOTSTRAP,
    MAILBOX_APPLICATION,
    "https://plus.e-shishobako.ne.jp/dp-uw/v1/DPAW010501030",
  ]);
  expect(new URLSearchParams(calls[4]!.init.body as URLSearchParams).get("ePoboxFlag")).toBe(
    "synthetic-ePoboxFlag",
  );
  expect([...new URLSearchParams(calls[5]!.init.body as URLSearchParams).keys()]).toEqual(fields);
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    expect(call.init.redirect).toBe("manual");
    expect(headers.has("authorization")).toBe(false);
    if (new URL(call.url).hostname.endsWith("sbisec.co.jp"))
      expect(headers.get("cookie")).toBe(
        calls.indexOf(call) <= 1 ? "sbi=synthetic-sbi" : "sbi=synthetic-sbi; nav=synthetic-nav",
      );
    else expect(headers.get("cookie") ?? "").not.toContain("synthetic-sbi");
  }
  expect(new Headers(calls.at(-1)!.init.headers).get("cookie")).toBe("mail=synthetic-mail");
  expect(new URLSearchParams(calls.at(-1)!.init.body as URLSearchParams).get("_csrf")).toBe(
    "synthetic-dp-csrf",
  );
});

test("rotates CSRF before a refused response so the next independent document can proceed", async () => {
  let apiCalls = 0;
  let cancelled = false;
  const { fetcher, calls } = sequence(async () => {
    if (++apiCalls === 1)
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 403, headers: { "x-csrf-token": "synthetic-rotated" } },
      );
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  const client = new MailboxHttp([], fetcher);
  await client.open();
  await expect(client.api("list")).rejects.toThrow("sbi_mailbox_transport_failed");
  expect(cancelled).toBe(true);
  await client.api("list");
  expect(new URLSearchParams(calls.at(-1)!.init.body as URLSearchParams).get("_csrf")).toBe(
    "synthetic-rotated",
  );
});

test("admits only the exact Edeliv hand-off as an intermediate hop, never as a landing", async () => {
  for (const location of [
    "https://m.sbisec.co.jp/switchnavi?page=Other&parm=synthetic",
    "https://m.sbisec.co.jp/switchnavi?page=Edeliv&page=Edeliv",
    "https://m.sbisec.co.jp/switchnavi?parm=synthetic",
    "https://m.sbisec.co.jp/switchnavi/extra?page=Edeliv",
    "https://m.sbisec.co.jp/switchnavi?page=Edeliv#fragment",
    "http://m.sbisec.co.jp/switchnavi?page=Edeliv",
    "https://m.sbisec.co.jp:444/switchnavi?page=Edeliv",
    "https://s.sbisec.co.jp/switchnavi?page=Edeliv",
  ]) {
    let count = 0;
    const client = new MailboxHttp([], async () => {
      count++;
      return new Response(null, { status: 302, headers: { location } });
    });
    await expect(client.open()).rejects.toThrow("sbi_mailbox_transport_failed");
    expect(count).toBe(1);
  }
  let cancelled = false;
  const urls: string[] = [];
  const client = new MailboxHttp([], async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString()).href;
    urls.push(url);
    if (url === MAILBOX_MAIN_LINK)
      return new Response(null, { status: 302, headers: { location: HANDOFF } });
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/html" } },
    );
  });
  await expect(client.open()).rejects.toThrow("sbi_mailbox_transport_failed");
  expect(urls).toEqual([MAILBOX_MAIN_LINK, HANDOFF]);
  expect(cancelled).toBe(true);
});

test("the hand-off's own redirect is still checked, loops are refused and its URL is never a referer", async () => {
  for (const [onward, requests] of [
    ["https://evil.invalid/", 2],
    ["https://m.sbisec.co.jp/switchnaviMain?x=1", 2],
    [HANDOFF, 2],
  ] as const) {
    const urls: string[] = [];
    const client = new MailboxHttp([], async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()).href;
      urls.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: url === MAILBOX_MAIN_LINK ? HANDOFF : onward },
      });
    });
    await expect(client.open()).rejects.toThrow("sbi_mailbox_transport_failed");
    expect(urls).toHaveLength(requests);
  }
  let hops = 0;
  const chained = new MailboxHttp([], async () => {
    hops++;
    return new Response(null, {
      status: 302,
      headers: { location: `https://m.sbisec.co.jp/switchnavi?page=Edeliv&parm=${hops}` },
    });
  });
  await expect(chained.open()).rejects.toThrow("sbi_mailbox_transport_failed");
  expect(hops).toBe(5);
  const { fetcher, calls } = sequence();
  await new MailboxHttp([], fetcher).open();
  expect(new Headers(calls[2]!.init.headers).get("referer")).toBe(MAILBOX_MAIN_LINK);
  const direct = sequence(async () => html());
  const directFetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === MAILBOX_MAIN_LINK) {
      direct.calls.push({ url: url.href, init });
      return new Response(null, {
        status: 302,
        headers: { location: "https://m.sbisec.co.jp/switchnaviMain" },
      });
    }
    return direct.fetcher(input, init);
  };
  await new MailboxHttp([], directFetcher).open();
  expect(direct.calls.map((call) => call.url).slice(0, 2)).toEqual([
    MAILBOX_MAIN_LINK,
    "https://m.sbisec.co.jp/switchnaviMain",
  ]);
});

test("refuses unobserved redirects before sending a request or secret to the target and cancels response bodies", async () => {
  for (const location of [
    "https://evil.invalid/",
    "https://m.sbisec.co.jp/switchnaviMain?extra=1",
    "https://user@ m.sbisec.co.jp/",
    "http://m.sbisec.co.jp/switchnaviMain",
    "https://m.sbisec.co.jp:444/switchnaviMain",
    "https://m.sbisec.co.jp/switchnaviMain#fragment",
  ]) {
    let count = 0;
    let cancelled = false;
    const client = new MailboxHttp([], async () => {
      count++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 302, headers: { location } },
      );
    });
    await expect(client.open()).rejects.toThrow();
    expect(count).toBe(1);
    expect(cancelled).toBe(true);
  }
});

test("rejects invalid cookie domains, public suffixes and duplicate attributes", () => {
  for (const domain of ["evil.invalid", "ne.jp", "sbisec.co.jp", "m.sbisec.co.jp"])
    expect(() =>
      updateMailboxCookies(
        [],
        new Headers({ "set-cookie": `test=synthetic; Domain=${domain}; Path=/` }),
        new URL(MAILBOX_SSO),
      ),
    ).toThrow("sbi_mailbox_transport_failed");
  expect(() =>
    updateMailboxCookies(
      [],
      new Headers({
        "set-cookie": "test=synthetic; Domain=plus.e-shishobako.ne.jp; Domain=evil.invalid",
      }),
      new URL(MAILBOX_SSO),
    ),
  ).toThrow();
  const jar: MailboxCookie[] = [];
  updateMailboxCookies(
    jar,
    new Headers({ "set-cookie": "test=synthetic; Domain=e-shishobako.ne.jp; Path=/dp-uw; Secure" }),
    new URL(MAILBOX_SSO),
  );
  expect(jar).toHaveLength(1);
  updateMailboxCookies(
    jar,
    new Headers({ "set-cookie": "test=gone; Domain=e-shishobako.ne.jp; Path=/dp-uw; Max-Age=0" }),
    new URL(MAILBOX_SSO),
  );
  expect(jar).toHaveLength(0);
});

test("rejects extra or ambiguous form controls and action changes without exposing opaque values", () => {
  const valid = mailboxFormHtml(MAILBOX_CONNECT, ["ePoboxFlag"]);
  expect(mailboxForm(valid, MAILBOX_ENTRY).get("ePoboxFlag")).toBe("synthetic-ePoboxFlag");
  for (const body of [
    valid.replace(MAILBOX_CONNECT, "https://evil.invalid/"),
    valid.replace('method="POST"', 'method="GET"'),
    valid.replace('name="ePoboxFlag"', 'name="ePoboxFlag" name="other"'),
    valid.replace('type="hidden"', 'type="text"'),
    valid.replace('type="hidden"', 'type="hidden" disabled'),
    valid.replace('type="hidden"', 'type="hidden" form="other"'),
    valid.replace("</form>", '<input type="hidden" name="ePoboxFlag" value="duplicate"></form>'),
    valid.replace("</body>", '<form action="/other"></form></body>'),
  ])
    expect(() => mailboxForm(body, MAILBOX_ENTRY)).toThrow("sbi_mailbox_handoff_unobserved");
});

test("bounds actual streams without trusting content length and closes early-refused streams", async () => {
  for (const header of [undefined, "1", "999"]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: header === undefined ? {} : { "content-length": header } },
    );
    await expect(readMailboxResponse(response, 4)).rejects.toThrow("sbi_mailbox_response_bound");
    expect(cancelled).toBe(true);
  }
});

test("every navigation hop checks the same absolute deadline before another request", async () => {
  const original = Date.now;
  let now = 1000;
  let calls = 0;
  Date.now = () => now;
  try {
    const client = new MailboxHttp(
      [],
      async (_url, init) => {
        calls++;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        now = 2001;
        return new Response(null, {
          status: 302,
          headers: { location: "https://m.sbisec.co.jp/switchnaviMain" },
        });
      },
      2000,
    );
    await expect(client.open()).rejects.toThrow("sbi_mailbox_response_bound");
    expect(calls).toBe(1);
  } finally {
    Date.now = original;
  }
});

test("a repeated attribute that says the same thing is kept once; a conflicting one is refused", () => {
  const jar: MailboxCookie[] = [];
  updateMailboxCookies(
    jar,
    new Headers({ "set-cookie": "nav=synthetic; Path=/; HttpOnly; Secure; HttpOnly; path=/" }),
    new URL(HANDOFF),
  );
  expect(jar).toEqual([
    {
      name: "nav",
      value: "synthetic",
      domain: "m.sbisec.co.jp",
      path: "/",
      hostOnly: true,
      secure: true,
    },
  ]);
  for (const header of [
    "nav=synthetic; Path=/; Path=/other",
    "nav=synthetic; Domain=m.sbisec.co.jp; Domain=sbisec.co.jp",
    "nav=synthetic; Max-Age=60; Max-Age=0",
  ])
    expect(() =>
      updateMailboxCookies([], new Headers({ "set-cookie": header }), new URL(HANDOFF)),
    ).toThrow("sbi_mailbox_transport_failed");
});

test("the hand-off's repeated HttpOnly no longer stops the mailbox", async () => {
  const { fetcher, calls } = sequence();
  const repeated = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString()).href;
    if (url === HANDOFF)
      return new Response(null, {
        status: 302,
        headers: {
          location: "/switchnaviMain",
          "set-cookie": "nav=synthetic-nav; Path=/; HttpOnly; HttpOnly",
        },
      });
    return fetcher(input, init);
  };
  await new MailboxHttp([], repeated).open();
  expect(calls.map((call) => call.url)).toContain(MAILBOX_APPLICATION);
  expect(new Headers(calls[1]!.init.headers).get("cookie")).toBe("nav=synthetic-nav");
});

test("default cookie paths use the parent path and unrelated embeds do not alter a form carrier", () => {
  const jar: MailboxCookie[] = [];
  updateMailboxCookies(
    jar,
    new Headers({ "set-cookie": "test=synthetic; Secure" }),
    new URL("https://plus.e-shishobako.ne.jp/a/b"),
  );
  expect(jar[0]!.path).toBe("/a");
  const page = mailboxFormHtml(MAILBOX_CONNECT, ["ePoboxFlag"]).replace(
    "</body>",
    '<iframe src="https://example.invalid/inert"></iframe></body>',
  );
  expect(mailboxForm(page, MAILBOX_ENTRY).get("ePoboxFlag")).toBe("synthetic-ePoboxFlag");
});

test("admits the exact observed connecting-page HTML4 doctype without accepting other parse ambiguities", () => {
  const doctype =
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">';
  const actual = mailboxFormHtml(MAILBOX_SSO, fields).replace("<!doctype html>", doctype);
  expect([...mailboxForm(actual, MAILBOX_CONNECT).keys()]).toEqual(fields);
  expect([
    ...mailboxForm(
      mailboxFormHtml(MAILBOX_CONNECT, ["ePoboxFlag"]).replace("<!doctype html>", doctype),
      MAILBOX_ENTRY,
    ).keys(),
  ]).toEqual(["ePoboxFlag"]);
  for (const changed of [
    actual.replace("Transitional", "Frameset"),
    actual.replace("http://www.w3.org/TR/html4/loose.dtd", "https://example.invalid/other.dtd"),
    actual.replace('name="sfn"', 'name="sfn" name="ric"'),
  ])
    expect(() => mailboxForm(changed, MAILBOX_CONNECT)).toThrow("sbi_mailbox_handoff_unobserved");
});

test("lease abort cancels a PDF response and forbids subsequent requests", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let requestSignal: AbortSignal | null | undefined;
  let pdfCalls = 0;
  const { fetcher } = sequence(async (_url, init) => {
    pdfCalls++;
    requestSignal = init.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          controller.abort();
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/pdf" } },
    );
  });
  const client = new MailboxHttp([], fetcher, Date.now() + 100000, controller.signal);
  await client.open();
  const fields = {
    userTokuteiId: "synthetic-user",
    sCd: "FR81011D02",
    sBaseDate: "20990101",
    sCdSeq: "synthetic-sequence",
    sTypeCd: " ",
    sIntFileIds: "synthetic-file",
    xmlPreviewFlg: "0",
  };
  await expect(client.api("pdf", fields)).rejects.toThrow("sbi_mailbox_lease_lost");
  expect(requestSignal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
  await expect(client.api("pdf", fields)).rejects.toThrow("sbi_mailbox_lease_lost");
  expect(pdfCalls).toBe(1);
});

test("a refusal logs its step, hop, status and refused redirect target in closed values only", async () => {
  const logged: string[] = [];
  const original = console.log;
  console.log = (line: string) => logged.push(line);
  const redirecting = (onward: string) =>
    new MailboxHttp([], async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()).href;
      return new Response(null, {
        status: 302,
        headers: { location: url === MAILBOX_MAIN_LINK ? HANDOFF : onward },
      });
    });
  try {
    for (const [onward, host, route] of [
      [
        "https://www.sbisec.co.jp/ETGate/;jsessionid=synthetic?secret=1",
        "www.sbisec.co.jp",
        "other",
      ],
      ["https://m.sbisec.co.jp/s/Synthetic0Token1Synthetic2Token3", "m.sbisec.co.jp", "other"],
      ["https://synthetic-host.invalid/secret/path", "other", "other"],
      ["https://evil-e-shishobako.ne.jp/", "other", "other"],
      [`${MAILBOX_SSO}?secret=1`, "plus.e-shishobako.ne.jp", "sso"],
    ] as const) {
      const client = redirecting(onward);
      await expect(client.open()).rejects.toThrow("sbi_mailbox_transport_failed");
      expect(client.lastDiagnosis).toEqual({
        step: "landing",
        hop: 1,
        status: 302,
        refusedHost: host,
        refusedRoute: route,
        reason: "redirect-target",
      });
    }
    const { fetcher } = sequence();
    const badEntry = new MailboxHttp([], async (input, init) =>
      new URL(input instanceof Request ? input.url : input.toString()).href === MAILBOX_ENTRY
        ? new Response("{}", {
            status: 403,
            headers: { "content-type": "application/x-synthetic-secret" },
          })
        : fetcher(input, init),
    );
    await expect(badEntry.open()).rejects.toThrow("sbi_mailbox_transport_failed");
    expect(badEntry.lastDiagnosis).toEqual({
      step: "entry",
      hop: 0,
      status: 403,
      contentType: "other",
    });
    const api = new MailboxHttp(
      [],
      sequence(async () => new Response("{}", { status: 500 })).fetcher,
    );
    await api.open();
    await expect(api.api("summary")).rejects.toThrow("sbi_mailbox_transport_failed");
    // A new step starts from a fresh diagnosis on the same client.
    expect(api.lastDiagnosis).toEqual({
      step: "api",
      api: "summary",
      hop: 0,
      status: 500,
    });
  } finally {
    console.log = original;
  }
  const records = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => [record.event, record.code, record.step])).toEqual([
    ...Array.from({ length: 5 }, () => [
      "sbi-mailbox-refused",
      "sbi_mailbox_transport_failed",
      "landing",
    ]),
    ["sbi-mailbox-refused", "sbi_mailbox_transport_failed", "entry"],
    ["sbi-mailbox-refused", "sbi_mailbox_transport_failed", "api"],
  ]);
  expect(logged.join("\n")).not.toMatch(/synthetic|secret|jsessionid|token|evil/iu);
});

test("a refusal at the hand-off names the rule that refused, never the provider's header", async () => {
  const logged: string[] = [];
  const original = console.log;
  console.log = (line: string) => logged.push(line);
  const handingOff = (headers: Record<string, string>, status = 302) =>
    new MailboxHttp([], async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()).href;
      return url === MAILBOX_MAIN_LINK
        ? new Response(null, { status: 302, headers: { location: HANDOFF } })
        : new Response(null, { status, headers });
    });
  const onward = { location: "/switchnaviMain" };
  try {
    for (const [headers, status, expected] of [
      [{}, 302, { reason: "no-location" }],
      [onward, 404, { reason: "status" }],
      [{ location: "https://[synthetic-secret" }, 302, { reason: "bad-location" }],
      [{ ...onward, "set-cookie": "synthetic-secret" }, 302, { reason: "cookie-pair" }],
      [
        { ...onward, "set-cookie": "secret=synthetic; Path=/; Secure; Path=/synthetic-secret" },
        302,
        { reason: "cookie-attribute", cookieAttribute: "path" },
      ],
      [
        { ...onward, "set-cookie": "secret=synthetic; X-Synthetic-Secret=1; x-synthetic-secret=2" },
        302,
        { reason: "cookie-attribute", cookieAttribute: "other" },
      ],
      [
        { ...onward, "set-cookie": "secret=synthetic; Domain=synthetic-secret.invalid" },
        302,
        { reason: "cookie-domain" },
      ],
      [{ ...onward, "set-cookie": "secret=synthetic; Path=" }, 302, { reason: "cookie-path" }],
      [{ ...onward, "set-cookie": "secret(1)=synthetic; Path=/" }, 302, { reason: "cookie-name" }],
    ] as const) {
      const client = handingOff(headers, status);
      await expect(client.open()).rejects.toThrow("sbi_mailbox_transport_failed");
      expect(client.lastDiagnosis).toEqual({ step: "landing", hop: 1, status, ...expected });
    }
    // A hand-off request that never answers carries no status from the hop before it.
    const unanswered = new MailboxHttp([], async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString()).href;
      if (url === MAILBOX_MAIN_LINK)
        return new Response(null, { status: 302, headers: { location: HANDOFF } });
      throw new TypeError("synthetic-secret network failure");
    });
    await expect(unanswered.open()).rejects.toThrow("sbi_mailbox_transport_failed");
    expect(unanswered.lastDiagnosis).toEqual({ step: "landing", hop: 1, reason: "request-failed" });
  } finally {
    console.log = original;
  }
  expect(logged).toHaveLength(10);
  expect(logged.join("\n")).not.toMatch(/synthetic|secret/iu);
});

test("a refused bootstrap page logs its grammar rule and count, never the page", async () => {
  const logged: string[] = [];
  const original = console.log;
  console.log = (line: string) => logged.push(line);
  try {
    const { fetcher } = sequence();
    const client = new MailboxHttp([], async (input, init) =>
      new URL(input instanceof Request ? input.url : input.toString()).href === MAILBOX_BOOTSTRAP
        ? html(mailboxBootstrapHtml().replace("</body>", "<script>var secret = 1;</script></body>"))
        : fetcher(input, init),
    );
    await expect(client.open()).rejects.toThrow("sbi_mailbox_bootstrap_unobserved");
    expect(client.lastDiagnosis).toEqual({
      step: "sso",
      hop: 1,
      status: 200,
      contentType: "text/html",
      bootstrapRule: "script-element",
      bootstrapCount: 2,
    });
  } finally {
    console.log = original;
  }
  expect(logged).toHaveLength(1);
  expect(logged[0]).not.toMatch(/secret|synthetic/iu);
});

test("calls the fetcher unbound, as the Workers runtime's fetch requires", async () => {
  const { fetcher, calls } = sequence();
  // workerd's fetch refuses any receiver other than the global scope.
  const strict = function (this: unknown, input: string | URL | Request, init?: RequestInit) {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    return fetcher(input, init);
  };
  await new MailboxHttp([], strict).open();
  expect(calls.map((call) => call.url)).toContain(MAILBOX_APPLICATION);
});

test("the report link follows the signed-in classic host and nothing else", () => {
  const link = (href: string | undefined) => mailboxMainLink(href ? new URL(href) : undefined);
  expect(link("https://site2.sbisec.co.jp/ETGate/?x=1")).toBe(
    MAILBOX_MAIN_LINK.replace("site4.", "site2."),
  );
  for (const href of [
    undefined,
    "https://www.sbisec.co.jp/ETGate/",
    "https://login.sbisec.co.jp/",
    "http://site2.sbisec.co.jp/ETGate/",
    "https://site2.sbisec.co.jp.invalid/ETGate/",
    "https://site123.sbisec.co.jp/ETGate/",
  ])
    expect(link(href)).toBe(MAILBOX_MAIN_LINK);
  expect(() => new MailboxHttp([], fetch, Infinity, undefined, "https://evil.invalid/")).toThrow(
    "sbi_mailbox_transport_failed",
  );
});
