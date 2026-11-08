// Card statements without a settlement candidate over the real Worker and the
// real CORE migrations: `GET /api/v2/reconciliation/card-statements-unmatched`
// for the operator's カード照合 page and `kogane.card-settlements.unmatched`
// for an agent answer one page of one read (docs/card-settlements.md,
// Statements without a candidate). The store holds one MyJCB statement total
// and no bank debit. The codes and the planner's answers are exercised on the
// complete schema in services/processor/test/card-statements-unmatched.test.ts.
// Every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validUnmatchedCardStatementsReview } from "../../../packages/observation-shared/src/card-statements-unmatched-contract";
import worker from "../src/worker";
import { callTool, toolContext } from "../src/agent-service";
import { readMcpTools } from "../src/read-tools";
import type { Grant } from "../../../packages/application/src/index";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const PATH = "/api/v2/reconciliation/card-statements-unmatched";
const AGENT_PATH = "/api/agent/v1/card-settlements.unmatched";
const TOOL = "kogane.card-settlements.unmatched";
const FULL_GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read"],
  budget: { maxRows: 500, maxProposalTargets: 5, maxExplainDepth: 3 },
};
const MCP_AUDIENCE = "fixture-mcp-audience";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources(producer_id,source_id) VALUES('evidence-test','myjcb')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test','evidence-test','myjcb')",
    ),
  ]);
  const run = await seedRun({ source: "myjcb", count: 1 });
  const parse =
    await env.DB.prepare(`INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES(?,'myjcb-credit-statement-total','1','2099-01-12T00:00:00Z','ok','[]') RETURNING id`)
      .bind(run.artifacts[0]!.id)
      .first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
    VALUES(?,'myjcb:synthetic:root','credit_statement_payment_amount',4000,'4000',0,'JPY','2099-01-01','synthetic-total',?)`)
    .bind(
      parse!.id,
      JSON.stringify({
        _kogane: {
          period: "2099-01",
          paymentDate: "2099-01-10",
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  await publishParse(parse!.id);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://unmatched-statements-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  schemaAhead = false;
});

/**
 * A deployment whose code is ahead of its CORE schema: the settlement views'
 * `sqlite_master` check (`cardSettlementsAvailable`) finds nothing, so the
 * カード照合 routes are not served. Every other statement runs as given.
 */
let schemaAhead = false;
function withoutSettlementViews(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("card_settlement_reviews")
              ? "SELECT 0 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

interface CallOptions {
  method?: string;
  body?: unknown;
  subject?: string | null;
}

async function call(path: string, options: CallOptions = {}) {
  const subject = options.subject === undefined ? "synthetic-operator" : options.subject;
  const token =
    subject === null
      ? null
      : await new SignJWT({ type: "app" })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setIssuer(issuer)
          .setAudience(path === "/mcp" ? MCP_AUDIENCE : "fixture-audience")
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey);
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(token ? { "cf-access-jwt-assertion": token } : {}),
      ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return worker.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    DB: schemaAhead ? withoutSettlementViews(env.DB) : env.DB,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
    OPERATOR_SUBJECTS: '["synthetic-operator"]',
    AGENT_GRANTS: '["synthetic-agent"]',
  } as Env);
}

async function mcp(message: Record<string, unknown>, options: CallOptions = {}) {
  const response = await call("/mcp", {
    subject: "synthetic-agent",
    ...options,
    body: { jsonrpc: "2.0", id: 1, ...message },
  });
  return (await response.json()) as Record<string, any>;
}

/** Every table's row count but the audit tables (an agent call's own record is its one write). */
async function tables() {
  const names = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of names.results.filter(
    ({ name }) => name !== "audit_records" && name !== "audit_overflow_counters",
  ))
    counts[name] = (await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<number>(
      "n",
    ))!;
  return counts;
}

describe("GET /api/v2/reconciliation/card-statements-unmatched", () => {
  it("serves the operator the page with each statement's closed reason, and writes nothing", async () => {
    const before = await tables();
    const response = await call(PATH);
    expect(response.status).toBe(200);
    const page = (await response.json()) as Record<string, any>;
    expect(validUnmatchedCardStatementsReview(page)).toBe(true);
    expect(page).toMatchObject({
      apiVersion: 2,
      schemaVersion: "kogane-card-statements-unmatched-v1",
      query: { offset: 0 },
      nextOffset: null,
      items: [
        {
          statement: { sourceId: "myjcb", period: "2099-01" },
          code: "no_debit_in_window",
          debitsInWindow: 0,
          planner: null,
          acceptable: false,
        },
      ],
    });
    expect(await tables()).toEqual(before);
  });

  it("is operator-only, GET-only, and refuses an unknown, repeated or malformed parameter", async () => {
    expect((await call(PATH, { subject: "synthetic-reader" })).status).toBe(403);
    expect((await call(PATH, { subject: null })).status).toBe(401);
    expect((await call(PATH, { method: "POST", body: {} })).status).toBe(405);
    for (const [query, code] of [
      ["?source=myjcb", "invalid_query"],
      ["?offset=0&offset=50", "invalid_query"],
      ["?offset=-1", "invalid_offset"],
      ["?offset=1e3", "invalid_offset"],
    ] as const) {
      const response = await call(`${PATH}${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: code });
    }
  });
});

// No table configures a grant any more (ADR 0084). A narrower grant is given
// to the shared service directly, which is where it is graded.
const narrow = (grant: Record<string, unknown>) =>
  ({ principal: "mcp-client:synthetic-agent", ...FULL_GRANT, ...grant }) as Grant;
const direct = (body: unknown, grant: Record<string, unknown>) =>
  callTool(TOOL, body, toolContext(env as Env, narrow(grant), "2026-11-07T00:00:00Z"));

describe("kogane.card-settlements.unmatched", () => {
  it("answers the same page over HTTP and MCP, and is listed to a whole-store records.read grant only", async () => {
    const listed = await mcp({ method: "tools/list" });
    expect(listed["result"].tools.map((tool: { name: string }) => tool.name)).toContain(TOOL);
    const summaryOnly = readMcpTools(narrow({ capabilities: ["summary.read"] }), {
      reportedState: true,
      cardSettlements: true,
    });
    expect(summaryOnly.map((tool) => tool.name)).not.toContain(TOOL);
    const overRoute = await (await call(PATH)).json();
    const overAgent = await call(AGENT_PATH, { subject: "synthetic-agent", body: {} });
    expect(overAgent.status).toBe(200);
    expect(await overAgent.json()).toEqual(overRoute);
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: { offset: 0 } },
    });
    expect(overMcp["result"].isError).toBe(false);
    expect(overMcp["result"].structuredContent).toEqual(overRoute);
  });

  it("is absent, not refused, while the route is not served, on both transports (ADR 0081)", async () => {
    schemaAhead = true;
    expect((await call(PATH)).status).toBe(404);
    const listed = await mcp({ method: "tools/list" });
    expect(listed["result"].tools.map((tool: { name: string }) => tool.name)).not.toContain(TOOL);
    expect(
      readMcpTools(narrow({}), { reportedState: true, cardSettlements: false }).map(
        (tool) => tool.name,
      ),
    ).not.toContain(TOOL);
    expect((await call(AGENT_PATH, { subject: "synthetic-agent", body: {} })).status).toBe(404);
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: {} },
    });
    expect(JSON.stringify(overMcp)).toContain("unknown_tool");
  });

  it("is graded by the agent's grant and its strict input, and writes nothing", async () => {
    const before = await tables();
    const summary = await direct({}, { capabilities: ["summary.read"] });
    expect(summary.status).toBe(403);
    expect(summary.body).toMatchObject({
      code: "unauthorized",
      refs: ["capability:records.read"],
    });
    const narrowed = await direct({}, { scopes: { sources: ["myjcb"], accounts: "*" } });
    expect(narrowed.status).toBe(403);
    expect(narrowed.body).toMatchObject({
      code: "evidence_restricted",
      refs: ["scope:source"],
    });
    const deep = await direct({ offset: 500 }, {});
    expect(deep.status).toBe(413);
    expect(deep.body).toMatchObject({
      code: "budget_exceeded",
      refs: ["budget:maxRows=500"],
    });
    // The whole-store grant's own bound, over the route.
    const past = await call(AGENT_PATH, { subject: "synthetic-agent", body: { offset: 1000 } });
    expect(past.status).toBe(413);
    const unknownKey = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: { source: "x" },
    });
    expect(unknownKey.status).toBe(400);
    expect(await tables()).toEqual(before);
  });

  it("records each served agent call as one read of the page's items (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    expect((await call(AGENT_PATH, { subject: "synthetic-agent", body: {} })).status).toBe(200);
    const records = (
      await env.DB.prepare(
        "SELECT path,risk_class,result,diff_json FROM audit_records WHERE operation='card-settlements.unmatched' AND rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    expect(records).toEqual([
      {
        path: "agent-http",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({ kind: "read", rows: 1, truncated: false }),
      },
    ]);
  });
});
