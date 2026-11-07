// `kogane.rewards.read` and `kogane.reported-holdings-change.read`
// (ADR 0081): the reward pages and the two-date holdings change over MCP
// answer what their UI routes answer, through the routes' own readers.
// Every programme, bucket, code and quantity is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { runRewardReadProjection } from "../../processor/src/reward-read-projection";
import { PAGE_READ_ROUTES, pageReadMcpTools } from "../src/page-read-tools";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness, RECORDS_GRANT, tableCounts } from "./page-read-harness";
import { seedRewardCapture } from "./reward-capture-fixture";

const REWARDS = "kogane.rewards.read";
const CHANGE = "kogane.reported-holdings-change.read";
const page = pageReadHarness("reward-read");

/** One capture of the domestic positions container, recorded at `at`. */
async function capture(at: string, positions: [code: string, quantity: string][]) {
  vi.setSystemTime(new Date(at));
  const run = await seedRun({
    source: "sbi-securities",
    count: 1,
    dataset: "domestic-cash-positions",
  });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'sbi-domestic-cash-positions','1','2026-09-01T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.batch(
    positions.map(([code, quantity], index) =>
      env.DB.prepare(
        `INSERT INTO position_observations(parse_run_id,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,'sbi-synthetic',?,NULL,NULL,?,0,'JPY',NULL,NULL,?,'{}')`,
      ).bind(parse!.id, code, quantity, `$.positions[${index}]`),
    ),
  );
}

/** Two reward buckets, published and built into the READ reward snapshot. */
async function seedRewards() {
  const run = await seedRewardCapture();
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'v-point-balance-info','1.0.0','2026-09-07','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  const claim = async (
    digest: string,
    bucket: string,
    kind: string,
    amount: string,
    expiry: string | null,
  ) => {
    const fact = (await env.DB.prepare(
      `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_text,amount_scale,instrument,observed_at,raw_locator,extra_json)
       VALUES(?,?,'available_point_bucket',?,0,'V_POINT','2026-09-08T00:00:00.000Z','synthetic:reward-read',?) RETURNING id`,
    )
      .bind(
        parse!.id,
        bucket,
        amount,
        JSON.stringify({
          _kogane: {
            expiration: expiry === null ? null : (JSON.parse(expiry) as { value: string }).value,
          },
        }),
      )
      .first<{ id: number }>())!.id;
    return env.DB.prepare(
      `INSERT INTO reward_bucket_claims_v2(claim_digest,parse_run_id,source_fact_kind,source_fact_id,
        program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,
        quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,
        promotion_release,recorded_at)
       VALUES(?1,?2,'balance',?3,'program:v-point','program:v-point:member',?4,?5,'[]',
         'points:v-point',?6,0,'exact',?7,'2026-09-08T00:00:00.000Z','reward-promotion-v2',
         '2026-09-09T00:00:00.000Z')`,
    ).bind(digest, parse!.id, fact, bucket, kind, amount, expiry);
  };
  const claims = await Promise.all([
    claim(
      "page-read-claim-01",
      "program:v-point:slot-a",
      "time-limited",
      "5000",
      JSON.stringify({
        kind: "local-date",
        value: "2026-12-31",
        zone: "Asia/Tokyo",
        basis: "provider",
      }),
    ),
    claim("page-read-claim-02", "program:v-point:slot-b", "regular", "3000", null),
  ]);
  await publishParse(parse!.id);
  await env.DB.batch(claims);
  const built = await runRewardReadProjection(
    { ...env, REWARD_READ_PROJECTION_ENABLED: "true" } as never,
    env.EVIDENCE as never,
    { now: () => "2026-09-11T00:00:00.000Z" },
  );
  expect(built).toMatchObject({ status: "complete" });
}

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test','sbi-securities')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test','sbi-securities')",
    ),
  ]);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await capture("2026-09-03T03:00:00.000Z", [
      ["1001", "10"],
      ["1002", "3"],
    ]);
    await capture("2026-09-09T03:00:00.000Z", [
      ["1001", "12.5"],
      ["1003", "0.25"],
    ]);
  } finally {
    vi.useRealTimers();
  }
  await seedRewards();
});

describe("reward and holdings-change page reads", () => {
  it("answer the routes they name, listed only to records.read over the whole store", async () => {
    expect(PAGE_READ_ROUTES[REWARDS]).toEqual([
      "/api/v2/rewards/holdings",
      "/api/v2/rewards/expiry",
    ]);
    expect(PAGE_READ_ROUTES[CHANGE]).toEqual(["/api/v2/reported-holdings-change"]);
    const names = (grant: unknown, reportedState: boolean) =>
      pageReadMcpTools(grant as never, { reportedState }).map((tool) => tool.name);
    expect(names(RECORDS_GRANT, true)).toEqual(expect.arrayContaining([REWARDS, CHANGE]));
    // The holdings change exists only where the reported state's views do.
    expect(names(RECORDS_GRANT, false)).toContain(REWARDS);
    expect(names(RECORDS_GRANT, false)).not.toContain(CHANGE);
    for (const grant of [
      { ...RECORDS_GRANT, capabilities: ["summary.read"] },
      { ...RECORDS_GRANT, scopes: { sources: ["sbi-securities"], accounts: "*" } },
    ])
      expect(names(grant, true).filter((name) => name === REWARDS || name === CHANGE)).toEqual([]);
    const listed = await page.listed();
    expect(listed).toContain(REWARDS);
    expect(listed).toContain(CHANGE);
  });

  it("answer each route exactly as the route does, and write nothing", async () => {
    const before = await tableCounts();
    for (const [query, tool, args] of [
      ["/api/v2/rewards/holdings", REWARDS, { collection: "holdings" }],
      [
        "/api/v2/rewards/holdings?program=program:v-point&offset=0",
        REWARDS,
        { collection: "holdings", program: "program:v-point", offset: 0 },
      ],
      ["/api/v2/rewards/expiry", REWARDS, { collection: "expiry" }],
      ["/api/v2/rewards/expiry?limit=50", REWARDS, { collection: "expiry", limit: 50 }],
      [
        "/api/v2/reported-holdings-change?from=2026-09-03&to=2026-09-09",
        CHANGE,
        { from: "2026-09-03", to: "2026-09-09" },
      ],
      [
        "/api/v2/reported-holdings-change?from=2026-09-03&to=2026-09-09&source=sbi-securities",
        CHANGE,
        { from: "2026-09-03", to: "2026-09-09", source: "sbi-securities" },
      ],
    ] as const) {
      const served = await page.expectSameAnswer(query, tool, args);
      expect(served.status, query).toBe(200);
      expect(validApiResponse(query.split("?")[0]!, served.body), query).toBe(true);
    }
    // The comparisons are not of empty pages.
    const holdings = await page.mcp(REWARDS, { collection: "holdings" });
    expect(holdings.body.data.rows.length).toBeGreaterThan(0);
    const expiry = await page.mcp(REWARDS, { collection: "expiry" });
    expect(expiry.body.data.rows.length).toBeGreaterThan(0);
    const change = await page.mcp(CHANGE, { from: "2026-09-03", to: "2026-09-09" });
    expect(JSON.stringify(change.body.data)).toContain("1003");
    expect(await tableCounts()).toEqual(before);
  });

  it("refuse what the routes refuse, with the routes' codes", async () => {
    for (const [query, tool, args, status] of [
      ["/api/v2/rewards/holdings?limit=50", REWARDS, { collection: "holdings", limit: 50 }, 400],
      ["/api/v2/rewards/expiry?limit=7", REWARDS, { collection: "expiry", limit: 7 }, 400],
      [
        "/api/v2/rewards/holdings?program=bad%20ref",
        REWARDS,
        { collection: "holdings", program: "bad ref" },
        400,
      ],
      [
        "/api/v2/rewards/holdings?offset=1000001",
        REWARDS,
        { collection: "holdings", offset: 1_000_001 },
        400,
      ],
      [
        "/api/v2/rewards/expiry?cursor=not-a-cursor",
        REWARDS,
        { collection: "expiry", cursor: "not-a-cursor" },
        400,
      ],
      [
        "/api/v2/reported-holdings-change?from=2026-09-09&to=2026-09-03",
        CHANGE,
        { from: "2026-09-09", to: "2026-09-03" },
        400,
      ],
      [
        "/api/v2/reported-holdings-change?from=2026-02-30&to=2026-09-03",
        CHANGE,
        { from: "2026-02-30", to: "2026-09-03" },
        400,
      ],
      [
        "/api/v2/reported-holdings-change?from=2026-09-03&to=2999-01-01",
        CHANGE,
        { from: "2026-09-03", to: "2999-01-01" },
        400,
      ],
      [
        "/api/v2/reported-holdings-change?from=2026-09-03&to=2026-09-09&source=absent-source",
        CHANGE,
        { from: "2026-09-03", to: "2026-09-09", source: "absent-source" },
        404,
      ],
    ] as [string, string, Record<string, unknown>, number][]) {
      const refused = await page.expectSameAnswer(query, tool, args);
      expect(refused.status, query).toBe(status);
    }
  });

  it("refuse an argument outside the closed schema", async () => {
    for (const [tool, args] of [
      [REWARDS, { collection: "simulations" }],
      [REWARDS, { collection: "holdings", program: "" }],
      [REWARDS, { collection: "holdings", unit: "JPY" }],
      [CHANGE, { from: "2026-09-03" }],
      [CHANGE, { from: "2026-09-03", to: "2026-09-09", q: "x" }],
    ] as const) {
      const overHttp = await page.http(tool, args);
      expect(overHttp.status, JSON.stringify(args)).toBe(400);
      expect(overHttp.body).toMatchObject({ error: "invalid_request" });
      const overMcp = await page.mcp(tool, args);
      expect(overMcp.isError).toBe(true);
      expect(overMcp.body).toEqual(overHttp.body);
    }
  });

  it("refuse a grant without records.read or narrower than the whole store", async () => {
    for (const tool of [REWARDS, CHANGE])
      for (const [grant, code] of [
        [{ ...RECORDS_GRANT, capabilities: ["summary.read"] }, "unauthorized"],
        [
          { ...RECORDS_GRANT, scopes: { sources: ["v-point"], accounts: "*" } },
          "evidence_restricted",
        ],
      ] as const) {
        // No deployment configures such a grant (ADR 0084), so it is given to
        // the shared service both transports call.
        const answer = await page.direct(tool, {}, grant);
        expect(answer.status, tool).toBe(403);
        expect(answer.body).toMatchObject({ code });
      }
  });

  it("record each agent call with the page's row count (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const served = await page.http(REWARDS, { collection: "expiry" });
    expect(served.status).toBe(200);
    const count = served.body.data.rows.length;
    expect(count).toBeGreaterThan(0);
    const rows = (
      await env.DB.prepare(
        "SELECT path,operation,risk_class,result,diff_json FROM audit_records WHERE rowid>? AND operation='rewards.read' ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    expect(rows).toEqual([
      {
        path: "agent-http",
        operation: "rewards.read",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({ kind: "read", rows: count, truncated: false }),
      },
    ]);
  });
});

/** A store before CORE 0044: the views the reported state reads are absent. */
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

describe("where the store lacks the reported state's views", () => {
  const bare = pageReadHarness("reward-read-no-views", {
    get DB() {
      return withoutViews(env.DB);
    },
  });

  it("the holdings change is neither listed nor callable, and nothing is recorded", async () => {
    const audited = () =>
      env.DB.prepare(
        "SELECT count(*) AS n FROM audit_records WHERE operation='reported-holdings-change.read'",
      ).first<number>("n");
    const before = await audited();
    const args = { from: "2026-09-03", to: "2026-09-09" };
    expect(
      (await bare.route("/api/v2/reported-holdings-change?from=2026-09-03&to=2026-09-09")).status,
    ).toBe(404);
    const listed = await bare.listed();
    expect(listed).toContain(REWARDS);
    expect(listed).not.toContain(CHANGE);
    const called = await bare.mcpMessage({
      method: "tools/call",
      params: { name: CHANGE, arguments: args },
    });
    expect(called["error"]).toEqual({ code: -32602, message: "unknown_tool" });
    const overHttp = await bare.http(CHANGE, args);
    expect(overHttp.status).toBe(404);
    expect(overHttp.body).toMatchObject({ error: "not_found" });
    // The reward pages do not depend on those views.
    expect((await bare.http(REWARDS, { collection: "holdings" })).status).toBe(200);
    expect(await audited()).toBe(before);
  });
});
