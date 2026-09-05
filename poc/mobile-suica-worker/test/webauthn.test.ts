import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  checkStoredJreCredential,
  createJreAssertion,
  parseStoredJreCredential,
} from "../src/webauthn";

function fixture() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    schemaVersion: "jre-id-bitwarden-passkey-v1",
    syncedAt: "2026-08-31T00:00:00.000Z",
    username: "fixture-user",
    rpId: "id.jreast.co.jp",
    credentialId: "00000000-0000-4000-8000-000000000000",
    userHandle: Buffer.from("fixture-handle").toString("base64url"),
    counter: 0,
    privateKeyPkcs8Base64Url: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
  };
}

describe("JRE ID WebAuthn credential", () => {
  test("parses the source-scoped secret and creates a verifiable assertion", () => {
    const credential = parseStoredJreCredential(JSON.stringify(fixture()));
    const check = checkStoredJreCredential(credential);
    expect(check).toEqual({
      verified: true,
      credentialIdBytes: 16,
      authenticatorDataBytes: 37,
      flags: "0x1d",
      signCount: 0,
    });
  });

  test("preserves the exact JRE clientData fields", () => {
    const credential = parseStoredJreCredential(JSON.stringify(fixture()));
    const assertion = createJreAssertion(credential, Buffer.alloc(32, 7).toString("base64url"));
    expect(
      JSON.parse(Buffer.from(assertion.response.clientDataJSON, "base64url").toString()),
    ).toEqual({
      type: "webauthn.get",
      challenge: Buffer.alloc(32, 7).toString("base64url"),
      origin: "https://id.jreast.co.jp",
      crossOrigin: false,
    });
  });

  test("rejects a credential for another relying party", () => {
    const value = fixture();
    value.rpId = "example.com";
    expect(() => parseStoredJreCredential(JSON.stringify(value))).toThrow("unexpected RP ID");
  });
});
