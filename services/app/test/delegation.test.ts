// Real Worker + official MCP transport; all identities and configuration are synthetic.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { mcpDelegationCapabilities } from "../src/delegation";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const OWNER = "owner-delegation-synthetic";
const PRINCIPAL = `mcp-client:${OWNER}`;
const OTHER = "other-delegation-synthetic";
const APP_AUD = "fixture-browser-audience";
const MCP_AUD = "fixture-mcp-audience";
const ISSUER = "https://delegation-test.cloudflareaccess.com";
const NOW = "2026-10-09T00:00:00Z";
const GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "interpretation.propose"],
  budget: { maxRows: 200, maxProposalTargets: 5, maxExplainDepth: 2 },
};
const DECLARATION = {
  delegatedBy: OWNER,
  role: "maintainer",
  scopes: { sources: ["synthetic-private-source"], accounts: "*", scheduleSources: [] },
  issuedAt: "2026-10-01T00:00:00Z",
  notAfter: "2026-11-01T00:00:00Z",
  budget: { writesPerDay: 30 },
};
const vars = (configured = JSON.stringify({ [PRINCIPAL]: DECLARATION })) => ({
  MCP_DELEGATIONS: configured,
  OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
  AGENT_API_GRANTS: JSON.stringify({
    [PRINCIPAL]: GRANT,
    [OWNER]: GRANT,
    [`mcp-client:${OTHER}`]: GRANT,
  }),
});
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let id = 0;
let artifactId = 0;
beforeAll(async () => {
  await seedRegistry();
  const run = await seedRun({ count: 1, source: "sony-bank" });
  artifactId = run.artifacts[0].id;
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'delegation-fixture','1','2026-10-09','ok','[]') RETURNING id`)
    .bind(artifactId)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  for (const id of ["delegation-account-a", "delegation-account-b"])
    await env.DB.prepare(`INSERT INTO source_accounts
      (id,source_id,producer_id,reference_json) VALUES (?,'sony-bank','evidence-test',?)`)
      .bind(id, JSON.stringify([id]))
      .run();
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
async function send(
  path: string,
  body: unknown,
  configuration: Record<string, unknown>,
  subject = OWNER,
  audience = MCP_AUD,
  authenticated = true,
) {
  const headers: Record<string, string> =
    path === "/mcp"
      ? { ...MCP_CLIENT_HEADERS, "mcp-protocol-version": "2025-11-25" }
      : { "content-type": "application/json" };
  if (authenticated)
    headers["cf-access-jwt-assertion"] = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  const request = new Request(`https://fixture.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return worker.fetch(request, {
    ...env,
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: APP_AUD,
    ACCESS_MCP_AUDIENCE: MCP_AUD,
    ...configuration,
  } as Env);
}
const rpcBody = (method: string, params: unknown) => ({ jsonrpc: "2.0", id: ++id, method, params });
async function capabilityReport(configuration: Record<string, unknown>, subject = OWNER) {
  const response = await send(
    "/mcp",
    rpcBody("tools/call", { name: "kogane.capabilities", arguments: {} }),
    configuration,
    subject,
  );
  expect(response.status).toBe(200);
  const message = (await response.json()) as {
    result: { structuredContent: Record<string, unknown>; isError?: boolean };
  };
  expect(message.result.isError).not.toBe(true);
  return message.result.structuredContent;
}
describe("MCP S3 declaration status never enables delegated operations", () => {
  it("distinguishes inactive states from valid-but-unconnected without exposing owner configuration", async () => {
    for (const [configured, subject, reason] of [
      ["", OWNER, "delegation_not_configured"],
      ["{", OWNER, "delegation_misconfigured"],
      [JSON.stringify({ [PRINCIPAL]: DECLARATION }), OTHER, "delegation_not_configured"],
      [
        JSON.stringify({ [PRINCIPAL]: { ...DECLARATION, notAfter: NOW } }),
        OWNER,
        "delegation_expired",
      ],
      [
        JSON.stringify({ [PRINCIPAL]: { ...DECLARATION, issuedAt: "2026-10-10T00:00:00Z" } }),
        OWNER,
        "delegation_not_yet_valid",
      ],
      [JSON.stringify({ [PRINCIPAL]: DECLARATION }), OWNER, "delegation_execution_unavailable"],
    ]) {
      const report = await capabilityReport(vars(configured), subject);
      expect(report["capabilities"]).toEqual(GRANT.capabilities);
      expect(report["delegation"]).toMatchObject({ available: false, reason });
      const text = JSON.stringify(report["delegation"]);
      for (const forbidden of [
        OWNER,
        PRINCIPAL,
        "synthetic-private-source",
        "dlg_",
        "writesPerDay",
        "notAfter",
        "scopes",
      ])
        expect(text).not.toContain(forbidden);
    }
  });
  it("uses the real subsecond clock for same-second delegation bounds, not the query clock", async () => {
    vi.setSystemTime(new Date("2026-10-09T00:00:00.500Z"));
    const cases = [
      // Issued earlier within this second must already be active.
      [{ issuedAt: "2026-10-09T00:00:00.250000001Z" }, "delegation_execution_unavailable"],
      [{ issuedAt: "2026-10-09T00:00:00.500000000Z" }, "delegation_execution_unavailable"],
      [{ issuedAt: "2026-10-09T00:00:00.500000001Z" }, "delegation_not_yet_valid"],
      [{ issuedAt: "2026-10-09T00:00:00.750Z" }, "delegation_not_yet_valid"],
      // Expired earlier within this second must no longer advertise the role.
      [{ notAfter: "2026-10-09T00:00:00.250000001Z" }, "delegation_expired"],
      [{ notAfter: "2026-10-09T00:00:00.500000000Z" }, "delegation_expired"],
      [{ notAfter: "2026-10-09T00:00:00.500000001Z" }, "delegation_execution_unavailable"],
      [{ notAfter: "2026-10-09T00:00:00.750Z" }, "delegation_execution_unavailable"],
    ] as const;
    for (const [bounds, reason] of cases) {
      const configuration = vars(JSON.stringify({ [PRINCIPAL]: { ...DECLARATION, ...bounds } }));
      const report = await capabilityReport(configuration);
      const delegation = report["delegation"] as { capabilities: unknown[] };
      expect(report["delegation"]).toMatchObject({ available: false, reason });
      expect(delegation.capabilities.length > 0).toBe(
        reason === "delegation_execution_unavailable",
      );
      expect(report["capabilities"]).toEqual(GRANT.capabilities);
    }
    // The new authority clock must not alter pinned financial query contexts.
    const http = await send("/api/agent/v1/context.open", {}, vars(), OWNER, APP_AUD);
    expect(http.status).toBe(200);
    const opened = (await http.json()) as { context: { evaluationClock: string } };
    expect(opened.context.evaluationClock).toBe(NOW);
    const mcp = await send(
      "/mcp",
      rpcBody("tools/call", { name: "kogane.context.open", arguments: {} }),
      vars(),
    );
    expect(mcp.status).toBe(200);
    const message = (await mcp.json()) as {
      result: { structuredContent: { context: { evaluationClock: string } }; isError?: boolean };
    };
    expect(message.result.isError).not.toBe(true);
    expect(message.result.structuredContent.context.evaluationClock).toBe(NOW);
  });

  it("bad delegation never disables legal read/proposal or changes browser/UI authority", async () => {
    for (const configured of ["", "{", JSON.stringify({ [PRINCIPAL]: DECLARATION })]) {
      const configuration = vars(configured);
      const report = await capabilityReport(configuration);
      const http = await send("/api/agent/v1/capabilities", {}, configuration, OWNER, APP_AUD);
      expect(http.status).toBe(200);
      const { delegation: _status, ...reads } = report;
      expect(await http.json()).toEqual({ ...reads, principal: OWNER });
      const query = await send(
        "/mcp",
        rpcBody("tools/call", {
          name: "kogane.financial.query",
          arguments: { intent: "coverage" },
        }),
        configuration,
      );
      expect(query.status).toBe(200);
      const message = (await query.json()) as { result: { isError?: boolean } };
      expect(message.result.isError).not.toBe(true);
      const proposal = await send(
        "/mcp",
        rpcBody("tools/call", {
          name: "kogane.reconcile.propose",
          arguments: {
            kind: "same_account",
            from: "source_account:delegation-account-a",
            to: "source_account:delegation-account-b",
            evidenceRefs: [`fetch_artifact:${String(artifactId)}`],
            method: "ai",
            reason: `synthetic proposal regression ${String(configured.length)}`,
          },
        }),
        configuration,
      );
      expect(proposal.status).toBe(200);
      const proposed = (await proposal.json()) as {
        result: { structuredContent: { status: string; adopted: boolean } };
      };
      expect(proposed.result.structuredContent).toMatchObject({
        status: "proposed",
        adopted: false,
      });
      const ui = await send("/api/meta", undefined, configuration, OWNER, APP_AUD);
      expect(ui.status).toBe(200);
      expect(JSON.stringify(await ui.json())).not.toContain("delegation");
    }
  });
  it("valid declarations publish no new write tools and cannot reach browser operator routes", async () => {
    const configuration = { ...vars(), OPS_API_ENABLED: "true", COMMANDS_ENABLED: "true" };
    const response = await send("/mcp", rpcBody("tools/list", {}), configuration);
    const message = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(
      message.result.tools.some((tool) => /kogane\.(ops|command|schedules)\./u.test(tool.name)),
    ).toBe(false);
    for (const name of [
      "kogane.ops.collection.request",
      "kogane.command.approve",
      "kogane.Access.update",
    ]) {
      const call = await send(
        "/mcp",
        rpcBody("tools/call", { name, arguments: {} }),
        configuration,
      );
      const text = JSON.stringify(await call.json());
      expect(text).not.toContain('"accepted"');
      expect(text).not.toContain('"applied"');
      expect(text).toMatch(/actor_not_supported|unknown_tool/u);
    }
    const browserRoute = await send("/api/command/v1/approve", {}, configuration);
    expect(browserRoute.status).toBe(401);
    const unauthenticated = await send(
      "/mcp",
      rpcBody("tools/call", { name: "kogane.capabilities", arguments: {} }),
      configuration,
      OWNER,
      MCP_AUD,
      false,
    );
    expect(unauthenticated.status).toBe(401);
    expect(JSON.stringify(await unauthenticated.json())).not.toContain("synthetic-private-source");
  });
  it("the adapter ignores AGENT_GRANTS and never promotes a browser caller", async () => {
    const configuration = { ...vars(), AGENT_GRANTS: JSON.stringify([OWNER, PRINCIPAL]) };
    expect(
      await mcpDelegationCapabilities(
        configuration,
        { kind: "mcp-client", principal: PRINCIPAL },
        NOW,
      ),
    ).toMatchObject({ configuration: "valid", available: false });
    expect(
      await mcpDelegationCapabilities(
        configuration,
        { kind: "browser", principal: PRINCIPAL },
        NOW,
      ),
    ).toMatchObject({ reason: "delegation_not_mcp_client", capabilities: [], available: false });
  });
});
