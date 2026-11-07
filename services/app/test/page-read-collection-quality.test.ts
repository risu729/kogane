// `kogane.collection-quality.summary`, `.cells` and `.accounts` (ADR 0081,
// ADR 0088): the collection quality page over MCP answers what
// `GET /api/collection-quality`, `/<source>` and `/<source>/accounts` answer,
// through the same service, with the same refusal codes. One synthetic Sony
// Bank capture is seeded through the ingest Worker; every value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_CAPABILITIES, type Grant } from "../../../packages/application/src/grants.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { pageReadMcpTools, PAGE_READ_ROUTES } from "../src/page-read-tools";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness, tableCounts } from "./page-read-harness";

const PATH = "/api/collection-quality";
const SUMMARY = "kogane.collection-quality.summary";
const CELLS = "kogane.collection-quality.cells";
const ACCOUNTS = "kogane.collection-quality.accounts";
const TOOLS = [SUMMARY, CELLS, ACCOUNTS] as const;
/** The page's authority: `evidence.read` over the whole store. */
const EVIDENCE_GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["evidence.read"],
  budget: { maxRows: 100, maxProposalTargets: 3, maxExplainDepth: 3 },
} as const;
/** Replaced per test where the store must lack the scheduling tables. */
const overrides: Record<string, unknown> = {};
const page = pageReadHarness("collection-quality-read", overrides);

/** A store before CORE 0065: the scheduling tables are absent. */
function withoutTables(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("collection_schedules")
              ? "SELECT 4 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  await seedRegistry();
  const run = await seedRun({ source: "sony-bank", count: 1, dataset: "yen-history-page-0001" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'sony-bank-history-json','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
});

describe("collection quality page reads", () => {
  it("answer the three collection quality routes, one each", () => {
    expect(PAGE_READ_ROUTES[SUMMARY]).toEqual(["/api/collection-quality"]);
    expect(PAGE_READ_ROUTES[CELLS]).toEqual(["/api/collection-quality/:source"]);
    expect(PAGE_READ_ROUTES[ACCOUNTS]).toEqual(["/api/collection-quality/:source/accounts"]);
  });

  it("are listed only to evidence.read over the whole store, so to every MCP client", async () => {
    for (let mask = 0; mask < 1 << AGENT_CAPABILITIES.length; mask++) {
      const capabilities = AGENT_CAPABILITIES.filter((_, bit) => mask & (1 << bit));
      for (const sources of ["*", ["sony-bank"]] as const)
        for (const accounts of ["*", ["synthetic-account"]] as const) {
          const grant = { ...EVIDENCE_GRANT, capabilities, scopes: { sources, accounts } } as Grant;
          const names = pageReadMcpTools(grant).map((tool) => tool.name);
          for (const tool of TOOLS)
            expect(names.includes(tool), `${tool} ${JSON.stringify(grant)}`).toBe(
              capabilities.includes("evidence.read") && sources === "*" && accounts === "*",
            );
        }
    }
    // Every MCP client holds the whole-store grant (ADR 0084).
    expect(await page.listed()).toEqual(expect.arrayContaining([...TOOLS]));
  });

  it("answer each read exactly as its route, and write nothing", async () => {
    const before = await tableCounts();
    for (const [query, tool, args] of [
      [PATH, SUMMARY, {}],
      [`${PATH}/sony-bank`, CELLS, { source: "sony-bank" }],
      [`${PATH}/sony-bank?offset=0`, CELLS, { source: "sony-bank", offset: 0 }],
      [`${PATH}/sony-bank?offset=500`, CELLS, { source: "sony-bank", offset: 500 }],
      // A known source with no capture: no cell.
      [`${PATH}/vpass`, CELLS, { source: "vpass" }],
      [`${PATH}/sony-bank/accounts`, ACCOUNTS, { source: "sony-bank" }],
      [`${PATH}/vpass/accounts`, ACCOUNTS, { source: "vpass" }],
    ] as const) {
      const served = await page.expectSameAnswer(query, tool, args);
      expect(served.status, query).toBe(200);
      // The web client's own wire check accepts the answer an agent reads under `data`.
      expect(validApiResponse(query.split("?")[0]!, served.body), query).toBe(true);
    }
    const cells = await page.mcp(CELLS, { source: "sony-bank" });
    expect(cells.body.data).toMatchObject({
      sourceId: "sony-bank",
      cells: [{ dataset: "yen-history-page-0001", state: "current" }],
    });
    // The seeded capture's observations have no identity run: no account is named.
    const accounts = await page.mcp(ACCOUNTS, { source: "sony-bank" });
    expect(accounts.body.data).toMatchObject({ sourceId: "sony-bank", cells: 1, accounts: [] });
    expect(await tableCounts()).toEqual(before);
  });

  it("refuse what the route refuses, with the route's status and code", async () => {
    for (const [query, tool, args] of [
      [`${PATH}/no-such-source`, CELLS, { source: "no-such-source" }],
      // The test-owned synthetic source is never a financial source.
      [`${PATH}/kogane-synthetic`, CELLS, { source: "kogane-synthetic" }],
      [`${PATH}/kogane-synthetic?offset=500`, CELLS, { source: "kogane-synthetic", offset: 500 }],
      [`${PATH}/no-such-source/accounts`, ACCOUNTS, { source: "no-such-source" }],
    ] as const) {
      const refused = await page.expectSameAnswer(query, tool, args);
      expect(refused.status, query).toBe(404);
      expect(refused.body, query).toMatchObject({ error: "not_found" });
    }
  });

  it("refuse a store without the scheduling tables on every read, as the route does", async () => {
    overrides["DB"] = withoutTables(env.DB);
    try {
      for (const [query, tool, args] of [
        [PATH, SUMMARY, {}],
        [`${PATH}/sony-bank`, CELLS, { source: "sony-bank" }],
        [`${PATH}/sony-bank/accounts`, ACCOUNTS, { source: "sony-bank" }],
      ] as const) {
        const refused = await page.expectSameAnswer(query, tool, args);
        expect(refused.status, query).toBe(404);
        expect(refused.body, query).toMatchObject({ error: "not_found" });
      }
    } finally {
      delete overrides["DB"];
    }
  });

  it("refuse an argument outside the closed schema before any read", async () => {
    for (const [tool, args] of [
      [SUMMARY, { source: "sony-bank" }],
      [SUMMARY, { offset: 0 }],
      [CELLS, {}],
      [CELLS, { source: "Sony_Bank" }],
      [CELLS, { source: "sony-bank/accounts" }],
      [CELLS, { source: "sony-bank", offset: -1 }],
      [CELLS, { source: "sony-bank", offset: 1.5 }],
      [CELLS, { source: "sony-bank", offset: "500" }],
      // The route's offset has at most seven digits.
      [CELLS, { source: "sony-bank", offset: 10_000_000 }],
      [CELLS, { source: "sony-bank", limit: 5 }],
      [ACCOUNTS, {}],
      [ACCOUNTS, { source: "Sony_Bank" }],
      [ACCOUNTS, { source: "sony-bank", offset: 0 }],
    ] as const) {
      const label = `${tool} ${JSON.stringify(args)}`;
      const overHttp = await page.http(tool, args);
      expect(overHttp.status, label).toBe(400);
      expect(overHttp.body, label).toMatchObject({ error: "invalid_request" });
      const overMcp = await page.mcp(tool, args);
      expect(overMcp.isError, label).toBe(true);
      expect(overMcp.body, label).toEqual(overHttp.body);
    }
  });

  it("refuse a grant without evidence.read or narrower than the whole store", async () => {
    for (const [grant, expected] of [
      [
        { ...EVIDENCE_GRANT, capabilities: ["summary.read", "records.read"] },
        { code: "unauthorized", refs: ["capability:evidence.read"] },
      ],
      [
        { ...EVIDENCE_GRANT, scopes: { sources: ["sony-bank"], accounts: "*" } },
        { code: "evidence_restricted", refs: ["scope:source"] },
      ],
      [
        { ...EVIDENCE_GRANT, scopes: { sources: "*", accounts: ["synthetic-account"] } },
        { code: "evidence_restricted", refs: ["scope:account"] },
      ],
    ] as const) {
      // The grant is graded first: even a malformed argument gets the grant's
      // refusal. No deployment configures such a grant (ADR 0084), so it is
      // given to the shared service both transports call.
      for (const [tool, args] of [
        [SUMMARY, {}],
        [CELLS, { source: "sony-bank" }],
        [CELLS, { source: "Sony_Bank" }],
        [ACCOUNTS, { source: "sony-bank" }],
      ] as const) {
        const answer = await page.direct(tool, args, grant);
        expect(answer.status, `${tool} ${JSON.stringify(grant)}`).toBe(403);
        expect(answer.body).toMatchObject(expected);
      }
    }
  });

  it("record each agent call as an R0 read with its row count only (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const sources = ((await page.route(PATH)).body as { sources: unknown[] }).sources.length;
    expect((await page.http(SUMMARY, {})).status).toBe(200);
    expect((await page.mcp(CELLS, { source: "sony-bank" })).isError).toBe(false);
    expect((await page.http(CELLS, { source: "vpass" })).status).toBe(200);
    expect((await page.mcp(ACCOUNTS, { source: "sony-bank" })).isError).toBe(false);
    const rows = (
      await env.DB.prepare(
        `SELECT operation,path,principal,risk_class,result,diff_json FROM audit_records
          WHERE operation LIKE 'collection-quality.%' AND rowid>? ORDER BY rowid`,
      )
        .bind(last)
        .all<Record<string, unknown>>()
    ).results;
    const read = (count: number) => JSON.stringify({ kind: "read", rows: count, truncated: false });
    const http = { path: "agent-http", principal: "synthetic-agent" };
    const mcp = { path: "mcp", principal: "mcp-client:synthetic-agent" };
    const recorded = { risk_class: "R0", result: "read" };
    expect(rows).toEqual([
      { operation: "collection-quality.summary", ...http, ...recorded, diff_json: read(sources) },
      { operation: "collection-quality.cells", ...mcp, ...recorded, diff_json: read(1) },
      // The vpass page: no capture, no cell.
      { operation: "collection-quality.cells", ...http, ...recorded, diff_json: read(0) },
      // The account read counts the cells it regrouped.
      { operation: "collection-quality.accounts", ...mcp, ...recorded, diff_json: read(1) },
    ]);
    // Counts and closed codes only: never a source, a job or a reason.
    const text = JSON.stringify(rows);
    for (const value of ["sony-bank", "vpass", "schedule_never_ran", "yen-history"])
      expect(text).not.toContain(value);
  });

  // Last: it adds configured jobs to this file's store.
  it("refuse the summary past the row bound whole, with the route's 413", async () => {
    await env.DB.batch(
      Array.from({ length: 201 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by)
           VALUES(?,NULL,'processor',0,1,'UTC','{"kind":"interval","minutes":60}','2099-01-01T00:00:00.000Z','synthetic')`,
        ).bind(`synthetic-${index}`),
      ),
    );
    const refused = await page.expectSameAnswer(PATH, SUMMARY, {});
    expect(refused.status).toBe(413);
    expect(refused.body).toMatchObject({ error: "result_limit_exceeded" });
    // One source's cells do not read the jobs and are still answered.
    expect(
      (await page.expectSameAnswer(`${PATH}/sony-bank`, CELLS, { source: "sony-bank" })).status,
    ).toBe(200);
  });
});
