import { describe, expect, test } from "bun:test";
import { CookieJar } from "../src/cookie-jar";

describe("CookieJar", () => {
  test("scopes imported browser cookies to MyJCB", () => {
    const jar = new CookieJar();
    jar.importBrowserCookies(
      [
        {
          name: "synthetic_session",
          value: "not-a-real-secret",
          domain: "my.jcb.co.jp",
          path: "/iss-pc",
          secure: true,
        },
      ],
      new URL("https://my.jcb.co.jp/Login"),
    );
    expect(jar.header(new URL("https://my.jcb.co.jp/iss-pc/member/mypage/mypage.html"))).toBe(
      "synthetic_session=not-a-real-secret",
    );
    expect(jar.header(new URL("https://www.jcb.co.jp/iss-pc"))).toBe("");
  });

  test("gives Max-Age deletion precedence over a future Expires", () => {
    const jar = new CookieJar();
    const url = new URL("https://my.jcb.co.jp/iss-pc/member/mypage/mypage.html");
    jar.importBrowserCookies(
      [
        {
          name: "synthetic_session",
          value: "active",
          domain: "my.jcb.co.jp",
          path: "/",
          secure: true,
        },
      ],
      url,
    );
    jar.updateFromResponse(
      new Response(null, {
        headers: {
          "Set-Cookie":
            "synthetic_session=deleted; Max-Age=0; Expires=Wed, 01 Jan 2099 00:00:00 GMT; Path=/; Secure",
        },
      }),
      url,
    );
    expect(jar.header(url)).toBe("");
  });
});
