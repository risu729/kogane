import { describe, expect, test } from "bun:test";
import { CookieJar } from "../src/cookie-jar";

describe("CookieJar", () => {
  test("scopes imported browser cookies to MyJCB", () => {
    const jar = new CookieJar();
    jar.importBrowserCookies([
      {
        name: "synthetic_session",
        value: "not-a-real-secret",
        domain: "my.jcb.co.jp",
        path: "/iss-pc",
        secure: true,
      },
    ], new URL("https://my.jcb.co.jp/Login"));
    expect(jar.header(new URL("https://my.jcb.co.jp/iss-pc/member/mypage/mypage.html")))
      .toBe("synthetic_session=not-a-real-secret");
    expect(jar.header(new URL("https://www.jcb.co.jp/iss-pc"))).toBe("");
  });
});
