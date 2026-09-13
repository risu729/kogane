import { describe, expect, test } from "bun:test";
import iconv from "iconv-lite";
import {
  collectMizuho,
  extractMizuhoForm,
  parseSession,
  safeMizuhoErrorCode,
  type MizuhoSession,
} from "../src/client";

// Synthetic values and markup only. These tests never contact a bank.
const ORIGIN = "https://web1.ib.mizuhobank.co.jp";
const ACCOUNT = "/servlet/MENSRV0100002B.do";
const HISTORY = "/servlet/BALINQ0301002B.do";
const fields = (name: string, token = "private-token") => ({
  _FRAMEID: "frame",
  _TARGETID: "old-target",
  _LUID: "private-luid",
  _TOKEN: token,
  _FORMID: name,
  _SUBINDEX: "old-index",
  POSTKEY: "private-postkey",
});
const session = (): MizuhoSession => ({
  origin: ORIGIN,
  cookies: "JSESSIONID=private-cookie",
  userAgent: "Owner Browser",
  referer: ORIGIN + HISTORY,
  form: { name: "ACCHST_04110B", fields: fields("ACCHST_04110B") },
});
const span = (id: string, text: string) => `<span id="${id}">${text}</span>`;
function form(name: string, content: string, token = "fresh-token"): string {
  return `<form name="${name}" method="POST">${Object.entries(fields(name, token))
    .map(([key, value]) => `<input name="${key}" type="hidden" value="${value}">`)
    .join("")}${content}</form>`;
}
function card(index = "000", number = "001-1234567"): string {
  return `<button class="btn-account" type="button" onclick="doTransaction('/BALINQ0301002B','${Number(index)}',false,null,this.form,null,null)">${span(`txtAccType_${index}`, "普通預金")}
    ${span(`txtBrnch_${index}`, "テスト支店")}${span(`txtAccNo_${index}`, number)}
    ${span(`txtCrntBalBrrwBal_${index}`, "1,234")}${span(`txtCrntBalBrrwBalCrenCode_${index}`, "円")}
    ${span(`txtBrrwUsblBal_${index}`, "1,234")}</button>`;
}
const accountHtml = (cards = card(), token = "account-token") =>
  form("BALINQ_03010B", cards, token);
function historyHtml(total = 1, number = "1234567"): string {
  return form(
    "ACCHST_04110B",
    `${span("txtBrnch", "テスト支店")}${span("txtTransType", "普通")}${span("txtAccNo", number)}
    <div class="box-row-tx-ditails"><div class="t1-1">${span("txtTransCntnt_000", "テスト入金")}
    ${span("txtDate_000", "2026年9月1日")}</div><div class="t1-2"><span class="amount">+ 1<small>円</small></span>
    ${span("txtEachBal_000", "1,234")}</div><div class="t1-3">${span("txtEachBal_000", "1,234")}</div></div>
    ${span("txtDispDetails", "1&nbsp;-&nbsp;1&nbsp;件")}${span("txtAllDispDetails", String(total))}`,
    "history-token",
  );
}
const html = (body: string, extra: Record<string, string> = {}) =>
  new Response(new Uint8Array(iconv.encode(body, "shift_jis")), {
    headers: { "content-type": "text/html; charset=Shift_JIS", ...extra },
  });
const redirect = (path: string, extra: Record<string, string> = {}) =>
  new Response(null, {
    status: 302,
    headers: {
      location: `${ORIGIN}:443${path}?REQTYPE=x&_FRAMEID=f&_TARGETID=f&_LUID=l&_TOKEN=t&_SUBINDEX=`,
      ...extra,
    },
  });
function queued(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetcher: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const result = responses.shift();
      if (!result) throw new Error("unexpected synthetic call");
      return result;
    },
  };
}

describe("direct Mizuho read transport", () => {
  test("reads accounts and history with fresh forms, observed redirects and cookie rotation", async () => {
    const q = queued([
      redirect(ACCOUNT, { "set-cookie": "JSESSIONID=rotated; Path=/; Secure; HttpOnly" }),
      html(accountHtml()),
      redirect(HISTORY),
      html(historyHtml()),
    ]);
    const initial = session();
    const result = await collectMizuho({ session: initial, fetcher: q.fetcher });
    expect(result.partial).toBe(false);
    expect(result.accounts).toHaveLength(1);
    expect(result.histories[0]?.transactions[0]?.amountYen).toBe("1");
    expect(q.calls.map((call) => call.init.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(q.calls[1]?.init.headers).toMatchObject({ cookie: "JSESSIONID=rotated" });
    const first = new URLSearchParams(String(q.calls[0]?.init.body));
    const history = new URLSearchParams(String(q.calls[2]?.init.body));
    expect(first.get("_TARGETID")).toBe("frame");
    expect(first.get("_SUBINDEX")).toBe("");
    expect(history.get("_TOKEN")).toBe("account-token");
    expect(history.get("_FORMID")).toBe("BALINQ_03010B");
    expect(history.get("_SUBINDEX")).toBe("0");
    expect(
      q.calls.every((call) => call.init.redirect === "manual" && call.init.credentials === "omit"),
    ).toBe(true);
    expect(result.artifacts.map((a) => a.artifactKey)).toEqual([
      "account-list.html",
      "ordinary/001-1234567/history/1-1.html",
    ]);
    expect(result.artifacts.map((a) => a.unitKey)).toEqual([
      "account-list",
      "ordinary:001:1234567:page:1:1",
    ]);
    expect(JSON.stringify(result.artifacts)).not.toContain("token");
    expect(JSON.stringify(result.artifacts)).not.toContain("private-cookie");
    expect(result.session.form.fields._TOKEN).toBe("history-token");
    expect(initial.form.fields._TOKEN).toBe("private-token");
  });
  test("flags unobserved pagination without inventing a next-page request", async () => {
    const q = queued([html(accountHtml()), html(historyHtml(2))]);
    const result = await collectMizuho({ session: session(), fetcher: q.fetcher });
    expect(q.calls).toHaveLength(2);
    expect(result.partial).toBe(true);
    expect(result.issues).toEqual(["history-pagination-unverified"]);
    expect(result.artifacts[1]?.partial).toBe(true);
  });
  test("retains account evidence when authentication expires before history", async () => {
    const q = queued([
      html(accountHtml()),
      html('<form name="LOGBNK_00000B"><input name="txbCustNo"></form>'),
    ]);
    const result = await collectMizuho({ session: session(), fetcher: q.fetcher });
    expect(result.partial).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    expect(result.issues).toEqual(["authentication-required"]);
    expect(result.failedUnits).toEqual(["ordinary:001:1234567"]);
  });
  test("refreshes the list before each account and uses rediscovered row indexes", async () => {
    const q = queued([
      html(accountHtml(card() + card("001", "002-7654321"))),
      html(historyHtml()),
      html(accountHtml(card("000", "002-7654321") + card("001"), "rediscovery-token")),
      html(historyHtml(1, "7654321")),
    ]);
    const result = await collectMizuho({ session: session(), fetcher: q.fetcher });
    expect(result.histories).toHaveLength(2);
    const last = new URLSearchParams(String(q.calls[3]?.init.body));
    expect(last.get("_SUBINDEX")).toBe("0");
    expect(last.get("_TOKEN")).toBe("rediscovery-token");
  });
  test("reports an account cap as partial and retains all discovery evidence", async () => {
    const q = queued([html(accountHtml(card() + card("001", "002-7654321"))), html(historyHtml())]);
    const result = await collectMizuho({ session: session(), fetcher: q.fetcher, maxAccounts: 1 });
    expect(result.accounts).toHaveLength(2);
    expect(result.histories).toHaveLength(1);
    expect(result.issues).toContain("account-limit");
    expect(result.failedUnits).toContain("ordinary:002:7654321");
  });
  test("does not guess account transitions when the observed read event is missing", async () => {
    const q = queued([html(accountHtml().replace("/BALINQ0301002B", "/BALINQ0301003B"))]);
    const result = await collectMizuho({ session: session(), fetcher: q.fetcher });
    expect(q.calls).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    expect(result.issues).toEqual(["invalid-account-read-event"]);
  });
  test.each([
    "https://example.com/servlet/MENSRV0100002B.do",
    `${ORIGIN}/servlet/TRANSFER0000001B.do`,
    `${ORIGIN}/servlet/LOGBNK0000000B.do`,
    `${ORIGIN}:444${ACCOUNT}`,
    `https://owner@web1.ib.mizuhobank.co.jp${ACCOUNT}`,
    `${ORIGIN}${ACCOUNT}?extra=private-secret`,
  ])("rejects redirects before forwarding cookies: %s", async (location) => {
    const q = queued([new Response(null, { status: 302, headers: { location } })]);
    await expect(collectMizuho({ session: session(), fetcher: q.fetcher })).rejects.toThrow(
      "read-redirect-rejected",
    );
    expect(q.calls).toHaveLength(1);
  });
  test("rejects repeated redirects and never retries", async () => {
    const q = queued([redirect(ACCOUNT), redirect(ACCOUNT)]);
    await expect(collectMizuho({ session: session(), fetcher: q.fetcher })).rejects.toThrow(
      "read-redirect-rejected",
    );
    expect(q.calls).toHaveLength(2);
  });
  test("bounds a fetch ignoring abort and does not expose its error", async () => {
    await expect(
      collectMizuho({ session: session(), timeoutMs: 5, fetcher: () => new Promise(() => {}) }),
    ).rejects.toThrow("collection-timeout");
    await expect(
      collectMizuho({
        session: session(),
        fetcher: async () => {
          throw new Error("private-cookie");
        },
      }),
    ).rejects.toThrow("read-network-error");
  });
  test("returns partial evidence on a stalled history response", async () => {
    let count = 0;
    const result = await collectMizuho({
      session: session(),
      timeoutMs: 10,
      fetcher: async () =>
        ++count === 1 ? html(accountHtml()) : await new Promise<Response>(() => {}),
    });
    expect(result.partial).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    expect(result.issues).toContain("collection-timeout");
  });
  test("enforces byte bounds before parsing", async () => {
    await expect(
      collectMizuho({
        session: session(),
        fetcher: async () => html("x", { "content-length": String(1024 * 1024 + 1) }),
      }),
    ).rejects.toThrow("response-too-large");
    await expect(
      collectMizuho({ session: session(), fetcher: async () => html("x".repeat(1024 * 1024 + 1)) }),
    ).rejects.toThrow("response-too-large");
  });
  test("encodes existing non-ASCII form values as Shift_JIS and preserves selected controls", async () => {
    const initial = session();
    initial.form.fields.txbSearchWord = "検索";
    const q = queued([html(accountHtml()), html(historyHtml())]);
    await collectMizuho({ session: initial, fetcher: q.fetcher });
    const encoded = String(q.calls[0]?.init.body).split("txbSearchWord=")[1]!.split("&")[0]!;
    const bytes = Uint8Array.from(
      encoded.match(/%[0-9A-F]{2}/gu)!.map((value) => Number.parseInt(value.slice(1), 16)),
    );
    expect(iconv.decode(bytes, "shift_jis")).toBe("検索");
    expect(encoded).not.toContain("%E6");
    const controls = extractMizuhoForm(
      form(
        "ACCHST_04110B",
        '<select name="lstDateFromMonth"><option value="1">1</option><option selected value="2">2</option></select><input type="radio" name="rdoPopDate" value="a"><input checked type="radio" name="rdoPopDate" value="b">',
      ),
    );
    expect(controls.fields.lstDateFromMonth).toBe("2");
    expect(controls.fields.rdoPopDate).toBe("b");
  });
  test("rejects foreign cookie updates", async () => {
    await expect(
      collectMizuho({
        session: session(),
        fetcher: async () =>
          html(accountHtml(), { "set-cookie": "session=secret; Domain=example.com" }),
      }),
    ).rejects.toThrow("invalid-session-cookie-update");
  });
});

describe("private session boundary", () => {
  test("strictly validates owner session JSON and normalizes default port", () => {
    expect(parseSession(JSON.stringify({ ...session(), origin: ORIGIN + ":443" })).origin).toBe(
      ORIGIN,
    );
    expect(() =>
      parseSession(JSON.stringify({ ...session(), password: "private-secret" })),
    ).toThrow("invalid-session-json");
    expect(() => parseSession("private-secret")).toThrow("invalid-session-json");
    expect(() =>
      parseSession(JSON.stringify({ ...session(), origin: "https://example.com" })),
    ).toThrow("invalid-session-origin");
    expect(() =>
      parseSession(JSON.stringify({ ...session(), cookies: "a=x\r\nprivate-secret" })),
    ).toThrow("invalid-session-cookies");
    expect(safeMizuhoErrorCode(new Error("private-secret"))).toBe("read-parse-error");
  });
  test("rejects credential fields and duplicate state instead of submitting them", () => {
    const invalid = session();
    invalid.form.fields.PASSWD_LoginPwdInput = "private-secret";
    expect(() => parseSession(JSON.stringify(invalid))).toThrow("invalid-form-state");
    expect(() =>
      extractMizuhoForm(form("ACCHST_04110B", '<input name="_TOKEN" value="private-secret">')),
    ).toThrow("duplicate-form-control");
  });
});
