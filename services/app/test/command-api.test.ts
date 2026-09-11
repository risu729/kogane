// The authenticated command boundary (A09). What is proved here is the
// boundary itself, not the lifecycle: the lifecycle runs in the observation
// pipeline (`services/processor/test/change-lifecycle.test.ts`),
// which stays the single writer of the decision, approval, receipt and outbox
// tables. This Worker never writes them, so there is nothing to write here
// even with the flag on and no pipeline binding present.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { commandsEnabled, isCommandPath } from "../src/command-api";
import { grantsUsable, principalFor } from "../src/grants";
import { HttpError } from "../src/http";

const issuer = "https://evidence-test.cloudflareaccess.com";
const jwksPath = "/cdn-cgi/access/certs";

/**
 * The one request this suite serves: the issuer's Access key set. Matched on a
 * parsed origin and path, never on a string prefix.
 * `https://evidence-test.cloudflareaccess.com.example.invalid/certs` starts
 * with the issuer but is a different host, and a stub that served it would let
 * these tests pass against keys from anywhere.
 */
function isIssuerKeySet(input: RequestInfo | URL): boolean {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return false;
  }
  return url.origin === issuer && url.pathname === jwksPath;
}

let keys: { privateKey: CryptoKey; publicKey: CryptoKey };
beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    isIssuerKeySet(input)
      ? Response.json({ keys: [{ ...jwk, alg: "RS256", kid: "test" }] })
      : Promise.reject(new Error("Unexpected external request in synthetic test")),
  );
});

/** The one subject this deployment grants the operator role. */
const OPERATOR = "operator@synthetic.test";
/** A verified subject in neither list: authenticated, granted nothing. */
const STRANGER = "stranger@synthetic.test";

async function token(subject = OPERATOR): Promise<string> {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience("synthetic-test-audience")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

async function call(
  path: string,
  options: {
    jwt?: string | null;
    method?: string;
    body?: unknown;
    environment?: Record<string, unknown>;
  } = {},
) {
  const jwt = options.jwt === undefined ? await token() : options.jwt;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: options.method ?? "POST",
      headers: {
        ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "synthetic-test-audience",
      ...options.environment,
    } as Env,
  );
}

const COMMANDS = ["plan", "simulate", "approve", "commit", "operation"] as const;
/**
 * The flag on *and* an operator named. Both halves are needed: the grant lists
 * are allow-lists, so a deployment with the flag on and no operator grants
 * nobody anything (docs/change-lifecycle.md, "Grants"). Every suite that wants
 * the operator role says so here rather than inheriting it from being unknown.
 */
const enabled = { COMMANDS_ENABLED: "true", OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]) };

describe("the command boundary", () => {
  it("requires Access before it looks at anything else", async () => {
    for (const command of COMMANDS) {
      const path = `/api/command/v1/${command}`;
      expect((await call(path, { jwt: null, environment: enabled })).status).toBe(401);
      expect((await call(path, { jwt: "invalid", environment: enabled })).status).toBe(401);
    }
  });

  it('is closed while the feature flag is absent or not exactly "true"', async () => {
    for (const command of COMMANDS) {
      const path = `/api/command/v1/${command}`;
      const off = await call(path, { body: {} });
      expect(off.status).toBe(403);
      expect(await off.json()).toMatchObject({ error: "commands_disabled" });
      for (const value of ["", "1", "yes", "TRUE", "false"])
        expect(
          (await call(path, { body: {}, environment: { COMMANDS_ENABLED: value } })).status,
        ).toBe(403);
    }
    expect(commandsEnabled({ COMMANDS_ENABLED: "true" })).toBe(true);
    expect(commandsEnabled({ COMMANDS_ENABLED: "" })).toBe(false);
  });

  it("accepts only POST on the five command paths and 404s anything else under the prefix", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"])
      expect((await call("/api/command/v1/plan", { method, environment: enabled })).status).toBe(
        405,
      );
    for (const path of [
      "/api/command/v1/delete",
      "/api/command/v1/plan/extra",
      "/api/command/v1",
      "/api/command/v1/",
    ])
      expect((await call(path, { body: {}, environment: enabled })).status).toBe(404);
    // The rest of the Worker is still GET-only.
    expect((await call("/api/meta", { environment: enabled })).status).toBe(405);
    expect((await call("/api/evidence/v1/meta", { environment: enabled })).status).toBe(405);
  });

  it("refuses an agent's approval and commit before anything is forwarded", async () => {
    const agents = { ...enabled, AGENT_GRANTS: JSON.stringify(["agent-proposer"]) };
    for (const command of ["approve", "commit"] as const) {
      const response = await call(`/api/command/v1/${command}`, {
        jwt: await token("agent-proposer"),
        body: { planId: "0".repeat(64) },
        environment: agents,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "approval_required" });
    }
    // The same agent may plan and simulate: it reaches the executor gate,
    // which is the writer's absence in this test environment, not a refusal.
    for (const command of ["plan", "simulate"] as const)
      expect(
        (
          await call(`/api/command/v1/${command}`, {
            jwt: await token("agent-proposer"),
            body: { kind: "identity.assign", payload: {} },
            environment: agents,
          })
        ).status,
      ).toBe(503);
  });

  it("gives a human every command and forwards nothing when the writer binding is absent", async () => {
    for (const command of COMMANDS) {
      const response = await call(`/api/command/v1/${command}`, {
        body: {},
        environment: enabled,
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "command_executor_unavailable" });
    }
  });

  it("bounds the body and refuses a query string", async () => {
    expect(
      (await call("/api/command/v1/plan?x=1", { body: {}, environment: enabled })).status,
    ).toBe(400);
    const huge = { reason: "x".repeat(20_000) };
    expect((await call("/api/command/v1/plan", { body: huge, environment: enabled })).status).toBe(
      413,
    );
    const response = await worker.fetch(
      new Request("https://fixture.test/api/command/v1/plan", {
        method: "POST",
        headers: { "cf-access-jwt-assertion": await token(), "content-type": "application/json" },
        body: "[1,2,3]",
      }),
      {
        ...env,
        ACCESS_ISSUER: issuer,
        ACCESS_AUDIENCE: "synthetic-test-audience",
        ...enabled,
      } as Env,
    );
    expect(response.status).toBe(400);
  });

  it("keeps command answers uncacheable and free of credentials", async () => {
    const response = await call("/api/command/v1/plan", { body: {}, environment: enabled });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const text = await response.text();
    expect(text).not.toContain("cf-access");
    expect(text).not.toContain("eyJ");
  });

  it("advertises the capability from the deployment flag, never from a constant", async () => {
    const off = (await (await call("/api/meta", { method: "GET" })).json()) as {
      capabilities: { commands: boolean; readOnly: boolean };
    };
    expect(off.capabilities.commands).toBe(false);
    expect(off.capabilities.readOnly).toBe(true);
    const on = (await (
      await call("/api/meta", { method: "GET", environment: enabled })
    ).json()) as { capabilities: { commands: boolean } };
    expect(on.capabilities.commands).toBe(true);
  });

  it("serves the key set only for the issuer's own origin", () => {
    expect(isIssuerKeySet(`${issuer}${jwksPath}`)).toBe(true);
    expect(isIssuerKeySet(new URL(`${issuer}${jwksPath}`))).toBe(true);
    for (const other of [
      // A different host that merely starts with the issuer string.
      `${issuer}.example.invalid${jwksPath}`,
      `${issuer}@example.invalid${jwksPath}`,
      // Right host, wrong scheme, port or path.
      `http://evidence-test.cloudflareaccess.com${jwksPath}`,
      `https://evidence-test.cloudflareaccess.com:8443${jwksPath}`,
      `${issuer}/cdn-cgi/access/certs/../../../other`,
      `${issuer}/`,
      "not a url",
    ])
      expect(isIssuerKeySet(other)).toBe(false);
  });

  it("derives the principal from the verified subject alone", () => {
    expect(isCommandPath("/api/command/v1/plan")).toBe(true);
    expect(isCommandPath("/api/commands/v1/plan")).toBe(false);
    const both = { OPERATOR_SUBJECTS: '["human@test"]', AGENT_GRANTS: '["bot"]' };
    expect(principalFor(both, "bot")).toMatchObject({
      id: "bot",
      kind: "agent",
      verification: "server",
      capabilities: ["interpretation.propose"],
    });
    expect(principalFor(both, "human@test")).toMatchObject({
      id: "human@test",
      kind: "human",
      verification: "server",
    });
  });
});

/**
 * The grant lists are allow-lists in both directions. The finding this suite
 * exists for: an authenticated subject that neither list named used to be
 * graded the human operator, so an absent, malformed or mis-shaped
 * `AGENT_GRANTS` handed approve and commit to an agent — and to anyone else
 * Access let through. Nothing is granted by *not* being listed now, and a
 * configuration this Worker cannot read grants nobody anything at all.
 */
describe("the command grant lists fail closed", () => {
  const agentOnly = { ...enabled, AGENT_GRANTS: JSON.stringify(["agent-proposer"]) };

  it("refuses a subject neither list names, on every command", async () => {
    for (const command of COMMANDS) {
      const response = await call(`/api/command/v1/${command}`, {
        jwt: await token(STRANGER),
        body: {},
        environment: agentOnly,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "subject_not_granted" });
    }
  });

  it("grants the operator nothing until OPERATOR_SUBJECTS names one", async () => {
    // Flag on, no operator configured: the deployed default. Approve and
    // commit are unreachable for everyone, which is the intended state.
    for (const command of COMMANDS) {
      const response = await call(`/api/command/v1/${command}`, {
        body: {},
        environment: { COMMANDS_ENABLED: "true" },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "subject_not_granted" });
    }
    // And with the operator named, the same subject reaches the writer gate.
    const named = await call("/api/command/v1/approve", { body: {}, environment: enabled });
    expect(named.status).toBe(503);
    expect(await named.json()).toMatchObject({ error: "command_executor_unavailable" });
  });

  // Every way a deployment can get these two variables wrong. In each case the
  // *whole* deployment stops grading subjects: the named agent, the named
  // operator and a stranger are all refused, and none of them can approve.
  const misconfigured: [string, Record<string, string>][] = [
    [
      "OPERATOR_SUBJECTS is not JSON",
      { OPERATOR_SUBJECTS: "{", AGENT_GRANTS: '["agent-proposer"]' },
    ],
    [
      "OPERATOR_SUBJECTS is an object, not an array",
      { OPERATOR_SUBJECTS: '{"operator@synthetic.test":true}' },
    ],
    [
      "OPERATOR_SUBJECTS holds a non-string",
      { OPERATOR_SUBJECTS: '["operator@synthetic.test",7]' },
    ],
    [
      "AGENT_GRANTS is not JSON",
      { OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]), AGENT_GRANTS: "not json" },
    ],
    [
      "AGENT_GRANTS is an object, not an array",
      {
        OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]),
        AGENT_GRANTS: '{"agent-proposer":{"capabilities":[]}}',
      },
    ],
    [
      "AGENT_GRANTS holds a non-string",
      { OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]), AGENT_GRANTS: '["agent-proposer",null]' },
    ],
    [
      "a subject is in both lists",
      {
        OPERATOR_SUBJECTS: JSON.stringify([OPERATOR, "agent-proposer"]),
        AGENT_GRANTS: JSON.stringify(["agent-proposer"]),
      },
    ],
  ];

  for (const [label, vars] of misconfigured) {
    it(`denies everyone when ${label}`, async () => {
      for (const subject of [OPERATOR, "agent-proposer", STRANGER]) {
        for (const command of ["approve", "commit", "plan"] as const) {
          const response = await call(`/api/command/v1/${command}`, {
            jwt: await token(subject),
            body: {},
            environment: { COMMANDS_ENABLED: "true", ...vars },
          });
          expect(response.status, `${subject} ${command}`).toBe(503);
          expect(await response.json()).toMatchObject({ error: "grants_misconfigured" });
        }
      }
      expect(grantsUsable(vars)).toBe(false);
    });
  }

  it("reports a misconfiguration as a code and never as the configured value", () => {
    const secret = "operator-identity-that-must-not-be-logged";
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      expect(() => principalFor({ OPERATOR_SUBJECTS: `[${secret}` }, OPERATOR)).toThrow(HttpError);
      expect(grantsUsable({ AGENT_GRANTS: `{"${secret}":1}` })).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(secret);
      expect(JSON.parse(line)).toEqual({
        event: "grants_misconfigured",
        problem: expect.stringMatching(/^[a-z_]{1,40}$/u),
      });
    }
  });

  it("refuses a subject that is not an actor the decision log accepts", () => {
    for (const subject of ["Bad Actor", "", "-leading"])
      expect(() => principalFor({ OPERATOR_SUBJECTS: JSON.stringify([subject]) }, subject)).toThrow(
        HttpError,
      );
  });
});
