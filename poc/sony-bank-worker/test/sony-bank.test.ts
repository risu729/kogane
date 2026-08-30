import { describe, expect, test } from "bun:test";
import {
  CookieBag,
  parseCredential,
  splitSetCookie,
} from "../src/sony-bank";

describe("Sony Bank credential", () => {
  test("accepts only the captured field shape", () => {
    expect(
      parseCredential(
        JSON.stringify({ branchNum: "001", accountNum: "1234567", loginPwd: "secret" }),
      ),
    ).toEqual({ branchNum: "001", accountNum: "1234567", loginPwd: "secret" });
    expect(() => parseCredential("{}")).toThrow();
  });
});
describe("Sony Bank cookie handling", () => {
  test("does not split the comma inside Expires", () => {
    expect(
      splitSetCookie(
        "FSID=a; Expires=Mon, 31 Aug 2026 00:00:00 GMT; Path=/, ct1=b; Path=/",
      ),
    ).toHaveLength(2);
  });

  test("keeps cookie names without exposing values", () => {
    const headers = new Headers({
      "set-cookie": "FSID=a; Path=/, ct1=b; Path=/",
    });
    const jar = new CookieBag();
    jar.absorb(headers);
    expect(jar.names()).toEqual(["FSID", "ct1"]);
    expect(jar.header()).toContain("FSID=a");
  });
});
