// `GET /api/v2/reported-state`: behind Access, served to any signed-in reader,
// GET-only, absent where the store lacks the views it joins, bounded, and
// writing nothing; and its agent tool `kogane.reported-state.read` on both
// agent paths. One synthetic SMBC balance snapshot is seeded through the
// ingest Worker; every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { READ_MCP_TOOLS, REPORTED_STATE_TOOL_NAME } from "../src/read-tools";
import { reportedStateAvailable } from "../src/reported-state-api";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const PATH = "/api/v2/reported-state";
const TOOL_PATH = "/api/agent/v1/reported-state.read";
/** The MCP Access application's audience (ADR 0047); `/mcp` accepts nothing else. */
const MCP_AUDIENCE = "fixture-mcp-audience";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
let today = "";

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test','smbc-bank')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test','smbc-bank')",
    ),
  ]);
  const run = await seedRun({ source: "smbc-bank", count: 1, dataset: "balance-normalized" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'smbc-direct-balance','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.prepare(
    `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,raw_locator,extra_json)
     VALUES(?,'smbc-bank:ordinary-yen','account_balance',4321,'4321',0,'JPY','json:$.balance','{}')`,
  )
    .bind(parse!.id)
    .run();
  const captured = await env.DB.prepare(
    "SELECT fetched_at FROM observation_fetch_artifacts WHERE id=?",
  )
    .bind(run.artifacts[0]!.id)
    .first<{ fetched_at: string }>();
  today = new Date(Date.parse(captured!.fetched_at) + 9 * 3_600_000).toISOString().slice(0, 10);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://reported-state-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** A store before CORE 0044: the statement and settlement views are absent. */
function withoutViews(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("card_statement_facts")
              ? "SELECT 2 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A store past the row bound: the balance read yields one row more than 5,000. */
function overfull(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("CROSS JOIN balance_observations b")
              ? "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5001) SELECT i AS id FROM n WHERE ?1 IS NOT NULL"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function call(
  path: string,
  options: {
    subject?: string | null;
    method?: string;
    schema?: boolean;
    full?: boolean;
    body?: unknown;
    environment?: Record<string, unknown>;
  } = {},
) {
  const subject = options.subject === undefined ? "synthetic-reader" : options.subject;
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
      // What an MCP client sends on every POST (Streamable HTTP).
      ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return worker.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    DB: options.schema === false ? withoutViews(env.DB) : options.full ? overfull(env.DB) : env.DB,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
    OPERATOR_SUBJECTS: '["synthetic-operator"]',
    ...options.environment,
  } as Env);
}

async function counts() {
  return env.DB.prepare(
    `SELECT (SELECT count(*) FROM parse_runs) AS parses,
      (SELECT count(*) FROM balance_observations) AS balances,
      (SELECT count(*) FROM decision_revisions) AS decisions,
      (SELECT count(*) FROM card_settlement_candidates) AS candidates,
      (SELECT source_revision FROM core_source_revision WHERE id=1) AS source_revision`,
  ).first();
}

describe("reported state on a date", () => {
  it("serves a signed-in reader the validated state and writes nothing", async () => {
    const before = await counts();
    const response = await call(`${PATH}?date=${today}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(validApiResponse(PATH, body)).toBe(true);
    expect(body).toMatchObject({
      apiVersion: 2,
      schemaVersion: "reported-state-v1",
      date: today,
      zone: "Asia/Tokyo",
      accounts: [
        {
          sourceId: "smbc-bank",
          sourceAccount: "smbc-bank:ordinary-yen",
          accountId: null,
          identityStatus: "not-recorded",
          snapshots: [{ sourceId: "smbc-bank", ageDays: 0, freshness: "same-day" }],
          balances: [
            {
              providerMetric: "account_balance",
              metric: { metricId: "deposit.balance", aggregationRule: "sum-disjoint" },
              amount: {
                unitRef: "JPY",
                value: { status: "exact", value: { coefficient: "4321" } },
              },
            },
          ],
        },
      ],
      payables: [],
      coverage: { liabilitiesCoverage: "partial", netAssets: "not-computed" },
    });
    // The day before the capture: nothing held, the container named as missing.
    const earlier = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const empty = (await (await call(`${PATH}?date=${earlier}`)).json()) as {
      accounts: unknown[];
      coverage: { containersWithoutSnapshot: { parserName: string }[] };
    };
    expect(empty.accounts).toEqual([]);
    expect(empty.coverage.containersWithoutSnapshot.map((c) => c.parserName)).toContain(
      "smbc-direct-balance",
    );
    expect(await counts()).toEqual(before);
  });

  it("answers any signed-in subject and refuses an anonymous one", async () => {
    expect((await call(`${PATH}?date=${today}`, { subject: null })).status).toBe(401);
    for (const subject of ["synthetic-operator", "another-reader"])
      expect((await call(`${PATH}?date=${today}`, { subject })).status).toBe(200);
  });

  it("is GET-only", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await call(`${PATH}?date=${today}`, { method })).status).toBe(405);
    expect((await call(`${PATH}?date=${today}`, { method: "HEAD" })).status).toBe(200);
  });

  it("validates the date and the filters", async () => {
    for (const query of [
      "",
      "?date=",
      "?date=2026-02-30",
      "?date=20260910",
      "?date=2026-09-10&date=2026-09-11",
      "?date=2999-01-01",
      "?date=2026-09-10&offset=0",
      "?date=2026-09-10&source=SMBC",
      "?date=2026-09-10&account=%20x",
    ])
      expect((await call(PATH + query)).status).toBe(400);
    expect((await call(`${PATH}?date=2999-01-01`)).status).toBe(400);
    const filtered = await call(`${PATH}?date=${today}&source=smbc-bank&account=acct-unknown`);
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { accounts: unknown[] }).accounts).toEqual([]);
  });

  it("refuses a read past the row bound with 413 rather than a cut answer", async () => {
    const response = await call(`${PATH}?date=${today}`, { full: true });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "result_limit_exceeded" });
  });

  it("does not exist, and is not advertised, where the store lacks its views", async () => {
    expect((await call(`${PATH}?date=${today}`, { schema: false })).status).toBe(404);
    expect(await reportedStateAvailable(env as Env)).toBe(true);
    expect(await reportedStateAvailable({ ...env, DB: withoutViews(env.DB) } as Env)).toBe(false);
    const meta = async (schema: boolean) =>
      ((await (await call("/api/meta", { schema })).json()) as { capabilities: unknown })
        .capabilities;
    expect(await meta(true)).toMatchObject({ reportedStateOnDate: true });
    expect(await meta(false)).toMatchObject({ reportedStateOnDate: false });
  });
});

describe("the agent tool", () => {
  // Every proved caller reads with the whole-store grant (ADR 0084).
  const granted = {};
  const listed = async (environment: Record<string, unknown>, schema = true) =>
    (
      (await (
        await call("/mcp", {
          subject: "agent-principal",
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          environment,
          schema,
        })
      ).json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name);
  const mcpCall = async (
    args: unknown,
    options: { environment?: Record<string, unknown>; schema?: boolean; full?: boolean } = {},
  ) =>
    (await (
      await call("/mcp", {
        subject: "agent-principal",
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: REPORTED_STATE_TOOL_NAME, arguments: args },
        },
        environment: options.environment ?? granted,
        ...(options.schema === undefined ? {} : { schema: options.schema }),
        ...(options.full === undefined ? {} : { full: options.full }),
      })
    ).json()) as {
      result?: { isError: boolean; structuredContent: Record<string, unknown> };
      error?: { code: number; message: string };
    };

  it("answers on both agent paths exactly what the route answers, and writes nothing", async () => {
    const before = await counts();
    const route = (await (await call(`${PATH}?date=${today}`)).json()) as Record<string, unknown>;
    const http = await call(TOOL_PATH, {
      subject: "agent-principal",
      body: { date: today },
      environment: granted,
    });
    expect(http.status).toBe(200);
    const httpBody = (await http.json()) as Record<string, unknown>;
    expect(httpBody).toEqual(route);
    expect(validApiResponse(PATH, httpBody)).toBe(true);
    const viaMcp = await mcpCall({ date: today });
    expect(viaMcp.result?.isError).toBe(false);
    expect(viaMcp.result?.structuredContent).toEqual(route);
    // The filters are the route's own.
    const filteredRoute = (await (
      await call(`${PATH}?date=${today}&source=smbc-bank&account=acct-unknown`)
    ).json()) as Record<string, unknown>;
    const filtered = await mcpCall({ date: today, source: "smbc-bank", account: "acct-unknown" });
    expect(filtered.result?.structuredContent).toEqual(filteredRoute);
    expect(filtered.result!.structuredContent["accounts"]).toEqual([]);
    expect(await counts()).toEqual(before);
  });

  it("is listed with the route's parameters to every MCP client while the route is served", async () => {
    const tool = READ_MCP_TOOLS.find((entry) => entry.name === REPORTED_STATE_TOOL_NAME)!;
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["date"],
      properties: {
        date: { type: "string" },
        source: { type: "string" },
        account: { type: "string" },
      },
    });
    expect(Object.keys(tool.inputSchema["properties"] as object).sort()).toEqual([
      "account",
      "date",
      "source",
    ]);
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(await listed(granted)).toContain(REPORTED_STATE_TOOL_NAME);
    expect(await listed(granted, false)).not.toContain(REPORTED_STATE_TOOL_NAME);
  });

  it("refuses with the route's codes and the same status on both agent paths", async () => {
    const cases: [unknown, number, Record<string, unknown>][] = [
      [{ date: "2026-02-30" }, 400, { error: "invalid_date" }],
      [{ date: "2999-01-01" }, 400, { error: "date_in_future" }],
      [{ date: "20260910" }, 400, { error: "invalid_request" }],
      [{}, 400, { error: "invalid_request" }],
      [{ date: today, source: "SMBC" }, 400, { error: "invalid_request" }],
      [{ date: today, account: " x" }, 400, { error: "invalid_request" }],
      [{ date: today, offset: 0 }, 400, { error: "invalid_request" }],
    ];
    for (const [args, status, expected] of cases) {
      const http = await call(TOOL_PATH, {
        subject: "agent-principal",
        body: args,
        environment: granted,
      });
      expect(http.status, JSON.stringify(args)).toBe(status);
      expect(await http.json(), JSON.stringify(args)).toEqual(expected);
      const viaMcp = await mcpCall(args);
      expect(viaMcp.result?.isError, JSON.stringify(args)).toBe(true);
      expect(viaMcp.result?.structuredContent, JSON.stringify(args)).toEqual(expected);
    }
    // Past the row bound: refused, never cut.
    const full = await call(TOOL_PATH, {
      subject: "agent-principal",
      body: { date: today },
      environment: granted,
      full: true,
    });
    expect(full.status).toBe(413);
    expect(await full.json()).toEqual({ error: "result_limit_exceeded" });
    expect((await mcpCall({ date: today }, { full: true })).result?.structuredContent).toEqual({
      error: "result_limit_exceeded",
    });
  });

  it("needs an Access identity", async () => {
    // No Access identity.
    expect(
      (await call(TOOL_PATH, { subject: null, body: { date: today }, environment: granted }))
        .status,
    ).toBe(401);
  });

  it("is neither a tool nor a path where the route is absent", async () => {
    expect((await mcpCall({ date: today }, { schema: false })).error).toEqual({
      code: -32602,
      message: "unknown_tool",
    });
    expect(
      (
        await call(TOOL_PATH, {
          subject: "agent-principal",
          body: { date: today },
          environment: granted,
          schema: false,
        })
      ).status,
    ).toBe(404);
  });

  it("records each served call as an R0 read with row counts only, and nothing where it is absent (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const records = async () =>
      (
        await env.DB.prepare(
          "SELECT path,principal,subject,principal_kind,operation,risk_class,result,diff_json FROM audit_records WHERE rowid>? ORDER BY rowid",
        )
          .bind(last)
          .all()
      ).results;
    await mcpCall({ date: today }, { schema: false });
    await call(TOOL_PATH, {
      subject: "agent-principal",
      body: { date: today },
      environment: granted,
      schema: false,
    });
    expect(await records()).toEqual([]);
    expect(
      (
        await call(TOOL_PATH, {
          subject: "agent-principal",
          body: { date: today },
          environment: granted,
        })
      ).status,
    ).toBe(200);
    await mcpCall({ date: today });
    // One account and no payables: one row, and no amount, account or date.
    const read = {
      principal_kind: "agent",
      operation: "reported-state.read",
      risk_class: "R0",
      result: "read",
      diff_json: '{"kind":"read","rows":1,"truncated":false}',
    };
    expect(await records()).toEqual([
      { path: "agent-http", principal: "agent-principal", subject: "agent-principal", ...read },
      { path: "mcp", principal: "mcp-client:agent-principal", subject: "agent-principal", ...read },
    ]);
  });
});
