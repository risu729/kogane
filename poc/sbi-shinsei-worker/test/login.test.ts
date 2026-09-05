import { describe, expect, test } from "bun:test";
import { AuthenticationBoundaryError, LoginResponseError } from "../src/errors";
import { SbiShinseiLoginTransport } from "../src/login";
import type { JscMaterial, SbiShinseiCredential } from "../src/types";

const credential: SbiShinseiCredential = {
  branchNumber: "012",
  accountNumber: "0345678",
  powerDirectPassword: "synthetic-password",
};
const material: JscMaterial = {
  sourceOrigin: "https://bk.web.sbishinseibank.co.jp",
  userAgent: "Synthetic Chrome User Agent for unit testing only",
  jsc: `synthetic-${"j".repeat(80)}`,
};

describe("SBI Shinsei login transport", () => {
  test("submits the captured form once and returns split session state", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport = new SbiShinseiLoginTransport({
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(
          JSON.stringify({
            responseJSON: {
              authStatus: "success",
              token: "synthetic-csrf",
            },
          }),
          {
            status: 200,
            headers: {
              authorization: "synthetic-authorization",
              "content-type": "application/octet-stream",
            },
          },
        );
      },
    });

    await expect(transport.login(credential, material)).resolves.toEqual({
      authorization: "synthetic-authorization",
      csrfToken: "synthetic-csrf",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://bk.web.sbishinseibank.co.jp/SFC/app/ShinseiAuthenticatorRealm/login_auth_request_url",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("manual");
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect([...body.keys()]).toEqual([
      "fldUserID",
      "password",
      "langCode",
      "mode",
      "postubFlag",
      "jsc",
      "forward",
      "userAgentInfo",
    ]);
    expect(body.get("fldUserID")).toBe("0120345678");
    expect(body.get("password")).toBe("synthetic-password");
    expect(body.get("langCode")).toBe("JAP");
    expect(body.get("mode")).toBe("1");
    expect(body.get("postubFlag")).toBe("0");
  });

  test("stops after one rejected authentication response", async () => {
    let calls = 0;
    const transport = new SbiShinseiLoginTransport({
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            responseJSON: { authStatus: "rejected", token: "" },
          }),
          {
            status: 200,
            headers: {
              authorization: "synthetic-authorization",
              "content-type": "application/octet-stream",
            },
          },
        );
      },
    });
    await expect(transport.login(credential, material)).rejects.toBeInstanceOf(
      AuthenticationBoundaryError,
    );
    expect(calls).toBe(1);
  });

  test("rejects an unknown success response before returning session state", async () => {
    const transport = new SbiShinseiLoginTransport({
      fetch: async () =>
        new Response(
          JSON.stringify({
            responseJSON: {
              authStatus: "success",
              token: "synthetic-csrf",
              unknown: true,
            },
          }),
          {
            headers: {
              authorization: "synthetic-authorization",
              "content-type": "application/octet-stream",
            },
          },
        ),
    });
    await expect(transport.login(credential, material)).rejects.toBeInstanceOf(LoginResponseError);
  });
});
