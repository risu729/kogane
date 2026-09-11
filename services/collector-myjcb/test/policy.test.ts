import { describe, expect, test } from "bun:test";
import { allowedUrl, assertAllowedRequest, DEFERRED_READ_ROUTES } from "../src/policy";

describe("MyJCB read-only allowlist", () => {
  test("permits the observed debit sequence range", () => {
    expect(allowedUrl("debit-detail", new URLSearchParams({ seq: "14" })).pathname).toBe(
      "/iss-pc/member/debit/details/debitDetail.html",
    );
  });

  test("rejects unknown query fields and methods", () => {
    expect(() => allowedUrl("debit-detail", new URLSearchParams({ seq: "15" }))).toThrow();
    expect(() =>
      assertAllowedRequest(
        "debit-detail",
        "POST",
        "https://my.jcb.co.jp/iss-pc/member/debit/details/debitDetail.html?seq=0",
      ),
    ).toThrow();
    expect(() =>
      assertAllowedRequest(
        "mypage",
        "GET",
        "https://evil.example/iss-pc/member/mypage/mypage.html",
      ),
    ).toThrow();
  });

  test("permits only the observed credit read/export contracts", () => {
    expect(
      allowedUrl("credit-detail", new URLSearchParams({ detailMonth: "17", output: "web" }))
        .pathname,
    ).toBe("/iss-pc/member/details_inquiry/detail.html");
    expect(
      allowedUrl("credit-pdf", new URLSearchParams({ detailMonth: "10", output: "pdf" })).pathname,
    ).toBe("/iss-pc/member/details_inquiry/detailDbPdf.html");
    expect(() =>
      allowedUrl("credit-detail", new URLSearchParams({ detailMonth: "18", output: "web" })),
    ).toThrow();
  });

  test("keeps only the unobserved root-card switch disabled", () => {
    expect(DEFERRED_READ_ROUTES.every((route) => route.enabled === false)).toBeTrue();
    expect(DEFERRED_READ_ROUTES.map((route) => route.capability)).toEqual(["root-card-switch"]);
  });
});
