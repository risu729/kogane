import { describe, expect, test } from "bun:test";
import { decryptJson, encryptJson, parseCredentials } from "../src/crypto";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("session encryption", () => {
  test("round-trips structured state without plaintext in the envelope", async () => {
    const value = { cookie: "sensitive", nested: { count: 3 } };
    const encrypted = await encryptJson(value, encryptionKey);
    expect(JSON.stringify(encrypted)).not.toContain("sensitive");
    expect(await decryptJson<typeof value>(encrypted, encryptionKey)).toEqual(value);
  });
});

describe("parseCredentials", () => {
  test("accepts branch-account credentials", () => {
    expect(parseCredentials(JSON.stringify({ user: "123-4567890", password: "test" }))).toEqual({
      branchNo: "123",
      accountNo: "4567890",
      password: "test",
    });
  });

  test("rejects invalid account identifiers", () => {
    expect(() => parseCredentials(JSON.stringify({ user: "bad", password: "test" })))
      .toThrow("smbc_credentials_user_invalid");
  });
});
