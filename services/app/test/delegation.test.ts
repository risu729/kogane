// Real Worker + official MCP transport; all identities and configuration are synthetic.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { createPlan, d1CommandStore } from "../../../packages/application/src/index";
import { changeCommandRoute } from "../../processor/src/change-commands";
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

it("real MCP R2 owner decision prepares, confirms through the existing writer, and replays without a second effect", async () => {
  vi.useRealTimers();
  await env.DB.prepare(
    "INSERT INTO instruments VALUES ('delegated-r2-target','security','Synthetic R2 target','identified')",
  ).run();
  const plan = await createPlan(
    "identity.assign",
    {
      subject: "instrument",
      referenceId: "delegated-history-identifier",
      targetId: "delegated-r2-target",
      reason: "synthetic MCP decision",
    },
    {
      actor: {
        id: OWNER,
        kind: "human",
        verification: "server",
        capabilities: ["interpretation.propose", "interpretation.accept"],
      },
      baseContextId: "identity-current-v1",
      now: new Date().toISOString(),
      ttlSeconds: 900,
    },
    d1CommandStore(env.DB),
  );
  if (!plan.ok) throw new Error(plan.error);
  const pipeline = {
    fetch: vi.fn(async (request: Request) => {
      const response = await changeCommandRoute(
        env as Parameters<typeof changeCommandRoute>[0],
        request,
        new URL(request.url).pathname,
      );
      if (!response) throw new Error("unexpected pipeline route");
      return response;
    }),
  };
  const configuration = {
    ...vars(
      JSON.stringify({
        [PRINCIPAL]: {
          ...DECLARATION,
          role: "operator-delegate",
          scopes: { sources: "*", accounts: "*", scheduleSources: [] },
        },
      }),
    ),
    COMMANDS_ENABLED: "true",
    PIPELINE: pipeline,
  };
  const invoke = async (name: string, args: unknown) => {
    const response = await send(
      "/mcp",
      rpcBody("tools/call", { name, arguments: args }),
      configuration,
    );
    return (await response.json()) as { result: { structuredContent: any; isError?: boolean } };
  };
  const approveBody = {
    planId: plan.plan.planId,
    planDigest: plan.plan.planDigest,
    scope: [],
    idempotencyKey: "mcp-r2-approve",
  };
  const before = await env.DB.prepare("SELECT count(*) n FROM approvals").first<{ n: number }>();
  const prepared = await invoke("kogane.command.approve", { ...approveBody, step: "prepare" });
  expect(prepared.result.isError).not.toBe(true);
  expect(pipeline.fetch).not.toHaveBeenCalled();
  expect(await env.DB.prepare("SELECT count(*) n FROM approvals").first()).toEqual(before);
  const digest = prepared.result.structuredContent.confirmation.digest as string;
  const changed = await invoke("kogane.command.approve", {
    ...approveBody,
    scope: ["changed"],
    step: "confirm",
    confirmationDigest: digest,
  });
  expect(changed.result.isError).toBe(true);
  expect(pipeline.fetch).not.toHaveBeenCalled();
  const accepted = await invoke("kogane.command.approve", {
    ...approveBody,
    step: "confirm",
    confirmationDigest: digest,
  });
  expect(accepted.result.isError).not.toBe(true);
  const approval = accepted.result.structuredContent.approval as { approvalId: string };
  const retried = await invoke("kogane.command.approve", {
    ...approveBody,
    step: "confirm",
    confirmationDigest: digest,
  });
  expect(retried.result.isError).not.toBe(true);
  expect(retried.result.structuredContent.approval.approvalId).toBe(approval.approvalId);
  expect(pipeline.fetch).toHaveBeenCalledTimes(1);
  const commitBody = {
    planId: plan.plan.planId,
    approvalId: approval.approvalId,
    operationId: "mcp-r2-commit",
  };
  const commitPrep = await invoke("kogane.command.commit", { ...commitBody, step: "prepare" });
  expect(commitPrep.result.isError).not.toBe(true);
  const commitDigest = commitPrep.result.structuredContent.confirmation.digest as string;
  const applied = await invoke("kogane.command.commit", {
    ...commitBody,
    step: "confirm",
    confirmationDigest: commitDigest,
  });
  expect(applied.result.isError).not.toBe(true);
  expect(applied.result.structuredContent.receipt.principal).toBe(PRINCIPAL);
  const repeated = await invoke("kogane.command.commit", {
    ...commitBody,
    step: "confirm",
    confirmationDigest: commitDigest,
  });
  expect(repeated.result.structuredContent.replayed).toBe(true);
  expect(pipeline.fetch).toHaveBeenCalledTimes(2);
  const rows = await env.DB.prepare(
    "SELECT operation,result,step,confirms_audit_id FROM audit_records WHERE principal=? AND idempotency_key IN ('mcp-r2-approve','mcp-r2-commit')",
  )
    .bind(PRINCIPAL)
    .all();
  expect(rows.results.filter((r) => r.result === "applied")).toHaveLength(2);
  expect(rows.results.filter((r) => r.result === "prepared")).toHaveLength(2);
  expect(rows.results.filter((r) => r.result === "replayed")).toHaveLength(2);
  expect(
    rows.results
      .filter((r) => r.result === "applied")
      .every((r) => r.step === "confirm" && r.confirms_audit_id),
  ).toBe(true);
  const original = await env.DB.prepare(
    "SELECT audit_id FROM audit_records WHERE principal=? AND operation='command.commit' AND idempotency_key='mcp-r2-commit' AND result='applied'",
  )
    .bind(PRINCIPAL)
    .first<{ audit_id: string }>();
  const reverse = await createPlan(
    "identity.release-override",
    {
      subject: "instrument",
      referenceId: "delegated-history-identifier",
      reason: "synthetic explicit reversal",
    },
    {
      actor: {
        id: OWNER,
        kind: "human",
        verification: "server",
        capabilities: ["interpretation.propose", "interpretation.accept"],
      },
      baseContextId: "identity-current-v1",
      now: new Date().toISOString(),
      ttlSeconds: 900,
    },
    d1CommandStore(env.DB),
  );
  if (!reverse.ok) throw new Error(reverse.error);
  const reverseApproval = {
    planId: reverse.plan.planId,
    planDigest: reverse.plan.planDigest,
    scope: [],
    idempotencyKey: "mcp-r2-reversal-approval",
  };
  const reversePrepare = await invoke("kogane.command.approve", {
    ...reverseApproval,
    step: "prepare",
  });
  const approvedReverse = await invoke("kogane.command.approve", {
    ...reverseApproval,
    step: "confirm",
    confirmationDigest: reversePrepare.result.structuredContent.confirmation.digest,
  });
  const reverseCommit = {
    planId: reverse.plan.planId,
    approvalId: approvedReverse.result.structuredContent.approval.approvalId as string,
    operationId: "mcp-r2-reversal",
    revertsAuditId: original!.audit_id,
  };
  const invalidReverse = await invoke("kogane.command.commit", {
    ...reverseCommit,
    revertsAuditId: "aud_11111111-2222-4333-8444-555555555555",
    step: "prepare",
  });
  expect(invalidReverse.result.structuredContent.error).toBe("revert_invalid");
  const reverseConfirmation = await invoke("kogane.command.commit", {
    ...reverseCommit,
    step: "prepare",
  });
  expect(reverseConfirmation.result.isError).not.toBe(true);
  const reversed = await invoke("kogane.command.commit", {
    ...reverseCommit,
    step: "confirm",
    confirmationDigest: reverseConfirmation.result.structuredContent.confirmation.digest,
  });
  expect(reversed.result.isError).not.toBe(true);
  const reversedRetry = await invoke("kogane.command.commit", {
    ...reverseCommit,
    step: "confirm",
    confirmationDigest: reverseConfirmation.result.structuredContent.confirmation.digest,
  });
  expect(reversedRetry.result.isError).not.toBe(true);
  expect(reversedRetry.result.structuredContent.replayed).toBe(true);
  expect(reversedRetry.result.structuredContent.receipt.operationId).toBe(
    reverseCommit.operationId,
  );
  const auditReverse = await env.DB.prepare(
    "SELECT reverts_audit_id,result FROM audit_records WHERE principal=? AND idempotency_key='mcp-r2-reversal' AND result='applied'",
  )
    .bind(PRINCIPAL)
    .first();
  expect(auditReverse).toEqual({ reverts_audit_id: original!.audit_id, result: "applied" });
  expect(
    await env.DB.prepare("SELECT audit_id FROM audit_records WHERE audit_id=?")
      .bind(original!.audit_id)
      .first(),
  ).not.toBeNull();
});

it("provider-contact requests use R2, pin human session policy, refuse expired preparation and roll back spent budget", async () => {
  vi.useRealTimers();
  const alreadySpent = await env.DB.prepare(
    "SELECT count(*) n FROM audit_records WHERE principal=? AND principal_kind='delegated' AND result IN ('applied','accepted') AND recorded_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')",
  )
    .bind(PRINCIPAL)
    .first<{ n: number }>();
  const declaration = {
    ...DECLARATION,
    role: "operator-delegate",
    scopes: { sources: ["sony-bank"], accounts: "*", scheduleSources: [] },
    capabilities: undefined,
    budget: { writesPerDay: alreadySpent!.n + 1 },
  };
  // Restrict additive operator capabilities through a maintainer declaration plus these two explicit capabilities.
  const configured = {
    ...declaration,
    role: "maintainer",
    capabilities: ["operations.collection.request", "operations.session.refresh"],
  };
  const configuration = {
    ...vars(JSON.stringify({ [PRINCIPAL]: configured })),
    OPS_API_ENABLED: "true",
    SESSION_REFRESH_POLICY: "",
  };
  const invoke = async (name: string, args: unknown, extra: Record<string, unknown> = {}) => {
    const response = await send("/mcp", rpcBody("tools/call", { name, arguments: args }), {
      ...configuration,
      ...extra,
    });
    return (await response.json()) as { result: { structuredContent: any; isError?: boolean } };
  };
  const request = {
    source: "sony-bank",
    requestedScope: { from: "2026-10-01", to: "2026-10-02" },
    idempotencyKey: "provider-r2-collection",
  };
  const prepared = await invoke("kogane.ops.collection.request", { ...request, step: "prepare" });
  expect(prepared.result.isError).not.toBe(true);
  expect(prepared.result.structuredContent.preview).toMatchObject({
    externalEffect: true,
    revertAvailable: false,
    status: "accepted",
  });
  const target = prepared.result.structuredContent.preview.targetRef as string;
  expect(
    await env.DB.prepare("SELECT operation_id FROM ops_requests WHERE operation_id=?")
      .bind(target)
      .first(),
  ).toBeNull();
  const expiredDigest = prepared.result.structuredContent.confirmation.digest as string;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.now() + 600_001));
  const expired = await invoke("kogane.ops.collection.request", {
    ...request,
    step: "confirm",
    confirmationDigest: expiredDigest,
  });
  expect(expired.result.structuredContent.error).toBe("confirmation_expired");
  expect(
    await env.DB.prepare("SELECT operation_id FROM ops_requests WHERE operation_id=?")
      .bind(target)
      .first(),
  ).toBeNull();
  vi.useRealTimers();
  const again = await invoke("kogane.ops.collection.request", { ...request, step: "prepare" });
  const accepted = await invoke("kogane.ops.collection.request", {
    ...request,
    step: "confirm",
    confirmationDigest: again.result.structuredContent.confirmation.digest,
  });
  expect(accepted.result.structuredContent).toEqual({ operationId: target, status: "accepted" });
  const replay = await invoke("kogane.ops.collection.request", {
    ...request,
    step: "confirm",
    confirmationDigest: again.result.structuredContent.confirmation.digest,
  });
  expect(replay.result.structuredContent).toEqual(accepted.result.structuredContent);
  const session = { source: "sony-bank", idempotencyKey: "provider-r2-session" };
  const sessionPrep = await invoke("kogane.ops.session.refresh", { ...session, step: "prepare" });
  expect(sessionPrep.result.structuredContent.preview).toMatchObject({
    status: "waiting_for_human",
    policy: "human",
  });
  const confirmationDigest = sessionPrep.result.structuredContent.confirmation.digest as string;
  const policyChanged = await invoke(
    "kogane.ops.session.refresh",
    { ...session, step: "confirm", confirmationDigest },
    { SESSION_REFRESH_POLICY: JSON.stringify({ "sony-bank": "unattended" }) },
  );
  expect(policyChanged.result.structuredContent.error).toBe("confirmation_invalid");
  const spent = await invoke("kogane.ops.session.refresh", {
    ...session,
    step: "confirm",
    confirmationDigest,
  });
  expect(spent.result.structuredContent.error).toBe("delegation_budget_exceeded");
  expect(
    await env.DB.prepare("SELECT operation_id FROM ops_requests WHERE operation_id=?")
      .bind(sessionPrep.result.structuredContent.preview.targetRef)
      .first(),
  ).toBeNull();
  const effects = await env.DB.prepare(
    "SELECT result,step,confirms_audit_id FROM audit_records WHERE principal=? AND delegation_ref=? AND result='accepted'",
  )
    .bind(
      PRINCIPAL,
      (await env.DB.prepare(
        "SELECT delegation_ref FROM audit_records WHERE operation='ops.collection.request' AND idempotency_key=? AND result='accepted'",
      )
        .bind(request.idempotencyKey)
        .first<{ delegation_ref: string }>())!.delegation_ref,
    )
    .all();
  expect(effects.results).toHaveLength(1);
  expect(effects.results[0]).toMatchObject({ result: "accepted", step: "confirm" });
  expect(effects.results[0]!.confirms_audit_id).toBeTruthy();
});
