// `kogane.identity.read` (ADR 0081): the identity pages over MCP answer what
// `GET /api/identity/<collection>` answers, through the route's own reader.
// Every value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_CAPABILITIES, type Grant } from "../../../packages/application/src/grants.ts";
import { validIdentityResponse } from "../../../packages/observation-shared/src/identity-contract";
import { pageReadMcpTools, PAGE_READ_ROUTES } from "../src/page-read-tools";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness, RECORDS_GRANT, tableCounts } from "./page-read-harness";

const TOOL = "kogane.identity.read";
/** A provider label that must reach an agent only under `data`. */
const CONNECTION_LABEL = "Synthetic Bank (via aggregator)";
const page = pageReadHarness("identity-read");

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources(producer_id,source_id) VALUES('evidence-test','moneyforward-me')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test','evidence-test','moneyforward-me')",
    ),
  ]);
  const detail = await seedRun({
    source: "moneyforward-me",
    count: 1,
    dataset: "account-detail",
    fetchUnitKey: "synthetic-connection",
  });
  await env.DB.prepare(`INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,
    related_source_id,reason,verifier_version,detail_artifact_id,direct_reference_ids_json,created_at)
    VALUES('evidence-test','synthetic-connection',1,?,'unresolved','smbc-bank',
    'synthetic reason','fixture',?,'[]','2099')`)
    .bind(CONNECTION_LABEL, detail.artifacts[0]!.id)
    .run();
  const run = await seedRun({ count: 1, source: "other-test" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'identity-fixture','1','2099-01-01','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const observation = await env.DB.prepare(
    `INSERT INTO transaction_observations (parse_run_id,source_account,currency,raw_locator,extra_json) VALUES (?,'synthetic-ref','JPY','synthetic','{}') RETURNING id`,
  )
    .bind(parse!.id)
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO source_accounts VALUES ('ref','other-test','evidence-test','["synthetic-ref"]')`,
    ),
    env.DB.prepare(`INSERT INTO accounts VALUES ('account','Initial','cash','provider-local')`),
    env.DB.prepare(
      `INSERT INTO account_mappings VALUES ('am1','ref',1,'account','rule','initial',1,'2099','Initial','provider-local')`,
    ),
    env.DB.prepare(
      `INSERT INTO instruments VALUES ('instrument','money','Initial unit','provider-local')`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_identifiers VALUES ('identifier','iso4217','global','JPY','{}')`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_mappings VALUES ('im1','identifier',1,'instrument','rule','initial',1,'2099','Initial unit','provider-local')`,
    ),
    env.DB.prepare(`INSERT INTO identity_runs VALUES ('ir',?,1,'2099')`).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO identity_observations VALUES ('io','ir','transaction',?,'ref','am1','[]')`,
    ).bind(observation!.id),
    env.DB.prepare(`INSERT INTO identity_instrument_uses VALUES ('io','unit','identifier','im1')`),
    env.DB.prepare(`INSERT INTO identity_run_seals VALUES ('ir',1,'2099')`),
    env.DB.prepare(
      `INSERT INTO account_mappings VALUES ('am2','ref',2,'account','manual','confirmed-account',1,'2099','Updated account','identified')`,
    ),
  ]);
});

describe("kogane.identity.read", () => {
  it("answers the four identity routes", () => {
    expect(PAGE_READ_ROUTES[TOOL]).toEqual([
      "/api/identity/connections",
      "/api/identity/accounts",
      "/api/identity/instruments",
      "/api/identity/coverage",
    ]);
  });

  it("is listed only to records.read over the whole store", async () => {
    for (let mask = 0; mask < 1 << AGENT_CAPABILITIES.length; mask++) {
      const capabilities = AGENT_CAPABILITIES.filter((_, bit) => mask & (1 << bit));
      for (const sources of ["*", ["other-test"]] as const)
        for (const accounts of ["*", ["ref"]] as const) {
          const grant = { ...RECORDS_GRANT, capabilities, scopes: { sources, accounts } } as Grant;
          expect(
            pageReadMcpTools(grant).some((tool) => tool.name === TOOL),
            JSON.stringify(grant),
          ).toBe(capabilities.includes("records.read") && sources === "*" && accounts === "*");
        }
    }
    // Every MCP client holds the whole-store grant (ADR 0084).
    expect(await page.listed()).toContain(TOOL);
  });

  it("answers each collection exactly as its route, and writes nothing", async () => {
    const before = await tableCounts();
    for (const [query, args] of [
      ["/api/identity/connections", { collection: "connections" }],
      ["/api/identity/accounts", { collection: "accounts" }],
      [
        "/api/identity/accounts?identityRead=as-recorded",
        { collection: "accounts", identityRead: "as-recorded" },
      ],
      [
        "/api/identity/accounts?source=other-test&offset=0",
        { collection: "accounts", source: "other-test", offset: 0 },
      ],
      ["/api/identity/accounts?source=absent", { collection: "accounts", source: "absent" }],
      ["/api/identity/instruments", { collection: "instruments" }],
      ["/api/identity/coverage", { collection: "coverage" }],
      [
        "/api/identity/coverage?identityRead=as-recorded",
        { collection: "coverage", identityRead: "as-recorded" },
      ],
    ] as const) {
      const served = await page.expectSameAnswer(query, TOOL, args);
      expect(served.status, query).toBe(200);
      expect(validIdentityResponse(query.split("?")[0]!, served.body), query).toBe(true);
    }
    const accounts = await page.mcp(TOOL, { collection: "accounts" });
    expect(accounts.body.data.rows).toMatchObject([
      { revision: 2, status: "identified", label: "Updated account" },
    ]);
    expect(await tableCounts()).toEqual(before);
  });

  it("carries provider text only under data", async () => {
    const connections = await page.mcp(TOOL, { collection: "connections" });
    expect(connections.body.data.connections).toMatchObject([{ label: CONNECTION_LABEL }]);
    const { data, ...envelope } = connections.body;
    expect(JSON.stringify(envelope)).not.toContain(CONNECTION_LABEL);
    expect(JSON.stringify(data)).toContain(CONNECTION_LABEL);
  });

  it("refuses what the route refuses, with the route's code", async () => {
    for (const [query, args] of [
      [
        "/api/identity/connections?source=other-test",
        { collection: "connections", source: "other-test" },
      ],
      ["/api/identity/connections?offset=0", { collection: "connections", offset: 0 }],
    ] as const) {
      const refused = await page.expectSameAnswer(query, TOOL, args);
      expect(refused.status, query).toBe(400);
    }
  });

  it("refuses an argument outside the closed schema before any read", async () => {
    for (const args of [
      {},
      { collection: "missing" },
      { collection: "accounts", q: "x" },
      { collection: "accounts", source: "" },
      { collection: "accounts", source: "a\u0001" },
      { collection: "accounts", source: "x".repeat(129) },
      { collection: "accounts", offset: -1 },
      { collection: "accounts", offset: 1.5 },
      // The route refuses an unsafe offset as `invalid_offset`; the schema bounds it first.
      { collection: "accounts", offset: 2 ** 53 },
      { collection: "accounts", identityRead: "snapshot" },
    ]) {
      const overHttp = await page.http(TOOL, args);
      expect(overHttp.status, JSON.stringify(args)).toBe(400);
      expect(overHttp.body).toMatchObject({ error: "invalid_request" });
      const overMcp = await page.mcp(TOOL, args);
      expect(overMcp.isError).toBe(true);
      expect(overMcp.body).toEqual(overHttp.body);
    }
  });

  it("refuses a grant without records.read or narrower than the whole store", async () => {
    for (const [grant, expected] of [
      [
        { ...RECORDS_GRANT, capabilities: ["summary.read", "evidence.read"] },
        { code: "unauthorized", refs: ["capability:records.read"] },
      ],
      [
        { ...RECORDS_GRANT, scopes: { sources: ["other-test"], accounts: "*" } },
        { code: "evidence_restricted", refs: ["scope:source"] },
      ],
      [
        { ...RECORDS_GRANT, scopes: { sources: "*", accounts: ["ref"] } },
        { code: "evidence_restricted", refs: ["scope:account"] },
      ],
    ] as const) {
      // The grant is graded first: even a malformed argument gets the grant's
      // refusal. No deployment configures such a grant (ADR 0084), so it is
      // given to the shared service both transports call.
      for (const args of [{ collection: "accounts" }, { collection: "missing" }]) {
        const answer = await page.direct(TOOL, args, grant);
        expect(answer.status, JSON.stringify(grant)).toBe(403);
        expect(answer.body).toMatchObject(expected);
      }
    }
  });

  it("records each agent call as an R0 read under identity.read (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    expect((await page.http(TOOL, { collection: "coverage" })).status).toBe(200);
    expect((await page.mcp(TOOL, { collection: "coverage" })).isError).toBe(false);
    expect((await page.http(TOOL, { collection: "accounts", source: "absent" })).status).toBe(200);
    const rows = (
      await env.DB.prepare(
        "SELECT path,principal,risk_class,result,diff_json FROM audit_records WHERE operation='identity.read' AND rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    // Coverage has one source row here (`other-test`), an absent source none:
    // the record counts the page's rows.
    const diff = JSON.stringify({ kind: "read", rows: 1, truncated: false });
    expect(rows).toEqual([
      {
        path: "agent-http",
        principal: "synthetic-agent",
        risk_class: "R0",
        result: "read",
        diff_json: diff,
      },
      {
        path: "mcp",
        principal: "mcp-client:synthetic-agent",
        risk_class: "R0",
        result: "read",
        diff_json: diff,
      },
      {
        path: "agent-http",
        principal: "synthetic-agent",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({ kind: "read", rows: 0, truncated: false }),
      },
    ]);
  });
});
