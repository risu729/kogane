import { describe, expect, test } from "bun:test";
import { CookieJar } from "../src/cookies";
import { extractAccountContext, extractAccountDetailPaths, recentMonths } from "../src/moneyforward";
import { parseCredentialId } from "../src/webauthn";

describe("extractAccountDetailPaths", () => {
  test("deduplicates and sorts opaque account detail paths", () => {
    const html = `
      <a href="/accounts/show/z_2?x=1">two</a>
      <a href='/accounts/show/a-1#detail'>one</a>
      <a href="/accounts/show/z_2">duplicate</a>
      <a href="https://example.com/accounts/show/no">outside</a>
    `;
    expect(extractAccountDetailPaths(html)).toEqual([
      "/accounts/show/a-1",
      "/accounts/show/z_2",
    ]);
  });
});

describe("extractAccountContext", () => {
  test("extracts the hidden identifiers and page CSRF token", () => {
    const html = `
      <meta name="csrf-token" content="csrf&amp;value">
      <input name="account[id_hash]" value="account_hash">
      <input value="42" name="service[id]">
    `;
    expect(extractAccountContext(html)).toEqual({
      accountIdHash: "account_hash",
      serviceId: "42",
      csrf: "csrf&value",
    });
  });

  test("decodes HTML entities exactly once", () => {
    const html = `
      <meta name="csrf-token" content="csrf&amp;quot;value">
      <input name="account[id_hash]" value="account_hash">
      <input value="42" name="service[id]">
    `;
    expect(extractAccountContext(html).csrf).toBe("csrf&quot;value");
  });
});

describe("recentMonths", () => {
  test("uses the Japan calendar month at the scheduled run time", () => {
    expect(recentMonths(new Date("2026-08-31T21:15:00Z"), 2)).toEqual([
      { year: 2026, month: 9, label: "2026-09" },
      { year: 2026, month: 8, label: "2026-08" },
    ]);
  });
});

describe("CookieJar", () => {
  test("keeps same-name cookies isolated by host and path", () => {
    const jar = new CookieJar();
    jar.absorb(
      new URL("https://id.moneyforward.com/sign_in"),
      new Response("", { headers: { "set-cookie": "session=id; Path=/; Secure" } }),
    );
    jar.absorb(
      new URL("https://moneyforward.com/auth/mfid"),
      new Response("", { headers: { "set-cookie": "session=me; Path=/; Secure" } }),
    );
    expect(jar.header(new URL("https://id.moneyforward.com/me"))).toBe("session=id");
    expect(jar.header(new URL("https://moneyforward.com/accounts"))).toBe("session=me");
  });
});

describe("parseCredentialId", () => {
  test("converts Bitwarden UUID credential IDs to the raw 16 bytes", () => {
    expect(Buffer.from(parseCredentialId("00112233-4455-6677-8899-aabbccddeeff")).toString("hex"))
      .toBe("00112233445566778899aabbccddeeff");
  });
});
