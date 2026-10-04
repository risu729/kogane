import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import worker from "../src/worker";
const PATH = "/api/ops/v1/schedules",
  SHA = "a".repeat(40),
  OPERATOR = "schedule-operator",
  AGENT = "schedule-agent",
  TOKEN = "deploy.access";
let keys: Awaited<ReturnType<typeof generateKeyPair>>,
  jwks: { keys: unknown[] },
  issuer: string,
  sequence = 0;
beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://schedules-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("unexpected_external_request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());
async function call(
  options: {
    suffix?: string;
    method?: string;
    subject?: string;
    serviceToken?: string;
    body?: string;
    origin?: string;
    marker?: string;
    anonymous?: boolean;
    processorSha?: string;
    flag?: string;
    tokenList?: string;
    throwPipeline?: boolean;
  } = {},
) {
  const seen: { path: string; actor: string | null; body: string }[] = [];
  const headers: Record<string, string> = {};
  if (!options.anonymous)
    headers["cf-access-jwt-assertion"] = await new SignJWT({
      type: "app",
      ...(options.serviceToken ? { common_name: options.serviceToken } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience("test")
      .setSubject(options.serviceToken ? "" : (options.subject ?? OPERATOR))
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    headers["origin"] = options.origin ?? "https://fixture.test";
    headers["x-kogane-settings"] = options.marker ?? "1";
  }
  const response = await worker.fetch(
    new Request(`https://fixture.test${PATH}${options.suffix ?? ""}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
    {
      ...env,
      SCHEDULES_ENABLED: options.flag ?? "true",
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "test",
      OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]),
      AGENT_GRANTS: JSON.stringify([AGENT]),
      DEPLOYMENT_SCHEDULE_TOKENS: options.tokenList ?? JSON.stringify([TOKEN]),
      RELEASE_SHA: SHA,
      PIPELINE: {
        fetch: async (request: Request) => {
          if (options.throwPipeline) throw new Error("synthetic");
          const path = new URL(request.url).pathname;
          if (path === "/internal/health")
            return Response.json({ releaseSha: options.processorSha ?? SHA });
          seen.push({
            path,
            actor: request.headers.get("x-kogane-operator"),
            body: await request.text(),
          });
          return Response.json(
            path.endsWith("/bootstrap") ? { status: "armed", reservations: [] } : { saved: true },
          );
        },
      },
    } as unknown as Env,
  );
  return { response, seen };
}
it("only an authenticated operator can read or edit schedules", async () => {
  expect((await call({ anonymous: true })).response.status).toBe(401);
  expect((await call({ subject: AGENT })).response.status).toBe(403);
  expect((await call({ subject: "ungranted" })).response.status).toBe(403);
  expect((await call({ serviceToken: TOKEN })).response.status).toBe(401);
  const read = await call();
  expect(read.response.status).toBe(200);
  expect(read.seen).toEqual([{ path: "/internal/schedules", actor: null, body: "" }]);
  const saved = await call({ suffix: "/sony-bank", method: "POST", body: '{"revision":1}' });
  expect(saved.response.status).toBe(200);
  expect(saved.seen[0]?.actor).toBe(OPERATOR);
});
it("writes require the same origin, a custom header and bounded JSON", async () => {
  for (const options of [{ origin: "https://other.test" }, { marker: "" }]) {
    const result = await call({ suffix: "/sony-bank", method: "POST", body: "{}", ...options });
    expect(result.response.status).toBe(403);
    expect(result.seen).toEqual([]);
  }
  expect(
    (await call({ suffix: "/sony-bank", method: "POST", body: '{"bad":' })).response.status,
  ).toBe(400);
  expect(
    (
      await call({
        suffix: "/sony-bank",
        method: "POST",
        body: JSON.stringify({ large: "a".repeat(17000) }),
      })
    ).response.status,
  ).toBe(413);
  expect(
    (await call({ suffix: "/sony-bank?now=1", method: "POST", body: "{}" })).response.status,
  ).toBe(400);
  expect((await call({ suffix: "/sony-bank", method: "PUT", body: "{}" })).response.status).toBe(
    405,
  );
  expect(
    (await call({ suffix: "/leases/sony-bank", method: "POST", body: "{}" })).response.status,
  ).toBe(200);
});
it("a deployment token has only bodyless future bootstrap authority", async () => {
  const boot = await call({ suffix: "/bootstrap", method: "POST", serviceToken: TOKEN });
  expect(boot.response.status).toBe(200);
  expect(boot.seen).toEqual([{ path: "/internal/schedules/bootstrap", actor: null, body: "" }]);
  for (const options of [{ subject: OPERATOR }, { serviceToken: "another.access" }]) {
    const result = await call({ suffix: "/bootstrap", method: "POST", ...options });
    expect(result.response.status).toBe(403);
    expect(result.seen).toEqual([]);
  }
  expect(
    (await call({ suffix: "/bootstrap", method: "GET", serviceToken: TOKEN })).response.status,
  ).toBe(405);
  expect(
    (await call({ suffix: "/bootstrap", method: "POST", serviceToken: TOKEN, body: "{}" })).response
      .status,
  ).toBe(400);
  expect(
    (await call({ suffix: "/bootstrap", method: "POST", serviceToken: TOKEN, body: "" })).response
      .status,
  ).toBe(200);
  expect(
    (await call({ suffix: "/bootstrap?now=1", method: "POST", serviceToken: TOKEN })).response
      .status,
  ).toBe(400);
  expect(
    (
      await call({
        suffix: "/bootstrap",
        method: "POST",
        serviceToken: TOKEN,
        processorSha: "b".repeat(40),
      })
    ).response.status,
  ).toBe(503);
  expect(
    (
      await call({
        suffix: "/bootstrap",
        method: "POST",
        serviceToken: TOKEN,
        tokenList: "malformed",
      })
    ).response.status,
  ).toBe(503);
  expect((await call({ flag: "false" })).response.status).toBe(404);
});
it("binding failures produce a closed error without dispatching a collection", async () => {
  const result = await call({ throwPipeline: true });
  expect(result.response.status).toBe(503);
  expect(await result.response.json()).toMatchObject({ error: "scheduling_unavailable" });
});
