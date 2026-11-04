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
    expectedSha?: string;
    bootstrapSha?: string;
    bootstrapStatus?: number;
    bootstrapText?: string;
    healthStatus?: number;
    healthText?: string;
    appSha?: string;
  } = {},
) {
  const seen: { path: string; actor: string | null; body: string }[] = [];
  const bootstrapTargets: (string | null)[] = [];
  let healthReads = 0;
  const headers: Record<string, string> = {};
  if (options.expectedSha !== undefined) headers["x-kogane-release-sha"] = options.expectedSha;
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
      RELEASE_SHA: options.appSha ?? SHA,
      PIPELINE: {
        fetch: async (request: Request) => {
          if (options.throwPipeline) throw new Error("synthetic");
          const path = new URL(request.url).pathname;
          if (path === "/internal/health") {
            healthReads++;
            return options.healthText !== undefined
              ? new Response(options.healthText, { status: options.healthStatus ?? 200 })
              : Response.json(
                  { releaseSha: options.processorSha ?? SHA },
                  { status: options.healthStatus ?? 200 },
                );
          }
          if (path.endsWith("/bootstrap"))
            bootstrapTargets.push(request.headers.get("x-kogane-release-sha"));
          seen.push({
            path,
            actor: request.headers.get("x-kogane-operator"),
            body: await request.text(),
          });
          if (path.endsWith("/bootstrap") && options.bootstrapText !== undefined)
            return new Response(options.bootstrapText, { status: options.bootstrapStatus ?? 200 });
          return Response.json(
            path.endsWith("/bootstrap")
              ? { status: "armed", reservations: [], releaseSha: options.bootstrapSha ?? SHA }
              : { saved: true },
            { status: options.bootstrapStatus ?? 200 },
          );
        },
      },
    } as unknown as Env,
  );
  return { response, seen, bootstrapTargets, healthReads };
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
it("stopped lease release retains operator, user-session and same-origin boundaries", async () => {
  const request = {
    suffix: "/leases/vpass",
    method: "POST",
    body: JSON.stringify({
      leaseRef: "12345678-1234-4234-8234-123456789abc",
      confirmedStopped: true,
    }),
  };
  for (const [options, status] of [
    [{ anonymous: true }, 401],
    [{ subject: AGENT }, 403],
    [{ serviceToken: TOKEN }, 401],
    [{ origin: "https://other.test" }, 403],
    [{ marker: "" }, 403],
  ] as const) {
    const denied = await call({ ...request, ...options });
    expect(denied.response.status).toBe(status);
    expect(denied.seen).toEqual([]);
  }
  const allowed = await call(request);
  expect(allowed.response.status).toBe(200);
  expect(allowed.seen).toEqual([
    { path: "/internal/schedules/leases/vpass", actor: OPERATOR, body: request.body },
  ]);
});

it("a survey proposal decision is an operator settings write, relayed as sent (ADR 0050)", async () => {
  const decided = await call({
    suffix: "/proposals/12",
    method: "POST",
    body: '{"decision":"accept"}',
  });
  expect(decided.response.status).toBe(200);
  expect(decided.seen).toEqual([
    { path: "/internal/schedules/proposals/12", actor: OPERATOR, body: '{"decision":"accept"}' },
  ]);
  for (const suffix of ["/proposals/0", "/proposals/x", "/proposals/12/accept", "/proposals/"]) {
    const result = await call({ suffix, method: "POST", body: "{}" });
    expect(result.response.status).toBe(404);
    expect(result.seen).toEqual([]);
  }
  for (const options of [{ subject: AGENT }, { origin: "https://other.test" }, { marker: "" }]) {
    const result = await call({ suffix: "/proposals/12", method: "POST", body: "{}", ...options });
    expect(result.response.status).toBe(403);
    expect(result.seen).toEqual([]);
  }
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

async function expectBootstrapError(response: Response, code: string) {
  const body = (await response.json()) as { error: string; requestId?: string };
  expect(body.error).toBe(code);
  if (body.requestId === undefined) expect(Object.keys(body)).toEqual(["error"]);
  else {
    expect(Object.keys(body).sort()).toEqual(["error", "requestId"]);
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  }
}
it("bootstrap proves the actual POST identities and forwards the captured target", async () => {
  const result = await call({
    suffix: "/bootstrap",
    method: "POST",
    serviceToken: TOKEN,
    expectedSha: SHA,
  });
  expect(result.response.status).toBe(200);
  expect(await result.response.json()).toEqual({
    status: "armed",
    reservations: [],
    releaseSha: SHA,
    processorReleaseSha: SHA,
  });
  expect(result.bootstrapTargets).toEqual([SHA]);
  expect(result.healthReads).toBe(1);
});
it("target mismatch is authenticated and refused before bootstrap or even health reads", async () => {
  for (const expectedSha of ["b".repeat(40)]) {
    const result = await call({
      suffix: "/bootstrap",
      method: "POST",
      serviceToken: TOKEN,
      expectedSha,
    });
    expect(result.response.status).toBe(503);
    await expectBootstrapError(result.response, "release_mismatch");
    expect(result.seen).toEqual([]);
    expect(result.healthReads).toBe(0);
  }
  for (const options of [
    { anonymous: true },
    { serviceToken: "other.access" },
    { subject: OPERATOR },
  ]) {
    const result = await call({
      suffix: "/bootstrap",
      method: "POST",
      expectedSha: "b".repeat(40),
      ...options,
    });
    expect(result.response.status).toBe(options.anonymous ? 401 : 403);
    expect(result.healthReads).toBe(0);
    expect(result.seen).toEqual([]);
  }
  const mismatch = await call({
    suffix: "/bootstrap",
    method: "POST",
    serviceToken: TOKEN,
    expectedSha: SHA,
    processorSha: "b".repeat(40),
  });
  expect(mismatch.response.status).toBe(503);
  await expectBootstrapError(mismatch.response, "release_mismatch");
  expect(mismatch.healthReads).toBe(1);
  expect(mismatch.seen).toEqual([]);
});
it("an uncertain postwrite answer cannot become a retryable release mismatch", async () => {
  for (const options of [
    { bootstrapSha: "b".repeat(40) },
    { bootstrapText: '{"status":"armed","reservations":[]}' },
    { bootstrapText: "<html>upstream failure</html>" },
    { bootstrapText: '{"error":"scheduling_unavailable"}', bootstrapStatus: 503 },
  ]) {
    const result = await call({
      suffix: "/bootstrap",
      method: "POST",
      serviceToken: TOKEN,
      expectedSha: SHA,
      ...options,
    });
    expect(result.response.status).toBe(503);
    await expectBootstrapError(result.response, "scheduling_unavailable");
    expect(result.bootstrapTargets).toEqual([SHA]);
    expect(result.seen).toHaveLength(1);
  }
});

it("unhealthy/malformed internal health and invalid targets never use retryable mismatch", async () => {
  for (const options of [
    { healthStatus: 503 },
    { healthText: "null" },
    { healthText: "<html>invalid</html>" },
    { healthText: "{}" },
    { processorSha: "main" },
    { healthText: '{"releaseSha":["' + SHA + '"]}' },
    { appSha: "main" },
    { appSha: [SHA] as unknown as string },
  ]) {
    const result = await call({
      suffix: "/bootstrap",
      method: "POST",
      serviceToken: TOKEN,
      expectedSha: SHA,
      ...options,
    });
    expect(result.response.status).toBe(503);
    await expectBootstrapError(result.response, "scheduling_unavailable");
    expect(result.seen).toEqual([]);
  }
  for (const expectedSha of ["main", ""]) {
    const result = await call({
      suffix: "/bootstrap",
      method: "POST",
      serviceToken: TOKEN,
      expectedSha,
    });
    expect(result.response.status).toBe(400);
    await expectBootstrapError(result.response, "invalid_request");
    expect(result.healthReads).toBe(0);
    expect(result.seen).toEqual([]);
  }
  // The health GET saw the target, but the actual POST can hit another version.
  // That Processor's strict target guard refuses before any bootstrap writes.
  const raced = await call({
    suffix: "/bootstrap",
    method: "POST",
    serviceToken: TOKEN,
    expectedSha: SHA,
    bootstrapText: '{"error":"release_mismatch"}',
    bootstrapStatus: 503,
  });
  expect(raced.healthReads).toBe(1);
  expect(raced.bootstrapTargets).toEqual([SHA]);
  expect(raced.response.status).toBe(503);
  await expectBootstrapError(raced.response, "release_mismatch");
});
