import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { seedRegistry } from "./fixtures";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
const PATH = "/api/identity/instrument-history";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;
beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO instruments VALUES ('history-instrument','security','Synthetic listing','provider-local')",
    ),
    env.DB.prepare(
      "INSERT INTO instrument_identifiers VALUES ('history-identifier','synthetic-code','fixture','SYN-HISTORY','{}')",
    ),
    env.DB.prepare(
      "INSERT INTO instrument_mappings VALUES ('history-mapping','history-identifier',1,'history-instrument','rule','synthetic initial mapping',1,'2099-01-01','Synthetic listing','provider-local')",
    ),
  ]);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://instrument-history-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());
async function call(query: string, method = "GET", authenticated = true) {
  const token = authenticated
    ? await new SignJWT({ type: "app" })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience("fixture-audience")
        .setSubject("synthetic-reader")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey)
    : null;
  return worker.fetch(
    new Request(`https://fixture.test${PATH}${query}`, {
      method,
      headers: token ? { "cf-access-jwt-assertion": token } : {},
    }),
    { ...env, ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: "fixture-audience" } as Env,
  );
}
describe("authenticated instrument history route", () => {
  it("returns every entry through the service and changes no mapping", async () => {
    const before = await env.DB.prepare(
      "SELECT * FROM instrument_mappings WHERE identifier_id='history-identifier'",
    ).all();
    const response = await call("?identifierId=history-identifier");
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(validApiResponse(PATH, value)).toBe(true);
    expect(value).toMatchObject({
      schemaVersion: "kogane-instrument-history-v1",
      identifierId: "history-identifier",
      total: 1,
      entries: [{ entry: "mapping", revision: 1, instrumentId: "history-instrument" }],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await call("?identifierId=history-identifier", "HEAD")).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT * FROM instrument_mappings WHERE identifier_id='history-identifier'",
      ).all(),
    ).toEqual(before);
  });
  it("requires Access, refuses non-GET, unknown ids and malformed or repeated queries", async () => {
    expect((await call("?identifierId=history-identifier", "GET", false)).status).toBe(401);
    expect((await call("?identifierId=history-identifier", "POST")).status).toBe(405);
    expect((await call("?identifierId=unknown")).status).toBe(403);
    for (const query of [
      "",
      "?identifierId=",
      "?identifierId=bad%7Cid",
      "?identifierId=history-identifier&identifierId=unknown",
      "?identifierId=history-identifier&extra=1",
    ])
      expect((await call(query)).status).toBe(400);
  });
});
