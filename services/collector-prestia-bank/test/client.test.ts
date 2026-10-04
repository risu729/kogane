import { describe, expect, test, spyOn } from "bun:test";
import {
  collectPrestiaBank,
  extractPrestiaForm,
  safePrestiaBankError,
  PrestiaBankError,
} from "../src/client";
import { prestiaBankHtml } from "../../../packages/parsers/test/prestia-bank-fixture";
import { sanitizePrestiaBankPage } from "../../../packages/parsers/src/parsers/prestia-bank-html";

function state(name: string): string {
  return `<form name="${name}">${Object.entries({
    _FRAMEID: "frame",
    _TARGETID: "",
    _LUID: "private-luid",
    _TOKEN: "private-token",
    _FORMID: name,
    _SUBINDEX: "",
    LOCALE: "ja_JP",
  })
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}">`)
    .join("")}</form>`;
}
const response = (
  body: string,
  cookies = [
    "JSESSIONID=private-cookie; Domain=smbctb.co.jp; Path=/ib",
    "co02=private-co02; Path=/",
  ],
) => {
  const headers = new Headers({ "content-type": "text/html; charset=UTF-8" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(body, { status: 200, headers });
};
const credentials = {
  userId: "syntheticuser12",
  password: "Synthetic#password",
  userAgent: "Synthetic WebView",
};
const readPage = () =>
  prestiaBankHtml().replace(
    '<form name="ACKZDSP" action="/bank">',
    state("ACKZDSP").replace("</form>", ""),
  );
describe("bounded read-only PRESTIA bank app HTTP transport", () => {
  test("stalled response bodies respect the request deadline and cancel without credential retry", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      originalTimeout(ms === 30_000 ? 20 : 200),
    );
    let calls = 0,
      cancelled = false;
    try {
      await expect(
        collectPrestiaBank(credentials, async () => {
          calls++;
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/html" } },
          );
        }),
      ).rejects.toThrow("request-timeout");
      expect(calls).toBe(1);
      expect(cancelled).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
  test("response body failures use closed network errors without provider text", async () => {
    await expect(
      collectPrestiaBank(
        credentials,
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("private-stream-error"));
              },
            }),
            { headers: { "content-type": "text/html" } },
          ),
      ),
    ).rejects.toThrow("network-error");
  });
  test("provider cookie deletion is honored and logout clearing is not reported as failure", async () => {
    const pages = [state("POSNIN1"), state("POMHTOP"), readPage(), "<html>signed off</html>"];
    let calls = 0;
    const collection = await collectPrestiaBank(credentials, async (_, init) => {
      calls++;
      if (calls === 3) expect(new Headers(init.headers).get("cookie")).not.toContain("co02=");
      return response(
        pages[calls - 1]!,
        calls === 1
          ? undefined
          : calls === 2
            ? ["co02=; Max-Age=0; Path=/"]
            : calls === 4
              ? ["JSESSIONID=; Max-Age=0; Path=/ib"]
              : [],
      );
    });
    expect(collection.signoffFailed).toBe(false);
    expect(calls).toBe(4);
  });
  test("one login, fixed balance route, rotating app cookies, bank-derived sanitized evidence and signoff", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const pages = [state("POSNIN1"), state("POMHTOP"), readPage(), "<html>signed off</html>"];
    const collection = await collectPrestiaBank(credentials, async (url, init) => {
      calls.push({ url, init });
      return response(
        pages[calls.length - 1]!,
        calls.length === 2
          ? ["JSESSIONID=rotated-cookie; Domain=smbctb.co.jp; Path=/ib"]
          : calls.length === 1
            ? [
                "JSESSIONID=first-cookie; Domain=smbctb.co.jp; Path=/ib",
                "co02=private-co02; Path=/",
                "ak_bmsc=not-forwarded; Path=/",
              ]
            : [],
      );
    });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/ib/portal/POSNIN1prestiatop.prst",
      "/ib/portal/POSNIN1next.prst",
      "/ib/top/TOMETOPaccountinfokozazandaka.prst",
      "/ib/top/TOMETOPportalsignoff.prst",
    ]);
    expect(new URL(calls[1]!.url).hostname).toBe("mlogin.smbctb.co.jp");
    const body = new URLSearchParams(calls[1]!.init.body as string);
    expect(body.get("password")).toBe(credentials.password);
    expect(body.get("disppassword")).toBe(credentials.password);
    expect(body.get("_TARGETID")).toBe("");
    const headers = new Headers(calls[2]!.init.headers);
    expect(headers.get("cookie")).toContain("JSESSIONID=rotated-cookie;");
    expect(headers.get("cookie")).toContain("co02=private-co02;");
    expect(headers.get("cookie")).not.toContain("ak_bmsc");
    expect(headers.get("X-FORWARDED-UA")).toBe("Synthetic WebView PrestiaApp/1.4.1");
    expect(headers.get("via")).toBe("appli");
    expect(collection).toMatchObject({
      accountCount: 6,
      foreignCurrencyCount: 3,
      aggregateCount: 7,
      monthlyAverageCount: 3,
      signoffFailed: false,
    });
    expect(sanitizePrestiaBankPage(collection.body)).toBe(collection.body);
    for (const secret of [
      credentials.userId,
      credentials.password,
      "private-token",
      "private-cookie",
      "private-co02",
    ])
      expect(collection.body).not.toContain(secret);
    for (const call of calls) expect(call.init.redirect).toBe("manual");
  });
  test("missing credentials or malformed bootstrap stop before any password submission", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return response(
        state("POSNIN1").replace(
          'name="_TOKEN" value="private-token"',
          'name="password" value="private-token"',
        ),
      );
    };
    await expect(collectPrestiaBank({ userId: "", password: "" }, fetcher)).rejects.toThrow(
      "credentials-missing",
    );
    expect(calls).toBe(0);
    await expect(collectPrestiaBank(credentials, fetcher)).rejects.toThrow("invalid-form-state");
    expect(calls).toBe(1);
    expect(
      extractPrestiaForm(
        state("POSNIN1").replace('name="_TARGETID" value=""', 'name="_TARGETID"'),
        "POSNIN1",
      )._TARGETID,
    ).toBe("");
    expect(() =>
      extractPrestiaForm(
        state("POSNIN1").replace(
          "</form>",
          '<input type="hidden" name="_TOKEN" value="duplicate"></form>',
        ),
        "POSNIN1",
      ),
    ).toThrow("invalid-form-state");
  });
  test.each([
    [state("POSNIN1") + '<div id="errorMsgArea">provider-private-error</div>', "login-rejected"],
    ['<form name="AUOTIN1"></form>', "login-challenge-required"],
    ["<html>unknown-private-response</html>", "login-page-unknown"],
  ])(
    "refuses rejected/challenge/unknown login without retry or balance navigation",
    async (login, code) => {
      let calls = 0;
      await expect(
        collectPrestiaBank(credentials, async () =>
          response(++calls === 1 ? state("POSNIN1") : login),
        ),
      ).rejects.toThrow(code);
      expect(calls).toBe(2);
    },
  );
  test("redirects and response overflow are closed failures, never followed", async () => {
    let calls = 0;
    await expect(
      collectPrestiaBank(credentials, async () => {
        calls++;
        return new Response("", {
          status: 302,
          headers: { location: "https://evil.test/transfer" },
        });
      }),
    ).rejects.toThrow("redirect-rejected");
    expect(calls).toBe(1);
    await expect(
      collectPrestiaBank(credentials, async () => response("x".repeat(1024 * 1024 + 1))),
    ).rejects.toThrow("response-too-large");
    await expect(
      collectPrestiaBank(
        credentials,
        async () => new Response("", { headers: { "content-type": "application/json" } }),
      ),
    ).rejects.toThrow("response-type-unknown");
  });
  test("network and timeout errors never expose provider text or resend credentials", async () => {
    for (const error of [
      new Error("provider-secret-error"),
      new DOMException("private-timeout", "TimeoutError"),
    ]) {
      let calls = 0;
      try {
        await collectPrestiaBank(credentials, async () => {
          calls++;
          throw error;
        });
        throw new Error("expected failure");
      } catch (caught) {
        expect(safePrestiaBankError(caught)).toBe(
          error.name === "TimeoutError" ? "request-timeout" : "network-error",
        );
      }
      expect(calls).toBe(1);
    }
    expect(safePrestiaBankError(new Error("provider-secret"))).toBe("balance-parse-error");
    expect(safePrestiaBankError(new PrestiaBankError("login-rejected"))).toBe("login-rejected");
  });
  test("signoff failure is recorded without discarding acquired balance evidence", async () => {
    let calls = 0;
    const pages = [state("POSNIN1"), state("POMHTOP"), readPage()];
    const collection = await collectPrestiaBank(credentials, async () => {
      calls++;
      if (calls === 4) throw Error("private-logout-error");
      return response(pages[calls - 1]!);
    });
    expect(collection.signoffFailed).toBe(true);
    expect(collection.accountCount).toBe(6);
    expect(calls).toBe(4);
  });
});
