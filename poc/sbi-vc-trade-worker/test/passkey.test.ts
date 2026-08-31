import { describe, expect, test } from "bun:test";
import { createAssertion, createPasskeySession, parsePasskeyCredential } from "../src/passkey";

const encode = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
const challenge = encode(crypto.getRandomValues(new Uint8Array(32)));

async function syntheticCredential() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const keyValue = encode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  return parsePasskeyCredential({
    credentialId: "00112233-4455-6677-8899-aabbccddeeff",
    keyValue,
    rpId: "sbivc.co.jp",
    userHandle: encode(new Uint8Array([1, 2, 3, 4])),
    counter: "0",
    keyAlgorithm: "ECDSA",
    keyCurve: "P-256",
  });
}

describe("Bitwarden passkey assertion", () => {
  test("converts a Bitwarden UUID and emits the observed WebAuthn shape", async () => {
    const credential = await syntheticCredential();
    const assertion = await createAssertion(credential, challenge);
    expect(assertion.credentialId).toBe("ABEiM0RVZneImaq7zN3u_w");
    expect(Object.keys(assertion)).toEqual([
      "challenge",
      "credentialId",
      "authenticatorData",
      "clientDataJSON",
      "signature",
      "userHandle",
    ]);
    const authenticatorData = Buffer.from(assertion.authenticatorData!, "base64url");
    expect(authenticatorData).toHaveLength(37);
    expect(authenticatorData[32]).toBe(0x1d);
    expect(authenticatorData.readUInt32BE(33)).toBe(0);
    expect(Buffer.from(assertion.signature!, "base64url")[0]).toBe(0x30);
    expect(JSON.parse(Buffer.from(assertion.clientDataJSON!, "base64url").toString("utf8"))).toEqual({
      type: "webauthn.get",
      challenge,
      origin: "https://simple.sbivc.co.jp",
      crossOrigin: false,
    });
  });

  test("builds a fresh session from the two passkey calls", async () => {
    const credential = await syntheticCredential();
    const calls: Array<{ url: string; cookie: string | null }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, cookie: headers.get("cookie") });
      if (url.endsWith("/initiateLoginWithPasskey")) {
        const responseHeaders = new Headers({ "content-type": "application/json" });
        responseHeaders.append("set-cookie", "JSESSIONID=jsession; Secure; HttpOnly");
        responseHeaders.append("set-cookie", "AWSALB=alb; Secure");
        responseHeaders.append("set-cookie", "AWSALBCORS=cors; Secure");
        return new Response(JSON.stringify({
          meta: { status: "OK" },
          body: { challenge, rpId: "sbivc.co.jp", userVerification: "required" },
        }), { status: 200, headers: responseHeaders });
      }
      expect(headers.get("cookie")).toContain("JSESSIONID=jsession");
      const responseHeaders = new Headers({ "content-type": "application/json" });
      responseHeaders.append("set-cookie", "vct_bff_sid=sid; Secure; HttpOnly");
      for (let index = 0; index < 4; index += 1) {
        responseHeaders.append("set-cookie", `AWSALBAPP-${index}=app${index}; Secure`);
      }
      return new Response(JSON.stringify({
        meta: { status: "OK" },
        body: { accountId: "secure", isAgreed: true },
      }), { status: 200, headers: responseHeaders });
    }) as typeof fetch;

    const session = await createPasskeySession(credential, fetcher);
    expect(session.secureKey).toBe("secure");
    expect(session.cookies.awsAlbApp).toEqual(["app0", "app1", "app2", "app3"]);
    expect(calls).toHaveLength(2);
  });

  test("rejects non-zero counters instead of risking vault divergence", async () => {
    const credential = await syntheticCredential();
    expect(() => parsePasskeyCredential({ ...credential, counter: 1 })).toThrow(
      "nonzero_passkey_counter_not_supported",
    );
  });

  test("does not misclassify a malformed credential as a counter divergence", () => {
    expect(() => parsePasskeyCredential({})).toThrow("invalid_passkey_credential");
  });
});
