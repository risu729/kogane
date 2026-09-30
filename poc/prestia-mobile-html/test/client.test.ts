import { describe, expect, test } from "bun:test";
import { PrestiaMobileClient } from "../src/client";

type Call = { url: string; init: RequestInit };

function sequence(responses: Response[]): { calls: Call[]; fetcher: typeof fetch } {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: input.toString(), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected extra request");
    return response;
  }) as typeof fetch;
  return { calls, fetcher };
}

function bootstrapHtml(): string {
  return `<form name="POSNIN1">
    <input type="hidden" name="_FRAMEID" value="root">
    <input type="hidden" name="_TARGETID" value="stale">
    <input type="hidden" name="same" value="one">
    <input type="hidden" name="same" value="two">
    <input name="userId"><input name="password">
    <input name="dispuserId"><input name="disppassword">
  </form>`;
}

function homeHtml(): string {
  return `<form name="POMHTOP">
    <input type="hidden" name="_FRAMEID" value="root">
    <input type="hidden" name="same" value="one">
    <input type="hidden" name="same" value="two">
  </form>`;
}

describe("PRESTIA transport safety", () => {
  test("follows only same-host bootstrap GET redirects and carries per-hop cookies", async () => {
    const { calls, fetcher } = sequence([
      new Response("", {
        status: 302,
        headers: {
          location: "/ib/portal/bootstrap2.prst",
          "set-cookie": "sid=one; Path=/; Domain=mlogin.smbctb.co.jp; Secure",
        },
      }),
      new Response(bootstrapHtml(), { status: 200 }),
    ]);
    const client = new PrestiaMobileClient(fetcher);
    const result = await client.bootstrap();
    expect(result.status).toBe(200);
    expect(result.redirected).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.init.method === "GET")).toBe(true);
    expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
    expect(new Headers(calls[1]?.init.headers).get("cookie")).toContain("sid=one");
  });

  test("refuses a cross-host bootstrap redirect", async () => {
    const { calls, fetcher } = sequence([
      new Response("", { status: 302, headers: { location: "https://example.invalid/" } }),
    ]);
    const client = new PrestiaMobileClient(fetcher);
    await expect(client.bootstrap()).rejects.toThrow("Cross-host bootstrap redirect refused");
    expect(calls).toHaveLength(1);
  });

  test("refuses an HTTPS-to-HTTP bootstrap redirect", async () => {
    const { calls, fetcher } = sequence([
      new Response("", {
        status: 302,
        headers: { location: "http://mlogin.smbctb.co.jp/ib/portal/bootstrap2.prst" },
      }),
    ]);
    const client = new PrestiaMobileClient(fetcher);
    await expect(client.bootstrap()).rejects.toThrow("Insecure bootstrap redirect refused");
    expect(calls).toHaveLength(1);
  });

  test("does not send credentials when the bootstrap frame identifier is absent", async () => {
    const { calls, fetcher } = sequence([
      new Response('<form name="POSNIN1"><input name="userId"></form>', { status: 200 }),
    ]);
    const client = new PrestiaMobileClient(fetcher);
    const bootstrap = await client.bootstrap();
    await expect(
      client.login(bootstrap, { userId: "example-id", password: "example-secret" }),
    ).rejects.toThrow("Bootstrap POSNIN1 form has no non-empty _FRAMEID");
    expect(calls).toHaveLength(1);
  });

  test("never follows a credential redirect and reproduces submitProc fields", async () => {
    const { calls, fetcher } = sequence([
      new Response(bootstrapHtml(), { status: 200 }),
      new Response("", {
        status: 307,
        headers: { location: "https://example.invalid/do-not-follow" },
      }),
    ]);
    const client = new PrestiaMobileClient(fetcher);
    const bootstrap = await client.bootstrap();
    const login = await client.login(bootstrap, { userId: "example-id", password: "example-secret" });
    expect(login.status).toBe(307);
    expect(login.redirectLocationPresent).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.redirect).toBe("manual");
    const body = new URLSearchParams(calls[1]?.init.body?.toString());
    expect(body.get("_TARGETID")).toBe("root");
    expect(body.getAll("same")).toEqual(["one", "two"]);
    expect(body.get("userId")).toBe("example-id");
    expect(body.get("password")).toBe("example-secret");
    expect(body.get("dispuserId")).toBe("example-id");
    expect(body.get("disppassword")).toBe("example-secret");
  });

  test("uses login then home then balance and signs off after a read error", async () => {
    const { calls, fetcher } = sequence([
      new Response(bootstrapHtml(), { status: 200 }),
      new Response("<html>accepted</html>", { status: 200 }),
      new Response(homeHtml(), { status: 200 }),
      new Response("<html>balance</html>", { status: 200 }),
      new Response("<html>signed off</html>", { status: 200 }),
    ]);
    const client = new PrestiaMobileClient(fetcher);
    const bootstrap = await client.bootstrap();
    const login = await client.login(bootstrap, { userId: "example-id", password: "example-secret" });
    const home = await client.home(login);
    await expect(
      client.withBestEffortSignoff(home, async () => {
        const balance = await client.balance(home);
        expect(balance.status).toBe(200);
        throw new Error("simulated read failure");
      }),
    ).rejects.toThrow("simulated read failure");
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/ib/portal/POSNIN1prestiatop.prst",
      "/ib/portal/POSNIN1next.prst",
      "/ib/portal/POSNIN1prestiatop.prst",
      "/ib/top/TOMETOPaccountinfokozazandaka.prst",
      "/ib/top/TOMETOPportalsignoff.prst",
    ]);
    const balanceBody = new URLSearchParams(calls[3]?.init.body?.toString());
    const signoffBody = new URLSearchParams(calls[4]?.init.body?.toString());
    expect(balanceBody.getAll("same")).toEqual(["one", "two"]);
    expect(signoffBody.getAll("same")).toEqual(["one", "two"]);
  });
});
