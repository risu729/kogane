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
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO instruments VALUES ('delegated-history-instrument','security','Synthetic delegation listing','provider-local')",
    ),
    env.DB.prepare(
      "INSERT INTO instrument_identifiers VALUES ('delegated-history-identifier','synthetic-code','fixture','SYN-DELEGATED-HISTORY','{}')",
    ),
    env.DB.prepare(
      "INSERT INTO instrument_mappings VALUES ('delegated-history-mapping','delegated-history-identifier',1,'delegated-history-instrument','rule','synthetic delegation mapping',1,'2099-01-01','Synthetic delegation listing','provider-local')",
    ),
  ]);
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
describe("MCP S3 declarations activate only installed delegated operations", () => {
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
  it("valid declarations publish only implemented delegated tools and cannot reach browser operator routes", async () => {
    const configuration = { ...vars(), OPS_API_ENABLED: "true", COMMANDS_ENABLED: "true" };
    const response = await send("/mcp", rpcBody("tools/list", {}), configuration);
    const message = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(
      message.result.tools
        .filter((tool) => /kogane\.(ops|command|schedules)\./u.test(tool.name))
        .map((tool) => tool.name),
    ).toEqual([
      "kogane.ops.import.request",
      "kogane.ops.replay.request",
      "kogane.ops.operation.get",
    ]);
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
      expect(text).toMatch(/capability_not_delegated|operation_not_delegable|unknown_tool/u);
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
  it("uses real MCP transport for atomic delegated import, replay and bounded authority", async () => {
    vi.useRealTimers();
    const declaration = {
      ...DECLARATION,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      notAfter: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: { sources: ["sony-bank"], accounts: "*", scheduleSources: [] },
      budget: { writesPerDay: 1 },
    };
    const configuration = {
      ...vars(JSON.stringify({ [PRINCIPAL]: declaration })),
      OPS_API_ENABLED: "true",
    };
    const invoke = async (
      name: string,
      arguments_: unknown,
      configuration_: Record<string, unknown> = configuration,
    ) => {
      const response = await send(
        "/mcp",
        rpcBody("tools/call", { name, arguments: arguments_ }),
        configuration_,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        result: { structuredContent: Record<string, unknown>; isError?: boolean };
      };
    };
    const arguments_ = {
      source: "sony-bank",
      runId: "synthetic-delegated-import",
      idempotencyKey: "delegated-real-1",
    };
    const accepted = await invoke("kogane.ops.import.request", arguments_);
    expect(accepted.result.structuredContent).not.toHaveProperty("error");
    expect(accepted.result.isError).not.toBe(true);
    const operationId = accepted.result.structuredContent["operationId"];
    expect(typeof operationId).toBe("string");
    const rows = await env.DB.prepare(
      "SELECT * FROM audit_records WHERE principal=? AND idempotency_key=? AND result='accepted'",
    )
      .bind(PRINCIPAL, arguments_.idempotencyKey)
      .all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      principal_kind: "delegated",
      path: "mcp",
      subject: OWNER,
      operation: "ops.import.request",
    });
    expect(rows.results[0]!["delegation_ref"]).toMatch(/^dlg_[0-9a-f]{64}$/u);
    expect(rows.results[0]!["payload_digest"]).toMatch(/^[0-9a-f]{64}$/u);
    const replay = await invoke("kogane.ops.import.request", arguments_);
    expect(replay.result.isError).not.toBe(true);
    expect(replay.result.structuredContent["operationId"]).toBe(operationId);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM ops_requests WHERE principal=? AND idempotency_key=?",
      )
        .bind(PRINCIPAL, arguments_.idempotencyKey)
        .first<number>("n"),
    ).toBe(1);
    const conflict = await invoke("kogane.ops.import.request", { ...arguments_, runId: "changed" });
    expect(conflict.result.structuredContent).toEqual({ error: "idempotency_conflict" });
    const spent = await invoke("kogane.ops.import.request", {
      ...arguments_,
      idempotencyKey: "delegated-real-2",
    });
    expect(spent.result.structuredContent).toEqual({ error: "delegation_budget_exceeded" });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM ops_requests WHERE principal=? AND idempotency_key=?",
      )
        .bind(PRINCIPAL, "delegated-real-2")
        .first<number>("n"),
    ).toBe(0);
    const receipt = await invoke("kogane.ops.operation.get", { operationId });
    expect(receipt.result.isError).not.toBe(true);
    const narrowed = {
      ...configuration,
      MCP_DELEGATIONS: JSON.stringify({
        [PRINCIPAL]: { ...declaration, scopes: { ...declaration.scopes, sources: [] } },
      }),
    };
    const denied = await invoke("kogane.ops.operation.get", { operationId }, narrowed);
    const missing = await invoke(
      "kogane.ops.operation.get",
      { operationId: `op_${"0".repeat(64)}` },
      narrowed,
    );
    expect(denied.result.structuredContent).toEqual(missing.result.structuredContent);
    const revoked = await invoke("kogane.ops.import.request", arguments_, {
      ...configuration,
      MCP_DELEGATIONS: "",
    });
    expect(revoked.result.structuredContent).toEqual({ error: "delegation_not_configured" });
    const browser = await send("/api/command/v1/plan", {}, configuration);
    expect(browser.status).toBe(401);
  });

  it("returns identical history and scoped audit data through HTTP and MCP using shared readers", async () => {
    const grant = {
      ...GRANT,
      capabilities: ["records.read", "audit.read"],
      scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
    };
    const configuration = {
      ...vars(""),
      AGENT_API_GRANTS: JSON.stringify({ [OWNER]: grant, [PRINCIPAL]: grant }),
    };
    const invoke = async (
      name: string,
      arguments_: unknown,
      configuration_: Record<string, unknown> = configuration,
    ) => {
      const response = await send(
        "/mcp",
        rpcBody("tools/call", { name, arguments: arguments_ }),
        configuration_,
      );
      const value = (await response.json()) as {
        result: { structuredContent: Record<string, unknown>; isError?: boolean };
      };
      expect(response.status).toBe(200);
      return value.result;
    };
    const args = { identifierId: "delegated-history-identifier" };
    const ui = await send(
      "/api/identity/instrument-history?identifierId=delegated-history-identifier",
      undefined,
      configuration,
      OWNER,
      APP_AUD,
    );
    const http = await send(
      "/api/agent/v1/instruments.history",
      args,
      configuration,
      OWNER,
      APP_AUD,
    );
    const mcp = await invoke("kogane.instruments.history", args);
    expect(ui.status).toBe(200);
    expect(http.status).toBe(200);
    expect(mcp.isError).not.toBe(true);
    expect(await ui.json()).toEqual(mcp.structuredContent);
    expect(await http.json()).toEqual(mcp.structuredContent);
    expect(mcp.structuredContent).toMatchObject({
      total: 1,
      entries: [{ entry: "mapping", revision: 1, instrumentId: "delegated-history-instrument" }],
    });
    const filter = { filters: { operation: "instruments.history" } };
    const auditHttp = await send(
      "/api/agent/v1/audit.search",
      filter,
      configuration,
      OWNER,
      APP_AUD,
    );
    const auditMcp = await invoke("kogane.audit.search", filter);
    expect(auditHttp.status).toBe(200);
    expect(auditMcp.isError).not.toBe(true);
    expect(await auditHttp.json()).toEqual(auditMcp.structuredContent);
    const records = auditMcp.structuredContent["records"] as { auditId: string }[];
    expect(records.length).toBeGreaterThan(0);
    const detail = { auditId: records[0]!.auditId };
    const detailHttp = await send("/api/agent/v1/audit.get", detail, configuration, OWNER, APP_AUD);
    const detailMcp = await invoke("kogane.audit.get", detail);
    expect(await detailHttp.json()).toEqual(detailMcp.structuredContent);
    const narrowedGrant = {
      ...grant,
      scopes: { ...grant.scopes, sources: ["sony-bank"], scheduleSources: [] },
    };
    const narrowed = {
      ...configuration,
      AGENT_API_GRANTS: JSON.stringify({ [OWNER]: narrowedGrant, [PRINCIPAL]: narrowedGrant }),
    };
    const refusedHttp = await send(
      "/api/agent/v1/instruments.history",
      args,
      narrowed,
      OWNER,
      APP_AUD,
    );
    const refusedMcp = await invoke("kogane.instruments.history", args, narrowed);
    expect(refusedHttp.status).toBe(403);
    expect(refusedMcp.isError).toBe(true);
    expect(await refusedHttp.json()).toEqual(refusedMcp.structuredContent);
    const missing = await invoke(
      "kogane.audit.get",
      { auditId: "aud_00000000-0000-4000-8000-000000000000" },
      narrowed,
    );
    const denied = await invoke("kogane.audit.get", detail, narrowed);
    expect(denied.structuredContent).toEqual(missing.structuredContent);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM instrument_mappings WHERE identifier_id='delegated-history-identifier'",
      ).first<number>("n"),
    ).toBe(1);
  });
});
