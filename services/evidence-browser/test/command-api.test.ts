// The authenticated command boundary (A09). What is proved here is the
// boundary itself, not the lifecycle: the lifecycle runs in the observation
// pipeline (`services/observation-pipeline/test/change-lifecycle.test.ts`),
// which stays the single writer of the decision, approval, receipt and outbox
// tables. This Worker never writes them, so there is nothing to write here
// even with the flag on and no pipeline binding present.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { commandsEnabled, isCommandPath, principalFor } from "../src/command-api";

const issuer = "https://evidence-test.cloudflareaccess.com";
let keys: { privateKey: CryptoKey; publicKey: CryptoKey };
beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input).startsWith(issuer)
      ? Response.json({ keys: [{ ...jwk, alg: "RS256", kid: "test" }] })
      : Promise.reject(new Error("Unexpected external request in synthetic test")),
  );
});

async function token(subject = "operator@synthetic.test"): Promise<string> {
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
const enabled = { COMMANDS_ENABLED: "true" };

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
    const agents = { ...enabled, AGENT_GRANTS: '["agent-proposer"]' };
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

  it("derives the principal from the verified subject alone", () => {
    expect(isCommandPath("/api/command/v1/plan")).toBe(true);
    expect(isCommandPath("/api/commands/v1/plan")).toBe(false);
    const agent = principalFor({ AGENT_GRANTS: '["bot"]' }, "bot");
    expect(agent).toMatchObject({ id: "bot", kind: "agent", verification: "server" });
    expect(principalFor({ AGENT_GRANTS: '["bot"]' }, "human@test").kind).toBe("human");
    expect(principalFor({ AGENT_GRANTS: "" }, "bot").kind).toBe("human");
  });
});
