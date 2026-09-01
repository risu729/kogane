import { describe, expect, test } from "bun:test";
import { CookieJar } from "../src/smbc";

describe("CookieJar", () => {
  test("preserves the prior SMBC Direct client cross-host cookie behavior", () => {
    const jar = new CookieJar();
    jar.apply(
      new URL("https://direct.smbc.co.jp/aib/login"),
      new Response("", { headers: { "set-cookie": "JSESSIONID=login; Path=/aib; Secure" } }),
    );
    jar.apply(
      new URL("https://direct3.smbc.co.jp/ib/login"),
      new Response("", { headers: { "set-cookie": "JSESSIONID=direct; Path=/ib; Secure" } }),
    );
    expect(jar.header(new URL("https://direct.smbc.co.jp/aib/next"))).toBe("JSESSIONID=direct");
    expect(jar.header(new URL("https://direct3.smbc.co.jp/ib/next"))).toBe("JSESSIONID=direct");
    expect(jar.get("JSESSIONID", new URL("https://direct3.smbc.co.jp/ib/next"))).toBe("direct");
  });

  test("does not relax cookie scope outside the two fixed SMBC Direct hosts", () => {
    const jar = new CookieJar();
    jar.apply(
      new URL("https://direct.smbc.co.jp/aib/login"),
      new Response("", { headers: { "set-cookie": "co01=value; Path=/; Secure" } }),
    );
    expect(jar.header(new URL("https://direct3.smbc.co.jp/ib/next"))).toBe("co01=value");
    expect(jar.header(new URL("https://www.smbc.co.jp/"))).toBe("");
  });
});
