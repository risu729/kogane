// The release postcheck's health route over the real Worker, the real
// migrations and a synthetic Processor binding (unified plan 11 §6, U14,
// acceptance G5-10/G5-14 postcheck side). Nothing here is a real account,
// credential, amount or token.
//
// What these checks pin:
//   * the route is authenticated: no assertion is 401, and an Access service
//     token that this deployment does not list is 403 — the postcheck cannot
//     be called by anyone who happens to reach the hostname;
//   * a listed service token and the operator both get the answer, an agent
//     subject does not (it may propose, never accept);
//   * the answer carries the build identity the deploy stamped, the applied
//     CORE and READ migrations, the DATA probe, the capability snapshot and the
//     Processor's own answer relayed through the service binding;
//   * a Processor that cannot be reached makes the App report `degraded` with
//     503, so a release fails instead of passing on a half-deployed pair;
//   * it does not depend on `OPS_API_ENABLED`, and it takes no query string,
//     no body and no verb but GET.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { DATA_MARKER_KEY, HEALTH_PATH } from "../src/health";

const SHA = "a".repeat(40);
const OPERATOR = "health-operator";
const AGENT = "health-agent";
const PROBE_TOKEN = "postcheck.access";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

/** A Processor that answers the internal health route, as the binding would. */
function pipeline(body: Record<string, unknown> = {}, status = 200) {
  const seen: { url: string; caller: string | null }[] = [];
  return {
    seen,
    binding: {
      fetch: async (request: Request) => {
        seen.push({
          url: request.url,
          caller: request.headers.get("x-kogane-internal-caller"),
        });
        return Response.json(
          { ok: status === 200, worker: "kogane-observation-pipeline", releaseSha: SHA, ...body },
          { status },
        );
      },
    },
  };
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://health-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** A user session token (a subject), or a service token (a common name). */
async function token(claims: Record<string, unknown>, subject?: string) {
  const jwt = new SignJWT({ type: "app", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience("fixture-audience")
    .setIssuedAt()
    .setExpirationTime("5m");
  // Cloudflare issues a service token with an empty subject and names the
  // token in `common_name`; a user session carries the subject instead.
  return jwt.setSubject(subject ?? "").sign(keys.privateKey);
}

async function call(
  options: {
    path?: string;
    method?: string;
    subject?: string;
    serviceToken?: string;
    anonymous?: boolean;
    environment?: Record<string, unknown>;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (!options.anonymous) {
    headers["cf-access-jwt-assertion"] =
      options.serviceToken === undefined
        ? await token({}, options.subject ?? OPERATOR)
        : await token({ common_name: options.serviceToken });
  }
  const response = await worker.fetch(
    new Request(`https://fixture.test${options.path ?? HEALTH_PATH}`, {
      method: options.method ?? "GET",
      headers,
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      RELEASE_SHA: SHA,
      HEALTH_PROBE_TOKENS: JSON.stringify([PROBE_TOKEN]),
      OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]),
      AGENT_GRANTS: JSON.stringify([AGENT]),
      ...options.environment,
    } as Env,
  );
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

describe("the health route is authenticated (plan 11 §6)", () => {
  it("refuses a request with no Access assertion", async () => {
    const response = await call({ anonymous: true });
    expect(response.status).toBe(401);
    expect(response.json).toMatchObject({ error: "authentication_required" });
  });

  it("refuses a service token this deployment does not list", async () => {
    const response = await call({ serviceToken: "someone-elses-token" });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ error: "actor_not_supported" });
    // And an empty list is "none", not "any".
    const unset = await call({
      serviceToken: PROBE_TOKEN,
      environment: { HEALTH_PROBE_TOKENS: "" },
    });
    expect(unset.status).toBe(403);
  });

  it("lets a listed service token reach the health route and nothing else", async () => {
    // Every other family of this Worker authenticates a *subject*. A service
    // token has none, so each of them answers 401 exactly as it does with no
    // assertion at all — whatever the flags say, and even though the token is
    // listed for the health route.
    const elsewhere = [
      { path: "/api/evidence/v1/meta" },
      { path: "/api/evidence/v1/sources/sony-bank/runs" },
      { path: "/api/v2/query", method: "POST" },
      { path: "/api/agent/v1/plan", method: "POST" },
      { path: "/mcp", method: "POST" },
      { path: "/api/command/v1/plan", method: "POST" },
      { path: "/api/ops/v1/collections", method: "POST" },
      { path: "/api/ops/v1/operations/op-1" },
      { path: `${HEALTH_PATH}/` },
      { path: `${HEALTH_PATH.toUpperCase()}` },
    ];
    for (const options of elsewhere) {
      const response = await call({
        ...options,
        serviceToken: PROBE_TOKEN,
        environment: {
          PIPELINE: pipeline().binding,
          OPS_API_ENABLED: "true",
          COMMANDS_ENABLED: "true",
          AGENT_API_GRANTS: JSON.stringify([PROBE_TOKEN]),
          AGENT_GRANTS: JSON.stringify([AGENT, PROBE_TOKEN]),
        },
      });
      expect(response.status, options.path).toBe(401);
      expect(response.json).toMatchObject({ error: "authentication_required" });
    }
  });

  it("decides who the caller is before what the request is", async () => {
    // An unlisted token gets the same 403 for a POST as for a GET: the route's
    // shape is not disclosed to a caller that may not read it.
    const unlisted = await call({ serviceToken: "someone-elses-token", method: "POST" });
    expect(unlisted.status).toBe(403);
    const anonymous = await call({ anonymous: true, method: "POST" });
    expect(anonymous.status).toBe(401);
  });

  it("refuses a subject no list names, exactly as the operations API does", async () => {
    // The grant lists are allow-lists: a verified session that is neither the
    // operator nor an agent is `subject_not_granted`, not a reader by default.
    const response = await call({
      subject: "someone-with-a-session",
      environment: { PIPELINE: pipeline().binding },
    });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ error: "subject_not_granted" });
  });

  it("answers nobody while HEALTH_PROBE_TOKENS is present but unreadable", async () => {
    // A list that cannot be read is a deployment problem, reported the way the
    // grant lists are — 503 for every caller, never a shorter list — and the
    // value itself is not echoed (the log carries a problem code only).
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const value of ["not json", "[1]", '{"a":1}', JSON.stringify([""])]) {
      for (const who of [{ serviceToken: PROBE_TOKEN }, { subject: OPERATOR }]) {
        const response = await call({
          ...who,
          environment: { PIPELINE: pipeline().binding, HEALTH_PROBE_TOKENS: value },
        });
        expect(response.status, value).toBe(503);
        expect(response.json).toMatchObject({ error: "grants_misconfigured" });
      }
    }
    const reported = log.mock.calls
      .map((entry) => String(entry[0]))
      .filter((line) => line.includes('"event":"grants_misconfigured"'));
    expect(reported.length).toBeGreaterThan(0);
    for (const line of reported) {
      expect(line).toContain("health_probe_tokens_invalid");
      expect(line).not.toContain("not json");
    }
    log.mockRestore();
  });

  it("does not certify a deployment whose subject lists cannot be read", async () => {
    // The subject lists grade sessions, not service tokens, so an unreadable
    // OPERATOR_SUBJECTS is 503 `grants_misconfigured` for the operator (as on
    // every command surface) — and the listed token still gets an answer, but
    // that answer is `degraded`: a deployment that grades nobody is not a
    // release to certify. The body names the problem as a code, never a value.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const [variable, problem] of [
      ["OPERATOR_SUBJECTS", "operator_subjects_invalid"],
      ["AGENT_GRANTS", "agent_grants_invalid"],
    ] as const) {
      const operator = await call({
        subject: OPERATOR,
        environment: { PIPELINE: pipeline().binding, [variable]: "not json" },
      });
      expect(operator.status).toBe(503);
      expect(operator.json).toMatchObject({ error: "grants_misconfigured" });
      const token = await call({
        serviceToken: PROBE_TOKEN,
        environment: { PIPELINE: pipeline().binding, [variable]: "not json" },
      });
      expect(token.status).toBe(503);
      expect(token.json.status).toBe("degraded");
      expect(token.json.grants).toEqual({ usable: false, problem });
      expect(JSON.stringify(token.json)).not.toContain("not json");
    }
    // A subject in both lists has no defined role, and is reported the same way.
    const overlap = await call({
      serviceToken: PROBE_TOKEN,
      environment: {
        PIPELINE: pipeline().binding,
        OPERATOR_SUBJECTS: JSON.stringify([AGENT]),
        AGENT_GRANTS: JSON.stringify([AGENT]),
      },
    });
    expect(overlap.status).toBe(503);
    expect(overlap.json.grants).toEqual({ usable: false, problem: "subject_in_both_lists" });
  });

  it("treats empty subject lists as a usable, deny-all configuration", async () => {
    // The committed default names nobody; that is a configuration, not a
    // misconfiguration, and the token's postcheck must still pass on it.
    for (const lists of [
      { OPERATOR_SUBJECTS: "", AGENT_GRANTS: "" },
      { OPERATOR_SUBJECTS: undefined, AGENT_GRANTS: undefined },
    ]) {
      const response = await call({
        serviceToken: PROBE_TOKEN,
        environment: { PIPELINE: pipeline().binding, ...lists },
      });
      expect(response.status).toBe(200);
      expect(response.json.status).toBe("ok");
      expect(response.json.grants).toEqual({ usable: true });
    }
  });

  it("refuses an agent subject, which may propose but never accept", async () => {
    const response = await call({ subject: AGENT, environment: { PIPELINE: pipeline().binding } });
    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ error: "approval_required" });
  });

  it("answers the operator and the listed service token alike", async () => {
    for (const options of [{ subject: OPERATOR }, { serviceToken: PROBE_TOKEN }]) {
      const response = await call({ ...options, environment: { PIPELINE: pipeline().binding } });
      expect(response.status).toBe(200);
      expect(response.json.status).toBe("ok");
    }
  });
});

describe("what the postcheck reads", () => {
  it("reports the build identity, both databases, the bucket and the capabilities", async () => {
    const processor = pipeline();
    const response = await call({ environment: { PIPELINE: processor.binding } });
    expect(response.status).toBe(200);
    expect(response.json.releaseSha).toBe(SHA);
    expect(response.json.worker).toBe("kogane-evidence-browser");
    // CORE: `SELECT 1` and the migration files the suite applied, in order.
    expect(response.json.core).toMatchObject({ bound: true, ok: true, migrationsTable: true });
    expect(response.json.core.migrationsApplied.length).toBeGreaterThan(0);
    expect(response.json.core.latestMigration).toBe(response.json.core.migrationsApplied.at(-1));
    // READ is the required projection store for this deployment.
    expect(response.json.read).toMatchObject({ bound: true, ok: true, required: true });
    // The DATA probe is one `head` of a fixed key and never requires it to be
    // there. The marker is absent in a fresh test bucket.
    expect(response.json.data).toMatchObject({ bound: true, ok: true, markerPresent: false });
    expect(response.json.capabilities).toMatchObject({ readOnly: true });
    expect(response.json.grants).toEqual({ usable: true });
    // The Processor was asked over the binding, and named its caller.
    expect(processor.seen).toHaveLength(1);
    expect(processor.seen[0]?.url).toContain("/internal/health");
    expect(processor.seen[0]?.caller).toBe("kogane-evidence-browser");
    expect(response.json.processor).toMatchObject({ ok: true, releaseSha: SHA });
  });

  it("sees the DATA marker when it exists, and writes nothing either way", async () => {
    await env.EVIDENCE.put(DATA_MARKER_KEY, "synthetic");
    const before = (await env.EVIDENCE.list()).objects.length;
    const response = await call({ environment: { PIPELINE: pipeline().binding } });
    expect(response.json.data).toMatchObject({ ok: true, markerPresent: true });
    expect((await env.EVIDENCE.list()).objects.length).toBe(before);
    await env.EVIDENCE.delete(DATA_MARKER_KEY);
  });

  it("reports READ as required once a READ flag is on", async () => {
    const response = await call({
      environment: { PIPELINE: pipeline().binding, READ_PROJECTION_ENABLED: "true" },
    });
    expect(response.json.read).toMatchObject({ required: true, ok: true });
    expect(response.status).toBe(200);
  });
});

describe("a half-deployed pair fails the release", () => {
  it("is degraded with 503 when the Processor binding is absent", async () => {
    const response = await call({ environment: { PIPELINE: undefined } });
    expect(response.status).toBe(503);
    expect(response.json.status).toBe("degraded");
    expect(response.json.processor).toMatchObject({ ok: false, error: "binding_absent" });
  });

  it("is degraded with 503 when the Processor's answer does not say ok", async () => {
    // The relay never infers health from silence: an answer without `ok: true`
    // — a different route answering, a truncated body — is not a healthy pair.
    const response = await call({
      environment: {
        PIPELINE: {
          fetch: async () => Response.json({ worker: "kogane-observation-pipeline" }),
        },
      },
    });
    expect(response.status).toBe(503);
    expect(response.json.status).toBe("degraded");
  });

  it("is degraded with 503 when the Processor answers unhealthy", async () => {
    const response = await call({ environment: { PIPELINE: pipeline({}, 503).binding } });
    expect(response.status).toBe(503);
    expect(response.json.processor).toMatchObject({ ok: false, error: "unhealthy", status: 503 });
  });

  it("is degraded with 503 when the Processor cannot be reached", async () => {
    const response = await call({
      environment: {
        PIPELINE: {
          fetch: async () => {
            throw new Error("synthetic transport failure");
          },
        },
      },
    });
    expect(response.status).toBe(503);
    // A safe code, never the exception text of the internal call.
    expect(response.json.processor).toEqual({ ok: false, error: "unreachable" });
  });
});

describe("the route's own boundary", () => {
  it("does not depend on the operations API flag", async () => {
    for (const value of ["", "true", "no"]) {
      const response = await call({
        environment: { PIPELINE: pipeline().binding, OPS_API_ENABLED: value },
      });
      expect(response.status).toBe(200);
    }
  });

  it("takes no other verb and no query string", async () => {
    const post = await call({ method: "POST", environment: { PIPELINE: pipeline().binding } });
    expect(post.status).toBe(405);
    expect(post.json).toMatchObject({ error: "method_not_allowed" });
    const query = await call({
      path: `${HEALTH_PATH}?verbose=1`,
      environment: { PIPELINE: pipeline().binding },
    });
    expect(query.status).toBe(400);
    expect(query.json).toMatchObject({ error: "invalid_query" });
  });

  it("leaves every other operations path exactly as it was", async () => {
    // The flag is off here, so the operations paths do not exist: a POST is the
    // Worker's 405 and an unrouted GET is 404 (test/ops-api.test.ts pins the
    // same answers). Adding the health route changed neither.
    const post = await call({ path: "/api/ops/v1/collections", method: "POST" });
    expect(post.status).toBe(405);
    const unknown = await call({ path: "/api/ops/v1/health/extra" });
    expect(unknown.status).toBe(404);
  });
});
