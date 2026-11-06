// `GET /api/v2/delegations`: the operator's read of the delegation table
// (ADR 0063, amendment of 2026-11-06). Real Worker; every identity and every
// configuration value is synthetic.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { resolveMcpDelegation } from "../src/delegation";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";

const OWNER = "owner-status-synthetic";
const PRINCIPAL = `mcp-client:${OWNER}`;
const AGENT = "agent-status-synthetic";
const STRANGER = "stranger-status-synthetic";
const APP_AUD = "fixture-status-browser-audience";
const MCP_AUD = "fixture-status-mcp-audience";
const ISSUER = "https://delegation-status-test.cloudflareaccess.com";
const NOW = "2026-10-09T00:00:00.000Z";
const PATH = "/api/v2/delegations";
const GRANT = {
  scopes: { sources: "*", accounts: "*", scheduleSources: ["synthetic-schedule-source"] },
  capabilities: ["summary.read"],
  budget: { maxRows: 100, maxProposalTargets: 3, maxExplainDepth: 3 },
};
const DECLARATION = {
  delegatedBy: OWNER,
  role: "maintainer",
  capabilities: ["operations.collection.request"],
  scopes: {
    sources: ["synthetic-private-source"],
    accounts: "*",
    scheduleSources: ["synthetic-schedule-source"],
  },
  issuedAt: "2026-10-01T00:00:00Z",
  notAfter: "2026-11-01T00:00:00Z",
  budget: { writesPerDay: 30 },
};
const declared = (change: Record<string, unknown> = {}) =>
  JSON.stringify({ [PRINCIPAL]: { ...DECLARATION, ...change } });
const vars = (configured: string) => ({
  MCP_DELEGATIONS: configured,
  OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
  AGENT_GRANTS: JSON.stringify([AGENT]),
  AGENT_API_GRANTS: JSON.stringify({ [PRINCIPAL]: GRANT, [AGENT]: GRANT }),
});

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${ISSUER}/cdn-cgi/access/certs`) return new Response(JSON.stringify(jwks));
      throw new Error("unexpected external request");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function read(
  configured: string,
  { subject = OWNER, audience = APP_AUD, path = PATH, method = "GET" } = {},
) {
  const assertion = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  const response = await worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method,
      headers: { "cf-access-jwt-assertion": assertion },
    }),
    {
      ...env,
      ACCESS_ISSUER: ISSUER,
      ACCESS_AUDIENCE: APP_AUD,
      ACCESS_MCP_AUDIENCE: MCP_AUD,
      ...vars(configured),
    } as Env,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the operator's delegation status", () => {
  it("is the operator's alone, on the browser application only, and takes no query", async () => {
    for (const subject of [AGENT, STRANGER, PRINCIPAL]) {
      const refused = await read(declared(), { subject });
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).not.toContain("synthetic-private-source");
    }
    // An assertion minted for the MCP application never reaches a browser route.
    const mcp = await read(declared(), { audience: MCP_AUD });
    expect(mcp.status).toBe(401);
    expect((await read(declared(), { path: `${PATH}?principal=${PRINCIPAL}` })).status).toBe(400);
    expect((await read(declared(), { method: "POST" })).status).toBe(405);
  });

  it("answers `none` for the shipped empty value and an empty object", async () => {
    for (const configured of ["", "  ", "{}"]) {
      const { status, body } = await read(configured);
      expect(status).toBe(200);
      expect(body).toEqual({
        schemaVersion: "kogane-delegation-status-v1",
        evaluatedAt: NOW,
        configuration: "none",
        delegations: [],
      });
      expect(validApiResponse(PATH, body)).toBe(true);
    }
  });

  it("shows an entry in force with the resolver's own capabilities, scope and reference", async () => {
    const configured = declared();
    const { status, body } = await read(configured);
    expect(status).toBe(200);
    expect(validApiResponse(PATH, body)).toBe(true);
    const resolved = await resolveMcpDelegation(
      vars(configured),
      { kind: "mcp-client", principal: PRINCIPAL } as Parameters<typeof resolveMcpDelegation>[1],
      NOW,
    );
    if (!resolved.ok) throw new Error("synthetic delegation must resolve");
    expect(body).toEqual({
      schemaVersion: "kogane-delegation-status-v1",
      evaluatedAt: NOW,
      configuration: "valid",
      delegations: [
        {
          principal: PRINCIPAL,
          delegatedBy: OWNER,
          role: "maintainer",
          capabilities: resolved.principal.capabilities,
          scopes: DECLARATION.scopes,
          issuedAt: DECLARATION.issuedAt,
          notAfter: DECLARATION.notAfter,
          writesPerDay: 30,
          state: "in_force",
          delegationRef: resolved.principal.delegationRef,
        },
      ],
    });
    // Nothing of the read grant, the Access settings or the other lists.
    const text = JSON.stringify(body);
    for (const forbidden of [APP_AUD, MCP_AUD, ISSUER, AGENT, "maxRows", "summary.read", "budget"])
      expect(text).not.toContain(forbidden);
  });

  it("names a window not yet open and one that has closed, as `/mcp` refuses them", async () => {
    for (const [change, state] of [
      [{ issuedAt: "2026-10-09T00:00:00.001Z" }, "not_yet_valid"],
      [{ issuedAt: NOW }, "in_force"],
      [{ notAfter: NOW }, "expired"],
      [{ notAfter: "2026-10-09T00:00:00.001Z" }, "in_force"],
    ] as const) {
      const { status, body } = await read(declared(change));
      expect(status).toBe(200);
      expect(validApiResponse(PATH, body)).toBe(true);
      expect(body["configuration"]).toBe("valid");
      expect((body["delegations"] as { state: string }[])[0]!.state).toBe(state);
    }
  });

  it("shows a refused table as `misconfigured` with no entry and nothing of the configuration", async () => {
    for (const configured of [
      "{",
      "[]",
      // The delegator is not an operator.
      JSON.stringify({
        "mcp-client:someone-else": { ...DECLARATION, delegatedBy: "someone-else" },
      }),
      // Wider than the same principal's read grant.
      declared({ scopes: { ...DECLARATION.scopes, scheduleSources: "*" } }),
      // Longer than 90 days.
      declared({ notAfter: "2027-01-01T00:00:00Z" }),
      // A valid entry beside an invalid one voids the whole table.
      JSON.stringify({
        [PRINCIPAL]: DECLARATION,
        "mcp-client:synthetic-other": { ...DECLARATION, delegatedBy: "synthetic-other" },
      }),
    ]) {
      const { status, body } = await read(configured);
      expect(status).toBe(200);
      expect(body).toEqual({
        schemaVersion: "kogane-delegation-status-v1",
        evaluatedAt: NOW,
        configuration: "misconfigured",
        delegations: [],
      });
      expect(validApiResponse(PATH, body)).toBe(true);
    }
  });
});
