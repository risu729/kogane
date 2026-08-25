import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  privateEncrypt,
} from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  buildFirstLoginAuth,
  buildFirstLoginPlaintext,
  buildConfigPlaintext,
  decryptLoginToken,
  transformDeviceId,
  validateLoginTokenShape,
} from "../src/mobile-auth";

describe("Vpass mobile auth crypto", () => {
  test("builds the protected Config plaintext with milliseconds and null global ID", () => {
    const plaintext = buildConfigPlaintext({
      deviceId: "00000000-0000-0000-0000-000000000001",
      globalId: null,
      timestampMilliseconds: 1_700_000_000_123,
    });
    const fields = plaintext.split("|");
    expect(fields).toHaveLength(8);
    expect(fields.slice(0, 7)).toEqual([
      "",
      "",
      "00000000-0000-0000-0000-000000000001",
      "null",
      "OTdhYzY0NThmYTQyMmJhOGVjNTQ1ZjM1MGQyNGU3NTcyMGYzNGRmOTk0ZWIzZDZjMWFjODk5YjU3YmM3MGQzNjZlZTQxYTVlODVhNjI5OTM1ZTk1MGFkODM3ZDdmNDMy",
      "001",
      "1700000000123",
    ]);
    expect(fields[7]).toHaveLength(64);
  });

  test("reproduces the protected DEX device ID transformation", () => {
    expect(transformDeviceId("00000000-0000-0000-0000-000000000001")).toBe(
      "000000000000-0000-0000-0000000009001",
    );
  });

  test("builds the exact eight-field first-login plaintext", () => {
    const plaintext = buildFirstLoginPlaintext({
      loginId: "DUMMY_USER",
      password: "DUMMY_PASSWORD",
      deviceId: "00000000-0000-0000-0000-000000000001",
      timestamp: 1_700_000_000,
    });
    expect(plaintext.split("|")).toHaveLength(8);
    expect(plaintext).toStartWith(
      "DUMMY_USER|DUMMY_PASSWORD|000000000000-0000-0000-0000000009001|null||001|1700000000|",
    );
  });

  test("uses AES-CBC and RSA-OAEP-SHA256 for a 5.12.0 request", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const plaintext = buildFirstLoginPlaintext({
      loginId: "DUMMY_USER",
      password: "DUMMY_PASSWORD",
      deviceId: "00000000-0000-0000-0000-000000000001",
      timestamp: 1_700_000_000,
    });
    const decoded = Buffer.from(
      buildFirstLoginAuth(
        {
          loginId: "DUMMY_USER",
          password: "DUMMY_PASSWORD",
          deviceId: "00000000-0000-0000-0000-000000000001",
          timestamp: 1_700_000_000,
        },
        publicKey.export({ type: "spki", format: "pem" }),
      ),
      "base64",
    );
    const aesPart = decoded.subarray(0, -256);
    const aesKey = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      decoded.subarray(-256),
    );
    const decipher = createDecipheriv("aes-128-cbc", aesKey, aesPart.subarray(0, 16));
    expect(
      Buffer.concat([decipher.update(aesPart.subarray(16)), decipher.final()]).toString("utf8"),
    ).toBe(plaintext);
  });

  test("decrypts the response envelope with the public response key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const aesKey = Buffer.from("0123456789abcdef");
    const iv = Buffer.from("fedcba9876543210");
    const now = Math.floor(Date.now() / 1_000);
    const plaintext = `a|b|c|d|e|f|g|h|${now}|j`;
    const cipher = createCipheriv("aes-128-cbc", aesKey, iv);
    const aesPart = Buffer.concat([iv, cipher.update(plaintext, "utf8"), cipher.final()]);
    const wrappedKey = privateEncrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      aesKey,
    );
    const token = Buffer.concat([aesPart, wrappedKey]).toString("base64").replace(/=+$/, "");
    const responsePem = publicKey.export({ type: "spki", format: "pem" });
    const decrypted = decryptLoginToken(token, responsePem);
    expect(decrypted).toBe(plaintext);
    expect(validateLoginTokenShape(decrypted)).toEqual({
      fieldCount: 10,
      timestampPlausible: true,
    });
  });
});
