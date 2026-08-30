import { describe, expect, test } from "bun:test";
import { allowedUrl, assertAllowedRequest, DEFERRED_READ_ROUTES } from "../src/policy";

describe("MyJCB read-only allowlist", () => {
  test("permits the observed debit sequence range", () => {
    expect(
      allowedUrl("debit-detail", new URLSearchParams({ seq: "14" })).pathname,
    ).toBe("/iss-pc/member/debit/details/debitDetail.html");
  });

  test("rejects unknown query fields and methods", () => {
    expect(() => allowedUrl("debit-detail", new URLSearchParams({ seq: "15" }))).toThrow();
    expect(() =>
      assertAllowedRequest("debit-detail", "POST", "https://my.jcb.co.jp/iss-pc/member/debit/details/debitDetail.html?seq=0")
    ).toThrow();
    expect(() =>
      assertAllowedRequest("mypage", "GET", "https://evil.example/iss-pc/member/mypage/mypage.html")
    ).toThrow();
  });

  test("keeps unverified credit and card-switch routes disabled", () => {
    expect(DEFERRED_READ_ROUTES.every((route) => route.enabled === false)).toBeTrue();
  });
});
