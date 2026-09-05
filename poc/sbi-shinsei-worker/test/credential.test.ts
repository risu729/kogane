import { describe, expect, test } from "bun:test";
import { parseCredential } from "../src/credential";

describe("SBI Shinsei credential secret", () => {
  test("accepts the isolated three-field secret", () => {
    expect(
      parseCredential(
        JSON.stringify({
          branchNumber: "400",
          accountNumber: "1234567",
          powerDirectPassword: "synthetic-password",
        }),
      ),
    ).toEqual({
      branchNumber: "400",
      accountNumber: "1234567",
      powerDirectPassword: "synthetic-password",
    });
  });

  test("rejects extra fields and OTP-like additions", () => {
    expect(() =>
      parseCredential(
        JSON.stringify({
          branchNumber: "400",
          accountNumber: "1234567",
          powerDirectPassword: "synthetic-password",
          otp: "000000",
        }),
      ),
    ).toThrow("invalid shape");
  });

  test("requires the official three-digit branch and seven-digit account", () => {
    for (const [branchNumber, accountNumber] of [
      ["40", "1234567"],
      ["0400", "1234567"],
      ["400", "123456"],
      ["400", "12345678"],
    ]) {
      expect(() =>
        parseCredential(
          JSON.stringify({
            branchNumber,
            accountNumber,
            powerDirectPassword: "synthetic-password",
          }),
        ),
      ).toThrow("invalid fields");
    }
  });

  test("preserves leading zeroes", () => {
    expect(
      parseCredential(
        JSON.stringify({
          branchNumber: "040",
          accountNumber: "0123456",
          powerDirectPassword: "synthetic-password",
        }),
      ),
    ).toMatchObject({
      branchNumber: "040",
      accountNumber: "0123456",
    });
  });
});
