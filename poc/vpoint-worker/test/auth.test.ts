import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logAuthTrace } from "../src/diagnostics";
afterEach(() => mock.restore());
import {
  beginVPointEmailLogin,
  completeVPointEmailLogin,
  normalizeEmailCode,
  normalizeMemberNumber,
} from "../src/auth";

describe("V Point email login inputs", () => {
  test("normalizes supported member-number formats", () => {
    expect(normalizeMemberNumber("9234-5678-9012-3456")).toBe(
      "9234567890123456",
    );
    expect(normalizeMemberNumber("123 456 789")).toBe("123456789");
    expect(() => normalizeMemberNumber("1234")).toThrow("9 or 16 digits");
  });

  test("accepts the observed four- to six-digit email codes", () => {
    expect(normalizeEmailCode(" 1234 ")).toBe("1234");
    expect(normalizeEmailCode(" 12345 ")).toBe("12345");
    expect(normalizeEmailCode(" 123456 ")).toBe("123456");
    expect(() => normalizeEmailCode("1234567")).toThrow("4 to 6 digits");
  });
});

describe("V Point email login flow", () => {
  test.each([false, true])("replays the form chain with logging unavailable=%s", async (loggingUnavailable) => {
    if (loggingUnavailable) spyOn(console, "log").mockImplementation(() => { throw new Error("logger unavailable"); });
    const requests: Array<{ path: string; method: string; form: URLSearchParams }> = [];
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const form = typeof init?.body === "string"
        ? new URLSearchParams(init.body)
        : new URLSearchParams();
      requests.push({ path: url.pathname, method, form });

      switch (`${method} ${url.hostname}${url.pathname}`) {
        case "GET tsite.jp/tm/pc/login/STKIp0018001.do":
          return htmlResponse(formPage(), "JSESSIONID=initial; Path=/; Secure");
        case "POST tsite.jp/tm/pc/login/STKIp0002010.do":
          return htmlResponse(formPage('<input name="TID">'));
        case "POST tsite.jp/tm/pc/login/STKIp0002011.do":
          return htmlResponse(formPage());
        case "POST tsite.jp/tm/pc/login/STKIp0002040.do":
          return htmlResponse(formPage());
        case "POST tsite.jp/tm/pc/login/STKIp0002042.do":
          return htmlResponse(formPage('<input name="NINSYO_CD">'));
        case "POST tsite.jp/tm/pc/login/STKIp0002045.do":
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://mypage.tsite.jp/?hid=1",
              "set-cookie": "AUTH=authenticated; Domain=tsite.jp; Path=/; Secure",
            },
          });
        case "GET mypage.tsite.jp/":
          return htmlResponse("<html></html>");
        case "POST mypage.tsite.jp/api/user_info":
          return Response.json({ status: { code: "0000" }, results: {} });
        case "POST mypage.tsite.jp/api/balance_info":
          expect(new Headers(init?.headers).get("cookie")).toContain(
            "AUTH=authenticated",
          );
          return Response.json({ status: { code: "0000" }, results: {} });
        default:
          throw new Error(`unexpected request: ${method} ${url}`);
      }
    };

    const challenge = await beginVPointEmailLogin({
      memberNumber: "9234-5678-9012-3456",
      fetcher,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
      onTrace: (trace) => logAuthTrace("test-auth-run", trace),
    });
    expect(challenge.requestedAt).toBe("2026-08-31T00:00:00.000Z");

    const serializedState = JSON.parse(JSON.stringify(challenge.state));
    const result = await completeVPointEmailLogin({
      onTrace: (trace) => logAuthTrace("test-auth-run", trace),
      state: serializedState,
      code: "1234",
      fetcher,
    });
    expect(result.applicationStatus).toBe("0000");
    expect(result.sessionCookie).toContain("AUTH=authenticated");
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /tm/pc/login/STKIp0018001.do",
      "POST /tm/pc/login/STKIp0002010.do",
      "POST /tm/pc/login/STKIp0002011.do",
      "POST /tm/pc/login/STKIp0002040.do",
      "POST /tm/pc/login/STKIp0002042.do",
      "POST /tm/pc/login/STKIp0002045.do",
      "GET /",
      "GET /",
      "POST /api/user_info",
      "POST /api/balance_info",
    ]);
    for (const request of requests.filter(({ method }) => method === "POST")) {
      if (request.path.startsWith("/api/")) continue;
      expect(request.form.get("org.apache.struts.taglib.html.TOKEN")).toBe(
        "csrf-token",
      );
    }
    expect(requests[2]?.form.get("TID")).toBe("9234567890123456");
    expect(requests[5]?.form.get("NINSYO_CD")).toBe("1234");
  });

  test("rejects an invalid or expired server response", async () => {
    const fetcher = createRejectedCodeFetcher();
    const challenge = await beginVPointEmailLogin({
      memberNumber: "123456789",
      fetcher,
    });
    await expect(challenge.complete("1234")).rejects.toThrow(
      "rejected or expired",
    );
  });
});

function formPage(extra = ""): string {
  return `<form id="form"><input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="csrf-token">${extra}</form>`;
}

function htmlResponse(html: string, cookie?: string): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=windows-31j",
  });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(html, { status: 200, headers });
}

function createRejectedCodeFetcher(): (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET") return htmlResponse(formPage());
    if (url.pathname.endsWith("STKIp0002010.do")) {
      return htmlResponse(formPage('<input name="TID">'));
    }
    if (url.pathname.endsWith("STKIp0002042.do")) {
      return htmlResponse(formPage('<input name="NINSYO_CD">'));
    }
    return htmlResponse(formPage());
  };
}
