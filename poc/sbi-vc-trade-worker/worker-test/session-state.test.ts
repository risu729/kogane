import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { createAssertion, parsePasskeyCredential } from "../src/passkey";

describe("SbiVcSessionState", () => {
  test("starts with sanitized empty health state", async () => {
    const stub = env.SESSION_STATE.getByName("health-test");
    expect(await stub.getHealth()).toEqual({
      initializedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastHttpStatus: null,
      lastGatewayStatus: null,
      lastCookieUpdateCount: 0,
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastReauthAttemptAt: null,
      lastReauthSuccessAt: null,
      lastReauthErrorCode: null,
    });
  });

  test("creates a DER WebAuthn assertion in the Workers runtime", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const credential = parsePasskeyCredential({
      credentialId: "00112233-4455-6677-8899-aabbccddeeff",
      keyValue: toBase64Url(pkcs8),
      rpId: "sbivc.co.jp",
      userHandle: "AQIDBA",
      counter: 0,
      keyAlgorithm: "ECDSA",
      keyCurve: "P-256",
    });
    const assertion = await createAssertion(credential, toBase64Url(new Uint8Array(32).fill(7)));
    const signature = fromBase64Url(assertion.signature!);
    expect(signature[0]).toBe(0x30);
    expect(fromBase64Url(assertion.authenticatorData!)).toHaveLength(37);
  });
});

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
