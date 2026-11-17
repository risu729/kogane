import { expect, test } from "bun:test";
import {
  MailboxHttp,
  MAILBOX_MAIN_LINK,
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
function sequence(
  extra: (url: URL, init: RequestInit) => Promise<Response> = async () =>
    new Response("{}", { headers: { "content-type": "application/json" } }),
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url: url.href, init });
    if (url.href === MAILBOX_MAIN_LINK)
      return new Response(null, {
        status: 302,
        headers: { location: "https://m.sbisec.co.jp/switchnaviMain" },
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
    "https://m.sbisec.co.jp/switchnaviMain",
    MAILBOX_ENTRY,
    MAILBOX_CONNECT,
    MAILBOX_SSO,
    MAILBOX_BOOTSTRAP,
    MAILBOX_APPLICATION,
    "https://plus.e-shishobako.ne.jp/dp-uw/v1/DPAW010501030",
  ]);
  expect(new URLSearchParams(calls[3]!.init.body as URLSearchParams).get("ePoboxFlag")).toBe(
    "synthetic-ePoboxFlag",
  );
  expect([...new URLSearchParams(calls[4]!.init.body as URLSearchParams).keys()]).toEqual(fields);
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    expect(call.init.redirect).toBe("manual");
    expect(headers.has("authorization")).toBe(false);
    if (new URL(call.url).hostname.endsWith("sbisec.co.jp"))
      expect(headers.get("cookie")).toBe("sbi=synthetic-sbi");
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
