// Native Worker/D1 and signed Access fixtures only; no production data or credentials.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { queryEconomicRowReadiness } from "../../../packages/application/src/query/economic-row-readiness.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const OWNER = "synthetic-readiness-owner";
const PRINCIPAL = `mcp-client:${OWNER}`;
const APP_AUD = "synthetic-readiness-browser";
const MCP_AUD = "synthetic-readiness-mcp";
const TOOL = "kogane.economic-readiness.read";
const GRANT = {
  capabilities: ["records.read"],
  scopes: { sources: "*", accounts: "*" },
  budget: { maxRows: 64, maxProposalTargets: 1, maxExplainDepth: 1 },
};
const PRIVATE = "synthetic-private-readiness-marker";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;
let row: { observationId: number; parseRunId: number };
const request = () => ({
  schema: "economic-row-readiness-v1",
  family: "bank-movement",
  knowledge: "current",
  rows: [row, { observationId: Number.MAX_SAFE_INTEGER, parseRunId: row.parseRunId }],
});
beforeAll(async () => {
  await seedRegistry();
  const run = await seedRun({ count: 1, source: "sony-bank" });
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'readiness-synthetic-parser','1','2030-01-01','ok','[]') RETURNING id`)
    .bind(run.artifacts[0].id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const observation = await env.DB.prepare(`INSERT INTO transaction_observations
    (parse_run_id,source_account,external_id,as_of,amount_minor,amount_text,amount_scale,
      currency,raw_locator,extra_json,description)
    VALUES (?,?,?,'2030-01-01',987654321,'987654321',0,'JPY',?, ?,?) RETURNING id`)
    .bind(parse!.id, PRIVATE, PRIVATE, PRIVATE, JSON.stringify({ private: PRIVATE }), PRIVATE)
    .first<{ id: number }>();
  row = { observationId: observation!.id, parseRunId: parse!.id };
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://readiness-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());
async function send(mcp: boolean, body: unknown, grant: unknown = GRANT, authenticated = true) {
  const headers: Record<string, string> = mcp
    ? { ...MCP_CLIENT_HEADERS, "mcp-protocol-version": "2025-11-25" }
    : { "content-type": "application/json" };
  if (authenticated)
    headers["cf-access-jwt-assertion"] = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(issuer)
      .setAudience(mcp ? MCP_AUD : APP_AUD)
      .setSubject(OWNER)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  return worker.fetch(
    new Request(`https://fixture.test${mcp ? "/mcp" : "/api/agent/v1/economic-readiness.read"}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: APP_AUD,
      ACCESS_MCP_AUDIENCE: MCP_AUD,
      AGENT_API_GRANTS: JSON.stringify({ [OWNER]: grant, [PRINCIPAL]: grant }),
      AGENT_GRANTS: "[]",
      OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
    } as Env,
  );
}
async function call(body: unknown, grant: unknown = GRANT) {
  const response = await send(
    true,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: TOOL, arguments: body } },
    grant,
  );
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    }
  ).result;
}
async function listed(grant: unknown = GRANT) {
  const response = await send(true, { jsonrpc: "2.0", id: 1, method: "tools/list" }, grant);
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      result: { tools: { name: string; inputSchema: Record<string, unknown> }[] };
    }
  ).result.tools;
}
async function financialSnapshot() {
  return env.DB.prepare(`SELECT
    (SELECT count(*) FROM economic_event_revisions) AS events,
    (SELECT count(*) FROM economic_claims) AS claims,
    (SELECT count(*) FROM economic_commit_log) AS commits,
    (SELECT count(*) FROM change_plans) AS plans,
    (SELECT count(*) FROM decision_revisions) AS decisions,
    (SELECT count(*) FROM transaction_observations) AS observations,
    (SELECT source_revision FROM core_source_revision WHERE id=1) AS sourceRevision`).first();
}
it("real D1 matches the shared S0 query over HTTP/MCP, retains missing reasons and writes only audit counts", async () => {
  const before = await financialSnapshot();
  const expected = await queryEconomicRowReadiness(d1Executor(env.DB), request());
  expect(expected.status).toBe("ok");
  const http = await send(false, request());
  const mcp = await call(request());
  expect(http.status).toBe(200);
  expect(mcp.isError).not.toBe(true);
  expect(await http.json()).toEqual(expected);
  expect(mcp.structuredContent).toEqual(expected);
  expect(mcp.structuredContent).toMatchObject({
    writerEnabled: false,
    proposalEnabled: false,
    historyCoverage: "unknown",
  });
  const text = JSON.stringify(mcp.structuredContent);
  expect(text).not.toContain(PRIVATE);
  expect(text).not.toContain("987654321");
  expect(text).toContain("observation_missing");
  const audit = await env.DB.prepare(`SELECT path,risk_class,result,result_code,diff_json,
    target_ref,refs_json FROM audit_records WHERE operation='economic-readiness.read' ORDER BY path`).all();
  expect(audit.results).toHaveLength(2);
  for (const entry of audit.results)
    expect(entry).toMatchObject({
      risk_class: "R0",
      result: "read",
      result_code: null,
      diff_json: '{"kind":"read","rows":2,"truncated":false}',
      target_ref: null,
      refs_json: "[]",
    });
  expect(JSON.stringify(audit.results)).not.toContain(PRIVATE);
  expect(await financialSnapshot()).toEqual(before);
});
it("listing and both transports enforce capability, each whole-store axis, strict input and row budget", async () => {
  expect((await listed()).some((tool) => tool.name === TOOL)).toBe(true);
  for (const [grant, code] of [
    [{ ...GRANT, capabilities: ["summary.read"] }, "unauthorized"],
    [{ ...GRANT, scopes: { sources: ["sony-bank"], accounts: "*" } }, "evidence_restricted"],
    [{ ...GRANT, scopes: { sources: "*", accounts: [PRIVATE] } }, "evidence_restricted"],
  ] as const) {
    expect((await listed(grant)).some((tool) => tool.name === TOOL)).toBe(false);
    const http = await send(false, request(), grant);
    const mcp = await call(request(), grant);
    expect(http.status).toBe(403);
    expect(mcp.isError).toBe(true);
    expect(await http.json()).toEqual(mcp.structuredContent);
    expect(mcp.structuredContent).toMatchObject({ code });
  }
  for (const [body, grant, code, status] of [
    [{ ...request(), owner: PRIVATE }, GRANT, "invalid_query", 400],
    [{ ...request(), rows: [row, row] }, GRANT, "invalid_query", 400],
    [{ ...request(), knowledge: "past" }, GRANT, "invalid_query", 400],
    [request(), { ...GRANT, budget: { ...GRANT.budget, maxRows: 1 } }, "budget_exceeded", 413],
  ] as const) {
    const http = await send(false, body, grant);
    const mcp = await call(body, grant);
    expect(http.status).toBe(status);
    expect(mcp.isError).toBe(true);
    expect(await http.json()).toEqual(mcp.structuredContent);
    expect(mcp.structuredContent).toMatchObject({ code });
    expect(JSON.stringify(mcp.structuredContent)).not.toContain(PRIVATE);
  }
  expect((await send(false, request(), GRANT, false)).status).toBe(401);
});
it("missing schema is a closed 503, while unauthorized/narrowed callers get the same refusal before and after", async () => {
  const deniedGrants = [
    { ...GRANT, capabilities: ["summary.read"] },
    { ...GRANT, scopes: { sources: ["sony-bank"], accounts: "*" } },
  ];
  const before = await Promise.all(deniedGrants.map((grant) => call(request(), grant)));
  const trigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_schema WHERE name='economic_claims_guard'",
  ).first<{ sql: string }>();
  await env.DB.prepare("DROP TRIGGER economic_claims_guard").run();
  try {
    for (const [index, grant] of deniedGrants.entries())
      expect(await call(request(), grant)).toEqual(before[index]);
    const http = await send(false, request());
    const mcp = await call(request());
    expect(http.status).toBe(503);
    expect(mcp.isError).toBe(true);
    expect(await http.json()).toEqual(mcp.structuredContent);
    expect(mcp.structuredContent).toEqual({
      status: "unavailable",
      reason: "readiness_store_unavailable",
    });
    const audit = await env.DB.prepare(`SELECT result,result_code FROM audit_records
      WHERE operation='economic-readiness.read' AND result='failed'`).all();
    expect(audit.results).toEqual([
      { result: "failed", result_code: "readiness_store_unavailable" },
      { result: "failed", result_code: "readiness_store_unavailable" },
    ]);
  } finally {
    await env.DB.prepare(trigger!.sql).run();
  }
});
