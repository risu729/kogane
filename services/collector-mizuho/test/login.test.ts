import { describe, expect, test } from "bun:test";
import iconv from "iconv-lite";
import { loginMizuho } from "../src/login";
import { MizuhoClientError, parseSession } from "../src/client";

// Entirely synthetic login protocol fixtures. Never use a real bank fetcher here.
const ENTRY = "https://web.ib.mizuhobank.co.jp/servlet/LOGBNK0000000B.do";
const ORIGIN = "https://web1.ib.mizuhobank.co.jp";
const CUSTOMER = "/servlet/LOGBNK0000001B.do";
const PASSWORD = "/servlet/LOGBNK0000501B.do";
const NOTICE = "/servlet/LOGCNF0240001B.do";
const credentials = { customerNumber: "12345678", password: "SyntheticPassword123" };
const coreNames = [
  "_FORMID",
  "_FRAMEID",
  "_LUID",
  "_SUBINDEX",
  "_TARGETID",
  "_TOKEN",
  "POSTKEY",
].sort();
function fields(name: string, token: string): string {
  return Object.entries({
    _FORMID: name,
    _FRAMEID: "frame",
    _TARGETID: "frame",
    _LUID: "fixture-luid",
    _SUBINDEX: "",
    _TOKEN: token,
    POSTKEY: "fixture-postkey",
  })
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`)
    .join("");
}
function page(name: string, content: string, token = "fixture-token"): string {
  return `<html><head><meta charset="Shift_JIS"><base href="${ORIGIN}:443/servlet/"></head><body>
    <form name="${name}" method="POST" action="">${fields(name, token)}${content}</form></body></html>`;
}
const customerPage = () =>
  page(
    "LOGBNK_00000B",
    `<input type="hidden" name="CLIENT_ENV" value="">
  <input name="txbCustNo" type="text" minlength="8" maxlength="10" autocomplete="off" value="">
  <button type="button" onclick="if(N00000InputCheck('txbCustNo')){doTransaction('/LOGBNK0000001B',null,false,null,this.form,null,null);}">次へ</button>`,
    "customer-token",
  );
const passwordPage = () =>
  page(
    "LOGBNK_00005B",
    `<input name="dsdt" type="hidden" value="0">
  <input name="PASSWD_LoginPwdInput" type="password" pattern=".{4,32}" autocomplete="off" value="">
  <button type="button" onclick="if(N00000InputCheck_32('PASSWD_LoginPwdInput')){doTransaction('/LOGBNK0000501B',null,false,null,this.form,null,null);}">ログイン</button>`,
    "password-token",
  );
const noticePage = () =>
  page(
    "LOGCNF_02400B",
    `<input type="checkbox" name="checkbox_check1" value="on">
  <input type="checkbox" name="chkMsgCnf_000" value="on"><input type="checkbox" name="chkMsgCnf_001" value="on">
  <button type="button" onclick="doTransaction('/LOGCNF0240001B',null,false,null,this.form,null,null)">次へ</button>`,
    "notice-token",
  );
const homePage = () =>
  page("MENTOP_02000B", '<input type="hidden" name="CLIENT_ENV" value="">', "home-token");
const html = (body: string, moreHeaders: Record<string, string> = {}) =>
  new Response(new Uint8Array(iconv.encode(body, "shift_jis")), {
    headers: { "content-type": "text/html; charset=Shift_JIS", ...moreHeaders },
  });
const redirect = (path: string, moreHeaders: Record<string, string> = {}) =>
  new Response(null, {
    status: 302,
    headers: {
      location: `${ORIGIN}:443${path}?REQTYPE=x&_FRAMEID=f&_TARGETID=f&_LUID=l&_TOKEN=t&_SUBINDEX=`,
      ...moreHeaders,
    },
  });
function queue(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetcher: async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      const value = responses.shift();
      if (value instanceof Error) throw value;
      if (!value) throw new Error("unexpected synthetic request");
      return value;
    },
  };
}
const start = () =>
  html(customerPage(), {
    "set-cookie":
      "JSESSIONID=bootstrap-cookie; Domain=.ib.mizuhobank.co.jp; Path=/servlet; Secure; HttpOnly",
  });
async function expectFixedFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("expected login rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(MizuhoClientError);
    expect((error as MizuhoClientError).code).toMatch(/^login-/u);
    expect(String(error)).not.toContain(credentials.password);
    expect(String(error)).not.toContain(credentials.customerNumber);
    expect(String(error)).not.toContain("provider-private-value");
  }
}

describe("Mizuho automatic HTTP login", () => {
  test("reproduces the observed fresh login, JavaScript marker, cookie rotation and unchecked notices", async () => {
    const q = queue([
      start(),
      redirect(CUSTOMER),
      html(passwordPage()),
      redirect(PASSWORD, {
        "set-cookie":
          "JSESSIONID=authenticated-cookie; Domain=.ib.mizuhobank.co.jp; Path=/servlet/; Secure; HttpOnly",
      }),
      html(noticePage()),
      redirect(NOTICE),
      html(homePage()),
    ]);
    const session = await loginMizuho({ ...credentials, fetcher: q.fetcher });
    expect(q.calls).toHaveLength(7);
    expect(q.calls[0]?.url).toBe(ENTRY);
    expect(q.calls.map((call) => call.init.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
      "GET",
      "POST",
      "GET",
    ]);
    expect(q.calls.every((call) => call.init.redirect === "manual")).toBe(true);
    const customer = new URLSearchParams(String(q.calls[1]?.init.body));
    expect(new URL(q.calls[1]!.url).origin).toBe(ORIGIN);
    expect(customer.get("txbCustNo")).toBe(credentials.customerNumber);
    expect(customer.get("CLIENT_ENV")).toContain(";");
    expect(customer.get("_TOKEN")).toBe("customer-token");
    expect(customer.get("_SUBINDEX")).toBe("");
    const password = new URLSearchParams(String(q.calls[3]?.init.body));
    expect(password.get("PASSWD_LoginPwdInput")).toBe(credentials.password);
    expect(password.get("dsdt")).toBe("1");
    expect(password.get("_TOKEN")).toBe("password-token");
    expect(password.has("txbCustNo")).toBe(false);
    const notices = new URLSearchParams(String(q.calls[5]?.init.body));
    expect([...notices.keys()].sort()).toEqual(coreNames);
    expect(notices.get("_TOKEN")).toBe("notice-token");
    const noticeCookies = new Headers(q.calls[5]?.init.headers).get("cookie")!;
    expect(noticeCookies).toContain("JSESSIONID=authenticated-cookie");
    expect(noticeCookies).not.toContain("bootstrap-cookie");
    expect((noticeCookies.match(/JSESSIONID=/gu) ?? []).length).toBe(1);
    expect(session.origin).toBe(ORIGIN);
    expect(session.form.name).toBe("MENTOP_02000B");
    expect(session.form.fields._TOKEN).toBe("home-token");
    expect(JSON.stringify(session)).not.toContain(credentials.password);
    expect(JSON.stringify(session)).not.toContain(credentials.customerNumber);
    expect(parseSession(JSON.stringify(session)).form.name).toBe("MENTOP_02000B");
  });
  test("accepts successful login with no optional notice screen", async () => {
    const q = queue([
      start(),
      redirect(CUSTOMER),
      html(passwordPage()),
      redirect(PASSWORD),
      html(homePage()),
    ]);
    const session = await loginMizuho({ ...credentials, fetcher: q.fetcher });
    expect(session.form.name).toBe("MENTOP_02000B");
    expect(q.calls).toHaveLength(5);
  });
  test("stops on an unknown challenge without requesting or submitting a PIN", async () => {
    const challenge = page(
      "LOGBNK_99999B",
      '<input name="challengePin" type="password"><p>追加認証</p>',
    );
    const q = queue([start(), redirect(CUSTOMER), html(challenge)]);
    await expectFixedFailure(loginMizuho({ ...credentials, fetcher: q.fetcher }));
    expect(q.calls).toHaveLength(3);
    expect(q.calls.some((call) => new URL(call.url).pathname === PASSWORD)).toBe(false);
  });
  test("does not retry a rejected password or disclose provider error text", async () => {
    const q = queue([
      start(),
      redirect(CUSTOMER),
      html(passwordPage()),
      redirect(PASSWORD),
      html(
        passwordPage().replace("</form>", '<p id="ErrorMessage">provider-private-value</p></form>'),
      ),
    ]);
    await expectFixedFailure(loginMizuho({ ...credentials, fetcher: q.fetcher }));
    expect(
      q.calls.filter(
        (call) => call.init.method === "POST" && new URL(call.url).pathname === PASSWORD,
      ),
    ).toHaveLength(1);
    expect(q.calls).toHaveLength(5);
  });
  test("does not retry a password POST after an uncertain transport failure", async () => {
    const q = queue([
      start(),
      redirect(CUSTOMER),
      html(passwordPage()),
      new Error(`provider-private-value ${credentials.password}`),
    ]);
    await expectFixedFailure(loginMizuho({ ...credentials, fetcher: q.fetcher }));
    expect(q.calls).toHaveLength(4);
  });
  test.each([
    "https://example.com/servlet/LOGBNK0000001B.do",
    `${ORIGIN}/servlet/TRANSFER0000001B.do`,
    `${ORIGIN}/servlet/LOGBNK0000501B.do`,
    `https://name@web1.ib.mizuhobank.co.jp${CUSTOMER}`,
    `${ORIGIN}:444${CUSTOMER}`,
    `${ORIGIN}${CUSTOMER}?unknown=provider-private-value`,
  ])("rejects unobserved redirects before another credential request: %s", async (location) => {
    const q = queue([start(), new Response(null, { status: 302, headers: { location } })]);
    await expectFixedFailure(loginMizuho({ ...credentials, fetcher: q.fetcher }));
    expect(q.calls).toHaveLength(2);
  });
  test("rejects an untrusted bootstrap form origin before submitting customer credentials", async () => {
    const q = queue([html(customerPage().replace(`${ORIGIN}:443`, "https://example.com"))]);
    await expectFixedFailure(loginMizuho({ ...credentials, fetcher: q.fetcher }));
    expect(q.calls).toHaveLength(1);
  });
  test("stops before credentials when the public entry is unavailable or unfamiliar", async () => {
    for (const body of [
      "<p>SERVICE unavailable: 50010</p>",
      "<p>SERVICE Unavailable:50020</p>",
      '<form name="UNRECOGNIZED"></form>',
    ]) {
      const q = queue([html(body)]);
      await expectFixedFailure(loginMizuho({ ...credentials, fetcher: q.fetcher }));
      expect(q.calls).toHaveLength(1);
    }
  });
  test("has a hard deadline even when a transport ignores AbortSignal", async () => {
    let requests = 0;
    await expectFixedFailure(
      loginMizuho({
        ...credentials,
        timeoutMs: 5,
        fetcher: async () => {
          requests++;
          return new Promise<Response>(() => {});
        },
      }),
    );
    expect(requests).toBe(1);
  });
  test("bounds an unfinished response body and does not submit credentials", async () => {
    let requests = 0;
    await expectFixedFailure(
      loginMizuho({
        ...credentials,
        timeoutMs: 5,
        fetcher: async () => {
          requests++;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([65]));
              },
            }),
            { headers: { "content-type": "text/html; charset=Shift_JIS" } },
          );
        },
      }),
    );
    expect(requests).toBe(1);
  });
});
