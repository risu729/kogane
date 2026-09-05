import { expect, spyOn, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import type { MoneyForwardCredential } from "../src/types";
import { createAssertion } from "../src/webauthn";

async function syntheticCredential() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const credential: MoneyForwardCredential = {
    rpId: "id.moneyforward.com",
    origin: "https://id.moneyforward.com",
    credentialId: "00112233-4455-6677-8899-aabbccddeeff",
    counter: 0,
    keyValue: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64url",
    ),
  };
  return { credential, publicKey: pair.publicKey };
}

test("a raw P-256 signature beginning with 0x30 is still encoded as DER", async () => {
  const { credential } = await syntheticCredential();
  const raw = new Uint8Array(64).fill(1);
  raw[0] = 0x30;
  const sign = spyOn(crypto.subtle, "sign").mockResolvedValue(raw.buffer);
  try {
    const assertion = await createAssertion(credential, { challenge: "synthetic-challenge" });
    const response = assertion["response"] as { signature: string };
    const actual = Buffer.from(response.signature, "base64url");
    const expected = Buffer.from([
      0x30,
      68,
      0x02,
      32,
      ...raw.slice(0, 32),
      0x02,
      32,
      ...raw.slice(32),
    ]);
    expect(actual).toEqual(expected);
    expect(actual.length).toBe(70);
  } finally {
    sign.mockRestore();
  }
});

test("the returned DER assertion verifies against the generated public key and exact WebAuthn signed bytes", async () => {
  const { credential, publicKey } = await syntheticCredential();
  const assertion = await createAssertion(credential, { challenge: "synthetic-challenge" });
  const response = assertion["response"] as {
    signature: string;
    authenticatorData: string;
    clientDataJSON: string;
  };
  const clientData = Buffer.from(response.clientDataJSON, "base64url");
  const signed = Buffer.concat([
    Buffer.from(response.authenticatorData, "base64url"),
    Buffer.from(await crypto.subtle.digest("SHA-256", clientData)),
  ]);
  const key = createPublicKey({
    key: Buffer.from(await crypto.subtle.exportKey("spki", publicKey)),
    format: "der",
    type: "spki",
  });
  expect(verify("sha256", signed, key, Buffer.from(response.signature, "base64url"))).toBe(true);
  expect(JSON.parse(clientData.toString())).toEqual({
    type: "webauthn.get",
    challenge: "synthetic-challenge",
    origin: credential.origin,
    crossOrigin: false,
  });
});
