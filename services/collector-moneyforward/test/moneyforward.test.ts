import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { CookieJar } from "../src/cookies";
import {
  collectMoneyForward,
  extractAccountContext,
  extractAccountDetailPaths,
  recentMonths,
} from "../src/moneyforward";
import type { MoneyForwardCredential } from "../src/types";
import { parseCredentialId } from "../src/webauthn";
import { runSharedCollection } from "../src/worker";

describe("extractAccountDetailPaths", () => {
  test("deduplicates and sorts opaque account detail paths", () => {
    const html = `
      <a href="/accounts/show/z_2?x=1">two</a>
      <a href='/accounts/show/a-1#detail'>one</a>
      <a href="/accounts/show/z_2">duplicate</a>
      <a href="https://example.com/accounts/show/no">outside</a>
    `;
    expect(extractAccountDetailPaths(html)).toEqual(["/accounts/show/a-1", "/accounts/show/z_2"]);
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

// One run asks every account for the same twelve months: the window is
// computed once, from the run's start instant, so a run that crosses a JST
// month boundary between two accounts does not shift the later account's
// window. The provider is a synthetic fetcher; the system clock is mocked.
describe("the month window is one per run", () => {
  afterEach(() => {
    setSystemTime();
    mock.restore();
  });
  // 2026-08-31 23:59:59 JST and, a minute later, 2026-09-01 00:00:59 JST.
  const BEFORE_BOUNDARY = new Date("2026-08-31T14:59:59Z");
  const AFTER_BOUNDARY = new Date("2026-08-31T15:00:59Z");
  const AUGUST_WINDOW = recentMonths(BEFORE_BOUNDARY, 12).map(
    (month) => `${month.year}/${month.month}/1`,
  );

  test("an account fetched after the boundary keeps the window read at the start", async () => {
    setSystemTime(BEFORE_BOUNDARY);
    const flow = await syntheticProvider({
      onAccountDetail: (index) => {
        if (index === 1) setSystemTime(AFTER_BOUNDARY);
      },
    });
    const result = await collectMoneyForward({
      credential: flow.credential,
      fetcher: flow.fetcher,
    });
    expect(result.accountDetailCount).toBe(2);
    expect(result.monthlyFragmentCount).toBe(24);
    expect(flow.monthsByAccount.get("hash-a")).toEqual(AUGUST_WINDOW);
    expect(flow.monthsByAccount.get("hash-b")).toEqual(AUGUST_WINDOW);
  });

  test("a given run start instant decides the window, not the clock at fetch time", async () => {
    setSystemTime(AFTER_BOUNDARY);
    const flow = await syntheticProvider();
    await collectMoneyForward({
      credential: flow.credential,
      fetcher: flow.fetcher,
      startedAt: BEFORE_BOUNDARY,
    });
    expect(flow.monthsByAccount.get("hash-a")).toEqual(AUGUST_WINDOW);
    expect(flow.monthsByAccount.get("hash-b")).toEqual(AUGUST_WINDOW);
  });

  test("the scheduled run asks for the window of its own startedAt", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    setSystemTime(BEFORE_BOUNDARY);
    // The clock crosses the boundary after the run started, before any account.
    const flow = await syntheticProvider({ onSignIn: () => setSystemTime(AFTER_BOUNDARY) });
    spyOn(globalThis, "fetch").mockImplementation(flow.fetcher as typeof fetch);
    const data = new FakeR2Bucket();
    const result = await runSharedCollection(
      Object.assign({} as Env, {
        MONEYFORWARD_CREDENTIAL_JSON: JSON.stringify(flow.credential),
        COLLECTOR_SCHEMA_VERSION: "test",
        DATA: data,
      }),
    );
    expect(result.status).toBe("success");
    const terminal = JSON.parse(
      new TextDecoder().decode(data.entries.get(result.terminalKey)!.bytes),
    ) as { startedAt: string };
    expect(terminal.startedAt).toBe(BEFORE_BOUNDARY.toISOString());
    expect(flow.monthsByAccount.get("hash-a")).toEqual(AUGUST_WINDOW);
    expect(flow.monthsByAccount.get("hash-b")).toEqual(AUGUST_WINDOW);
  });
});

/**
 * A synthetic Money Forward that signs in with a generated passkey and lists
 * two accounts; it records the `from` month of every monthly request by
 * account. No value here is from a provider.
 */
async function syntheticProvider(
  hooks: { onSignIn?: () => void; onAccountDetail?: (index: number) => void } = {},
) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const credential: MoneyForwardCredential = {
    rpId: "id.moneyforward.com",
    origin: "https://id.moneyforward.com",
    credentialId: "00112233-4455-6677-8899-aabbccddeeff",
    counter: 0,
    keyValue: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64url",
    ),
  };
  const accounts = ["hash-a", "hash-b"];
  const monthsByAccount = new Map<string, string[]>();
  const csrf = '<meta name="csrf-token" content="synthetic-csrf">';
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = `${url.hostname}${url.pathname}`;
    if (route === "id.moneyforward.com/sign_in") {
      hooks.onSignIn?.();
      return new Response(csrf);
    }
    if (route === "id.moneyforward.com/webauthn/assertion/options")
      return Response.json({ challenge: "synthetic-challenge" });
    if (route === "id.moneyforward.com/webauthn/assertion")
      return Response.json({ redirectPath: "/me" });
    if (route === "id.moneyforward.com/me") return new Response("<html></html>");
    if (route === "moneyforward.com/accounts")
      return new Response(
        `<a href="/sign_out">out</a>${accounts.map((hash) => `<a href="/accounts/show/${hash}">x</a>`).join("")}`,
      );
    if (url.hostname === "moneyforward.com" && url.pathname.startsWith("/accounts/show/")) {
      const hash = url.pathname.slice("/accounts/show/".length);
      hooks.onAccountDetail?.(accounts.indexOf(hash));
      return new Response(
        `${csrf}<input name="account[id_hash]" value="${hash}"><input name="service[id]" value="1">`,
      );
    }
    if (route === "moneyforward.com/cf/fetch") {
      const form = new URLSearchParams(String(init?.body));
      const hash = form.get("account_id_hash") ?? "";
      monthsByAccount.set(hash, [...(monthsByAccount.get(hash) ?? []), form.get("from") ?? ""]);
      return new Response("<table></table>");
    }
    return new Response("unexpected", { status: 404 });
  };
  return { credential, fetcher, monthsByAccount };
}

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
    expect(
      Buffer.from(parseCredentialId("00112233-4455-6677-8899-aabbccddeeff")).toString("hex"),
    ).toBe("00112233445566778899aabbccddeeff");
  });
});
