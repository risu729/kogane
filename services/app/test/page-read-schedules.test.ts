// `kogane.schedules.read` (ADR 0081): the schedules page over MCP answers what
// `GET /api/ops/v1/schedules` answers, through the same Processor snapshot,
// without the page's `survey` part (kogane.schedules.survey.read's). Every
// value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { scheduleRoute } from "../../processor/src/schedule-store";
import { ScheduleAlarm } from "../../processor/src/schedule-alarm";
import { PAGE_READ_ROUTES, pageReadMcpTools, pageReadStore } from "../src/page-read-tools";
import { pageReadHarness, RECORDS_GRANT, tableCounts } from "./page-read-harness";

const TOOL = "kogane.schedules.read";
// The page's occurrences carry run and evidence ids, which `schedules.read`
// alone never reaches (ADR 0046): the page also needs whole-store `evidence.read`.
const SCHEDULES_GRANT = {
  scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
  capabilities: ["schedules.read", "evidence.read"],
  budget: { maxRows: 100, maxProposalTargets: 3, maxExplainDepth: 3 },
} as const;
const LEASE_REF = "0b6f1c3e-8d2a-4f5b-9c7e-1a2b3c4d5e6f";

// The Processor side: its own route and alarm code over this store.
const alarms = new Map<string, number | null>();
const processorEnv: Record<string, unknown> = { ...env, SCHEDULES_ENABLED: "true" };
processorEnv["SCHEDULE_ALARMS"] = {
  getByName(name: string) {
    const storage = {
      async get() {
        return name;
      },
      async put() {},
      async getAlarm() {
        return alarms.get(name) ?? null;
      },
      async setAlarm(value: number) {
        alarms.set(name, value);
      },
      async deleteAlarm() {
        alarms.set(name, null);
      },
    };
    return Object.assign(Object.create(ScheduleAlarm.prototype) as ScheduleAlarm, {
      ctx: { storage, blockConcurrencyWhile: <T>(action: () => Promise<T>) => action() },
      env: processorEnv,
    });
  },
};
const relayed: { method: string; path: string; operator: string | null; agent: string | null }[] =
  [];
let processorDown = false;
const PIPELINE = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    relayed.push({
      method: request.method,
      path: url.pathname,
      operator: request.headers.get("x-kogane-operator"),
      agent: request.headers.get("x-kogane-agent"),
    });
    if (processorDown) throw new Error("synthetic binding failure");
    return (
      (await scheduleRoute(request, processorEnv as unknown as Env, url)) ??
      Response.json({ error: "not_found" }, { status: 404 })
    );
  },
};
const served = {
  SCHEDULES_ENABLED: "true",
  PIPELINE,
  OPERATOR_SUBJECTS: '["synthetic-reader","synthetic-agent"]',
};
const page = pageReadHarness("schedules-read", served);
const off = pageReadHarness("schedules-read-off", { ...served, SCHEDULES_ENABLED: "false" });

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT INTO collection_execution_leases(source,lease_ref,started_at) VALUES('vpass',?,'2099-01-01T00:00:00.000Z') ON CONFLICT(source) DO UPDATE SET lease_ref=excluded.lease_ref,started_at=excluded.started_at",
  )
    .bind(LEASE_REF)
    .run();
});

describe("kogane.schedules.read", () => {
  it("answers the schedules page's route", () => {
    expect(PAGE_READ_ROUTES[TOOL]).toEqual(["/api/ops/v1/schedules"]);
  });

  it("is listed only to schedules.read over every schedule source with whole-store evidence.read, while settings are on", async () => {
    const names = async (grant: unknown, on = true) =>
      (
        await pageReadMcpTools(
          grant as never,
          pageReadStore({ ...env, SCHEDULES_ENABLED: on ? "true" : "false" } as Env),
        )
      ).map((tool) => tool.name);
    expect(await names(SCHEDULES_GRANT)).toContain(TOOL);
    expect(await names(SCHEDULES_GRANT, false)).not.toContain(TOOL);
    expect(await names(RECORDS_GRANT)).not.toContain(TOOL);
    expect(
      await names({
        ...SCHEDULES_GRANT,
        scopes: { ...SCHEDULES_GRANT.scopes, scheduleSources: ["vpass"] },
      }),
    ).not.toContain(TOOL);
    expect(
      await names({ ...SCHEDULES_GRANT, scopes: { sources: "*", accounts: "*" } }),
    ).not.toContain(TOOL);
    // `schedules.read` alone, as `kogane.schedules.maintenance.read` needs it, is not enough.
    expect(await names({ ...SCHEDULES_GRANT, capabilities: ["schedules.read"] })).not.toContain(
      TOOL,
    );
    expect(await names({ ...SCHEDULES_GRANT, capabilities: ["evidence.read"] })).not.toContain(
      TOOL,
    );
    expect(
      await names({
        ...SCHEDULES_GRANT,
        scopes: { ...SCHEDULES_GRANT.scopes, sources: ["vpass"] },
      }),
    ).not.toContain(TOOL);
    expect(await page.listed()).toContain(TOOL);
    expect(await off.listed()).not.toContain(TOOL);
  });

  it("answers the page without its survey part, relayed with no actor, and writes nothing", async () => {
    const before = await tableCounts();
    relayed.length = 0;
    const route = await page.route("/api/ops/v1/schedules");
    expect(route.status).toBe(200);
    const body = route.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(["schedules", "maintenance", "occurrences", "leases"]),
    );
    expect(body["leases"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "vpass" })]),
    );
    const { survey: _survey, ...withoutSurvey } = body;
    const overHttp = await page.http(TOOL, {});
    expect(overHttp).toEqual({
      status: 200,
      body: { schemaVersion: "kogane-page-read-v1", data: withoutSurvey },
    });
    expect(overHttp.body.data).not.toHaveProperty("survey");
    const overMcp = await page.mcp(TOOL, {});
    expect(overMcp).toEqual({ isError: false, body: overHttp.body });
    // The page and both tool calls read the one snapshot, never as an operator or an agent.
    expect(relayed).toEqual(
      Array.from({ length: 3 }, () => ({
        method: "GET",
        path: "/internal/schedules",
        operator: null,
        agent: null,
      })),
    );
    expect(await tableCounts()).toEqual(before);
  });

  it("refuses any argument, a narrower or missing grant, and answers the route's refusal", async () => {
    for (const args of [{ source: "vpass" }, { survey: true }]) {
      const overHttp = await page.http(TOOL, args);
      expect(overHttp.status, JSON.stringify(args)).toBe(400);
      expect(overHttp.body).toMatchObject({ error: "invalid_request" });
      expect((await page.mcp(TOOL, args)).body).toEqual(overHttp.body);
    }
    for (const [grant, expected] of [
      [
        RECORDS_GRANT,
        { code: "unauthorized", refs: ["capability:schedules.read", "capability:evidence.read"] },
      ],
      [
        { ...SCHEDULES_GRANT, capabilities: ["schedules.read"] },
        { code: "unauthorized", refs: ["capability:evidence.read"] },
      ],
      [
        { ...SCHEDULES_GRANT, scopes: { ...SCHEDULES_GRANT.scopes, scheduleSources: ["vpass"] } },
        { code: "evidence_restricted", refs: ["scope:scheduleSource"] },
      ],
      [
        {
          ...SCHEDULES_GRANT,
          scopes: { sources: ["vpass"], accounts: ["synthetic-account"], scheduleSources: "*" },
        },
        { code: "evidence_restricted", refs: ["scope:source", "scope:account"] },
      ],
    ] as const) {
      // No deployment configures such a grant (ADR 0084), so it is given to
      // the shared service both transports call.
      const answer = await page.direct(TOOL, {}, grant);
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject(expected);
    }
    // An unreachable Processor is the route's 503, on every path.
    processorDown = true;
    try {
      const route = await page.route("/api/ops/v1/schedules");
      expect(route).toMatchObject({ status: 503, body: { error: "scheduling_unavailable" } });
      expect(await page.http(TOOL, {})).toEqual({
        status: 503,
        body: { error: "scheduling_unavailable" },
      });
    } finally {
      processorDown = false;
    }
  });

  it("is neither listed nor served while schedule settings are off, as the route is absent", async () => {
    relayed.length = 0;
    expect((await off.route("/api/ops/v1/schedules")).status).toBe(404);
    const overHttp = await off.http(TOOL, {});
    expect(overHttp).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(relayed).toEqual([]);
  });

  it("records each agent call as an R0 read under schedules.read, counting the jobs", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const jobs = ((await page.http(TOOL, {})).body.data.schedules as unknown[]).length;
    expect((await page.mcp(TOOL, {})).isError).toBe(false);
    const rows = (
      await env.DB.prepare(
        "SELECT path,risk_class,result,diff_json FROM audit_records WHERE operation='schedules.read' AND rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    const diff = JSON.stringify({ kind: "read", rows: jobs, truncated: false });
    expect(rows).toEqual([
      { path: "agent-http", risk_class: "R0", result: "read", diff_json: diff },
      { path: "mcp", risk_class: "R0", result: "read", diff_json: diff },
    ]);
  });
});
