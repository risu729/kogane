import { describe, expect, test } from "bun:test";
import { parseCredential } from "../src/credential";

describe("SBI Shinsei credential secret", () => {
  test("accepts the isolated three-field secret", () => {
    expect(parseCredential(JSON.stringify({
      branchNumber: "400",
      accountNumber: "1234567",
      powerDirectPassword: "synthetic-password",
    }))).toEqual({
      branchNumber: "400",
      accountNumber: "1234567",
      powerDirectPassword: "synthetic-password",
    });
  });

  test("rejects extra fields and OTP-like additions", () => {
    expect(() => parseCredential(JSON.stringify({
      branchNumber: "400",
      accountNumber: "1234567",
      powerDirectPassword: "synthetic-password",
      otp: "000000",
    }))).toThrow("invalid shape");
  });
});
