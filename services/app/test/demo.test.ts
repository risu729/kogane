import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import snapshot from "../demo-snapshot.json";
import worker from "../src/demo-worker";
import { LOCAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
const assets = vi.fn(async () => new Response("synthetic demo shell"));
const rawPath = Object.keys(snapshot.responses).find((path) => path.startsWith("/api/raw/"))!;

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "demo-fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://demo-test-${++sequence}.cloudflareaccess.com`;
  assets.mockClear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(path: string, options: { authenticated?: boolean; method?: string } = {}) {
  const jwt =
    options.authenticated === false
      ? null
      : await new SignJWT({ type: "app" })
          .setProtectedHeader({ alg: "RS256", kid: "demo-fixture" })
          .setIssuer(issuer)
          .setAudience("demo-audience")
          .setSubject("synthetic-user")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey);
  return worker.fetch(
    new Request(`https://demo.test${path}`, {
      method: options.method ?? "GET",
      headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
    }),
    {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "demo-audience",
      ASSETS: { fetch: assets } as unknown as Env["ASSETS"],
    },
  );
}

describe("hosted synthetic demo", () => {
  it("authenticates assets, navigation, API and raw before serving any bytes", async () => {
    expect(rawPath).toBeTruthy();
    for (const path of ["/", "/transactions", "/assets/app.js", "/api/meta", rawPath]) {
      const response = await call(path, { authenticated: false });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "authentication_required" });
    }
    expect(assets).not.toHaveBeenCalled();
  });

  it("serves synthetic metadata and the SPA with no database bindings", async () => {
    const response = await call("/api/meta");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(validApiResponse("/api/meta", body)).toBe(true);
    expect(body).toEqual({
      apiVersion: 1,
      source: { kind: "local-store", classification: "synthetic" },
      capabilities: LOCAL_STORE_CAPABILITIES,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const shell = await call("/balances");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toBe("synthetic demo shell");
    expect(assets).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown endpoints, queries and mutations without SPA fallback", async () => {
    for (const path of ["/api", "/api/missing", "/api/__proto__", "/api/raw/missing"]) {
      expect((await call(path)).status).toBe(404);
    }
    expect((await call("/api/meta?source=real")).status).toBe(400);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await call("/api/meta", { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
    expect(assets).not.toHaveBeenCalled();
    const head = await call("/api/meta", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("serves synthetic raw files only as protected attachments and omits HEAD bytes", async () => {
    const response = await call(rawPath);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(rawPath.split("/").at(-1));
    expect(response.headers.get("content-disposition")).toMatch(/filename="[a-f0-9]{64}\.json"/);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const item = (snapshot.responses as Record<string, { bodyBase64: string }>)[rawPath]!;
    const expected = Uint8Array.from(atob(item.bodyBase64), (character) => character.charCodeAt(0));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
    const head = await call(rawPath, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-disposition")).toBe(
      response.headers.get("content-disposition"),
    );
    expect(await head.text()).toBe("");
  });
});
