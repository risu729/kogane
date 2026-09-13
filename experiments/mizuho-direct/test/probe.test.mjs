import { describe, expect, test } from "bun:test";
import { probePublicLogin } from "../src/probe.mjs";

const ENTRY = "https://web.ib.mizuhobank.co.jp/servlet/LOGBNK0000000B.do";
const htmlResponse = (body, options = {}) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=Shift_JIS" },
    ...options,
  });
const LOGIN = `<base href="https://web1.ib.mizuhobank.co.jp/">
  <form name="LOGBNK_00000B" method="POST" action="/servlet/LOGBNK0000001B.do?secret=do-not-retain">
  <input type="hidden" name="_TOKEN" value="do-not-retain">
  <input name="txbCustNo" value="do-not-retain"><input name="private-field-do-not-retain">
  </form><script>const hidden = "50010";</script>`;

describe("public login probe", () => {
  test("reports login form metadata without values, queries, cookies or arbitrary names", async () => {
    const calls = [];
    const report = await probePublicLogin({
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return htmlResponse(LOGIN);
      },
    });
    expect(report.outcome).toBe("login-ready");
    expect(report.fieldNames).toEqual(["_TOKEN", "txbCustNo"]);
    expect(report.unrecognizedFieldCount).toBe(1);
    expect(report.base).toEqual({ origin: "https://web1.ib.mizuhobank.co.jp", path: "/" });
    expect(report.forms[0].action.path).toBe("/servlet/LOGBNK0000001B.do");
    expect(JSON.stringify(report)).not.toContain("do-not-retain");
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENTRY);
    expect(calls[0].options).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
    });
    expect(calls[0].options.headers).toBeUndefined();
    expect(calls[0].options.body).toBeUndefined();
  });

  test.each([
    ["<p>50010</p>", 200, "maintenance-50010"],
    ["<p>50020</p>", 200, "unsupported-environment-50020"],
    ["<p>Access Denied</p>", 403, "challenge"],
    ["<p>CAPTCHA</p>", 200, "challenge"],
    [LOGIN, 503, "unknown"],
    ["<p>unknown page</p>", 200, "unknown"],
    ["<!-- 50010 --> <p>unknown page</p>", 200, "unknown"],
  ])("classifies only observed response: %s", async (body, status, outcome) => {
    const report = await probePublicLogin({
      fetchImpl: async () => htmlResponse(body, { status }),
    });
    expect(report.outcome).toBe(outcome);
    expect(report.httpStatus).toBe(status);
  });

  test("follows only the initial path on a bank webN origin without forwarding cookies", async () => {
    const requests = [];
    const report = await probePublicLogin({
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return requests.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: ENTRY.replace("web.", "web2."), "set-cookie": "secret=value" },
            })
          : htmlResponse(LOGIN);
      },
    });
    expect(report.outcome).toBe("login-ready");
    expect(report.redirects).toBe(1);
    expect(requests[1].url).toBe(ENTRY.replace("web.", "web2."));
    expect(requests[1].options.headers).toBeUndefined();
  });

  test.each([
    "https://example.com/servlet/LOGBNK0000000B.do",
    "https://web.ib.mizuhobank.co.jp.example.com/servlet/LOGBNK0000000B.do",
    "https://web-other.ib.mizuhobank.co.jp/servlet/LOGBNK0000000B.do",
    "https://directinfo.ib.mizuhobank.co.jp/servlet/LOGBNK0000000B.do",
    ENTRY.replace("https:", "http:"),
    ENTRY.replace("web.", "secret@web."),
    ENTRY.replace(".jp/", ".jp:444/"),
    ENTRY.replace("0000000B", "0000001B"),
    `${ENTRY}?token=secret`,
    `${ENTRY}#secret`,
    "/account/transfer",
  ])("rejects out-of-scope redirect %s", async (location) => {
    let requests = 0;
    const report = await probePublicLogin({
      fetchImpl: async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location } });
      },
    });
    expect(requests).toBe(1);
    expect(report.outcome).toBe("redirect-rejected");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  test("caps redirects and does not retry", async () => {
    let requests = 0;
    const report = await probePublicLogin({
      maxRedirects: 1,
      fetchImpl: async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location: ENTRY } });
      },
    });
    expect(requests).toBe(2);
    expect(report.outcome).toBe("redirect-limit");
  });

  test("rejects a declared oversized body without reading it", async () => {
    const report = await probePublicLogin({
      maxBytes: 10,
      fetchImpl: async () =>
        new Response("x", {
          headers: { "content-length": "11", "content-type": "text/html" },
        }),
    });
    expect(report.outcome).toBe("body-too-large");
    expect(report.bodyBytes).toBe(0);
  });

  test("bounds streamed bytes even without content-length", async () => {
    const report = await probePublicLogin({
      maxBytes: 10,
      fetchImpl: async () => htmlResponse("x".repeat(11)),
    });
    expect(report.outcome).toBe("body-too-large");
  });

  test("times out a fetch even if the injected fetch ignores AbortSignal", async () => {
    const report = await probePublicLogin({ timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
    expect(report.outcome).toBe("timeout");
    expect(report.requests).toBe(1);
  });

  test("times out an unfinished streamed body", async () => {
    const report = await probePublicLogin({
      timeoutMs: 5,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([65]));
            },
          }),
          { headers: { "content-type": "text/html" } },
        ),
    });
    expect(report.outcome).toBe("timeout");
    expect(report.bodyBytes).toBe(1);
  });

  test("does not copy network exception text", async () => {
    const report = await probePublicLogin({
      fetchImpl: async () => {
        throw new Error("secret cookie");
      },
    });
    expect(report.outcome).toBe("network-error");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  test("non-HTML is not interpreted as a login form and content type is sanitized", async () => {
    const report = await probePublicLogin({
      fetchImpl: async () =>
        new Response(LOGIN, {
          headers: { "content-type": "secret/value; token=private" },
        }),
    });
    expect(report.outcome).toBe("unknown");
    expect(report.contentType).toBe("unknown");
    expect(report.forms).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  test("rejects limits above hard caps before any request", async () => {
    await expect(probePublicLogin({ timeoutMs: 30_001 })).rejects.toThrow("Invalid probe limits");
    await expect(probePublicLogin({ maxBytes: 1024 * 1024 + 1 })).rejects.toThrow(
      "Invalid probe limits",
    );
    await expect(probePublicLogin({ maxRedirects: 6 })).rejects.toThrow("Invalid probe limits");
  });
});
