import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { constants, createHash, generateKeyPairSync, publicEncrypt, verify } from "node:crypto";
import {
  base64Url,
  base64UrlBuffer,
  createBitwardenAssertion,
  decryptPasskeyToken,
  parseBitwardenCredentialId,
} from "../src/crypto";

describe("Bitwarden passkey conversion", () => {
  test("accepts both Bitwarden credential ID encodings", () => {
    expect(parseBitwardenCredentialId("00112233-4455-6677-8899-aabbccddeeff")).toEqual(
      Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    );
    expect(parseBitwardenCredentialId("b64.AAECA_8")).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });

  test("creates a verifiable WebAuthn assertion", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const keyValue = base64Url(privateKey.export({ format: "der", type: "pkcs8" }));
    const assertion = createBitwardenAssertion(
      {
        rpId: "example.com",
        origin: "https://login.example.com",
        credentialId: "b64.AAECA_8",
        keyValue,
        counter: 3,
      },
      {
        challenge: base64Url("server challenge"),
        rpId: "example.com",
      },
    );

    const clientData = base64UrlBuffer(assertion.clientDataJSON);
    expect(JSON.parse(clientData.toString("utf8"))).toEqual({
      type: "webauthn.get",
      challenge: base64Url("server challenge"),
      origin: "https://login.example.com",
    });
    const authenticatorData = base64UrlBuffer(assertion.authenticatorData);
    expect(authenticatorData.subarray(0, 32)).toEqual(
      createHash("sha256").update("example.com").digest(),
    );
    expect(authenticatorData[32]).toBe(0x1d);
    expect(authenticatorData.readUInt32BE(33)).toBe(4);
    const signed = Buffer.concat([
      authenticatorData,
      createHash("sha256").update(clientData).digest(),
    ]);
    expect(verify("sha256", signed, publicKey, base64UrlBuffer(assertion.signature))).toBe(true);
  });
});

test("decrypts SBI mixed OAEP (SHA-256 label, MGF1-SHA1)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const message = Buffer.from("worker-passkey-token");
  const encoded = mixedOaepEncode(message, 256);
  const encrypted = publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, encoded);
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  expect(decryptPasskeyToken(base64Url(encrypted), privateKeyPem)).toBe(message.toString());
});

function mixedOaepEncode(message: Buffer, modulusBytes: number): Buffer {
  const labelHash = createHash("sha256").update(Buffer.alloc(0)).digest();
  const seed = Buffer.alloc(labelHash.length, 0x42);
  const padding = Buffer.alloc(modulusBytes - message.length - 2 * labelHash.length - 2);
  const db = Buffer.concat([labelHash, padding, Buffer.from([1]), message]);
  const maskedDb = xor(db, mgf1(seed, db.length));
  const maskedSeed = xor(seed, mgf1(maskedDb, seed.length));
  return Buffer.concat([Buffer.from([0]), maskedSeed, maskedDb]);
}

function mgf1(seed: Buffer, length: number): Buffer {
  const output = Buffer.alloc(length);
  let offset = 0;
  for (let counter = 0; offset < length; counter += 1) {
    const encodedCounter = Buffer.alloc(4);
    encodedCounter.writeUInt32BE(counter);
    const digest = createHash("sha1").update(seed).update(encodedCounter).digest();
    offset += digest.copy(output, offset);
  }
  return output;
}

function xor(left: Buffer, right: Buffer): Buffer {
  return Buffer.from(left.map((value, index) => value ^ right[index]!));
}
