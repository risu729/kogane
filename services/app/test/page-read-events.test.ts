// `kogane.events.read` (ADR 0081; docs/plans/2026-10-ai-operation-path.md
// D19): the economic activity by basis and the obligations over MCP answer
// what `GET /api/v2/activity` and `/api/v2/obligations` answer, through the
// routes' own reader. Every event, account and amount is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { PAGE_READ_ROUTES, pageReadMcpTools } from "../src/page-read-tools";
import { seedRegistry } from "./fixtures";
import { pageReadHarness, RECORDS_GRANT, tableCounts } from "./page-read-harness";

const EVENTS = "kogane.events.read";
const page = pageReadHarness("events-read");

const DATE = '{"kind":"local-date","value":"2026-03-01","zone":null,"basis":"provider"}';

/**
 * A recognised purchase with a cash and a cost leg; an accepted card
 * settlement debit (cash only); a withdrawn one, whose current revision has
 * no leg; and an obligation with one settlement.
 */
async function seedProjection() {
  const decision = (id: string, subjectRef: string) =>
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,1,'accept','rule','rule:test',NULL,'synthetic','[]',NULL,NULL,'2026-03-01T00:00:00Z')`,
    ).bind(id, subjectRef);
  const event = (id: string, revision: number, kind: string, state: string, basis: string) =>
    env.DB.prepare(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
       VALUES(?,?,?,?,?,?,?,'[{"kind":"transaction","id":"transaction:1","revision":"parse_run:1"}]',?,NULL,'2026-03-01T00:00:00Z')`,
    ).bind(
      id,
      revision,
      kind,
      state,
      state === "unknown" ? "conflicting_evidence" : null,
      DATE,
      basis,
      `dr_${id}`,
    );
  await env.DB.batch([
    decision("dr_ev-buy", "event:ev-buy"),
    event("ev-buy", 1, "purchase", "captured", "purchase-recognition"),
    env.DB.prepare(
      "INSERT INTO economic_legs VALUES('ev-buy',1,0,'account:card','JPY','exact','3000',0,NULL,'decrease','cash-movement')",
    ),
    env.DB.prepare(
      "INSERT INTO economic_legs VALUES('ev-buy',1,1,'claim:cost','JPY','exact','3000',0,NULL,'increase','purchase-recognition')",
    ),
    decision("dr_ev-debit", "event:ev-debit"),
    event("ev-debit", 1, "card_settlement", "debited", "cash-movement"),
    env.DB.prepare(
      "INSERT INTO economic_legs VALUES('ev-debit',1,0,'account:bank','JPY','exact','12000',0,NULL,'decrease','cash-movement')",
    ),
    decision("dr_ev-withdrawn", "event:ev-withdrawn"),
    event("ev-withdrawn", 1, "card_settlement", "debited", "cash-movement"),
    env.DB.prepare(
      "INSERT INTO economic_legs VALUES('ev-withdrawn',1,0,'account:bank','JPY','exact','8000',0,NULL,'decrease','cash-movement')",
    ),
    // The withdrawal: a later revision with no leg replaces the debit.
    event("ev-withdrawn", 2, "card_settlement", "unknown", "cash-movement"),
    env.DB.prepare(
      "UPDATE economic_event_revisions SET superseded_by='ev-withdrawn@2' WHERE event_id='ev-withdrawn' AND revision=1",
    ),
    decision("dr_obl-1", "obligation:obl-1"),
    env.DB.prepare(
      `INSERT INTO obligation_revisions(obligation_id,revision,creditor_ref,debtor_ref,principal_unit_ref,principal_status,principal_coefficient,principal_scale,fee_components_json,schedule_json,state,unknown_reason,state_evidence_refs_json,decision_revision_id,superseded_by,created_at)
       VALUES('obl-1',1,'party:issuer','party:self','JPY','exact','12000',0,'[]','[]','partially-settled',NULL,'["transaction:1"]','dr_obl-1',NULL,'2026-03-01T00:00:00Z')`,
    ),
    decision("dr_st-1", "settlement:st-1"),
    env.DB.prepare(
      `INSERT INTO settlement_relations(id,obligation_id,settlement_component_ref,unit_ref,coefficient,scale,occurred_json,unresolved_coefficient,unresolved_scale,decision_revision_id,superseded_by,created_at)
       VALUES('st-1','obl-1','leg:ev-buy#0','JPY','4000',0,?,NULL,NULL,'dr_st-1',NULL,'2026-03-01T00:00:00Z')`,
    ).bind(DATE),
  ]);
}

beforeAll(async () => {
  await seedRegistry().catch(() => undefined);
  await seedProjection();
});

describe("the events page read", () => {
  it("answers the routes it names, listed only to records.read over the whole store", async () => {
    expect(PAGE_READ_ROUTES[EVENTS]).toEqual(["/api/v2/activity", "/api/v2/obligations"]);
    const names = (grant: unknown, economicEvents: boolean) =>
      pageReadMcpTools(grant as never, { reportedState: true, economicEvents }).map(
        (tool) => tool.name,
      );
    expect(names(RECORDS_GRANT, true)).toContain(EVENTS);
    // It exists only where the projection does.
    expect(names(RECORDS_GRANT, false)).not.toContain(EVENTS);
    for (const grant of [
      { ...RECORDS_GRANT, capabilities: ["summary.read"] },
      { ...RECORDS_GRANT, scopes: { sources: ["jcb"], accounts: "*" } },
    ])
      expect(names(grant, true)).not.toContain(EVENTS);
    expect(await page.listed()).toContain(EVENTS);
  });

  it("answers each route exactly as the route does, and writes nothing", async () => {
    const before = await tableCounts();
    for (const [query, args] of [
      ["/api/v2/activity", { collection: "activity" }],
      ["/api/v2/activity?basis=cash-movement", { collection: "activity", basis: "cash-movement" }],
      [
        "/api/v2/activity?basis=purchase-recognition&offset=0",
        { collection: "activity", basis: "purchase-recognition", offset: 0 },
      ],
      ["/api/v2/activity?offset=1", { collection: "activity", offset: 1 }],
      ["/api/v2/obligations", { collection: "obligations" }],
      ["/api/v2/obligations?offset=0", { collection: "obligations", offset: 0 }],
    ] as const) {
      const served = await page.expectSameAnswer(query, EVENTS, args);
      expect(served.status, query).toBe(200);
    }
    expect(await tableCounts()).toEqual(before);
  });

  it("lists each current cash debit once, and not a withdrawn one", async () => {
    const cash = await page.mcp(EVENTS, { collection: "activity", basis: "cash-movement" });
    expect(cash.isError).toBe(false);
    expect(cash.body.data.basis).toBe("cash-movement");
    const ids = cash.body.data.items.map((item: { eventId: string }) => item.eventId);
    expect(ids).toEqual(["ev-buy", "ev-debit"]);
    const debit = cash.body.data.items[1];
    expect(debit).toMatchObject({ kind: "card_settlement", state: "debited", revision: 1 });
    expect(debit.totals).toEqual([
      expect.objectContaining({ basis: "cash-movement", quantity: expect.anything() }),
    ]);
    // Cost recognised at purchase is a separate reading, never mixed in.
    const cost = await page.mcp(EVENTS, { collection: "activity", basis: "purchase-recognition" });
    expect(cost.body.data.items.map((item: { eventId: string }) => item.eventId)).toEqual([
      "ev-buy",
    ]);
    const obligations = await page.mcp(EVENTS, { collection: "obligations" });
    expect(obligations.body.data.items[0]).toMatchObject({
      obligationId: "obl-1",
      state: "partially-settled",
    });
  });

  it("refuses what the routes refuse, with the routes' codes", async () => {
    for (const [query, args, status] of [
      [
        "/api/v2/obligations?basis=cash-movement",
        { collection: "obligations", basis: "cash-movement" },
        400,
      ],
      ["/api/v2/activity?offset=1000001", { collection: "activity", offset: 1_000_001 }, 400],
    ] as [string, Record<string, unknown>, number][]) {
      const refused = await page.expectSameAnswer(query, EVENTS, args);
      expect(refused.status, query).toBe(status);
    }
  });

  it("refuses an argument outside the closed schema", async () => {
    for (const args of [
      { collection: "events" },
      { collection: "activity", basis: "tax" },
      { collection: "activity", offset: -1 },
      { collection: "activity", cursor: "200" },
    ]) {
      const overHttp = await page.http(EVENTS, args);
      expect(overHttp.status, JSON.stringify(args)).toBe(400);
      expect(overHttp.body).toMatchObject({ error: "invalid_request" });
      const overMcp = await page.mcp(EVENTS, args);
      expect(overMcp.isError).toBe(true);
      expect(overMcp.body).toEqual(overHttp.body);
    }
  });

  it("refuses a grant without records.read or narrower than the whole store", async () => {
    for (const [grant, code] of [
      [{ ...RECORDS_GRANT, capabilities: ["summary.read"] }, "unauthorized"],
      [{ ...RECORDS_GRANT, scopes: { sources: ["jcb"], accounts: "*" } }, "evidence_restricted"],
    ] as const) {
      const answer = await page.direct(EVENTS, { collection: "activity" }, grant);
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ code });
    }
  });

  it("records each agent call with the page's row count (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const served = await page.http(EVENTS, { collection: "activity" });
    expect(served.status).toBe(200);
    const rows = (
      await env.DB.prepare(
        "SELECT path,operation,risk_class,result,diff_json FROM audit_records WHERE rowid>? AND operation='events.read' ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    expect(rows).toEqual([
      {
        path: "agent-http",
        operation: "events.read",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({
          kind: "read",
          rows: served.body.data.items.length,
          truncated: false,
        }),
      },
    ]);
  });
});

/** The store with migration 0032 not yet applied. */
function withoutEventsTable(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("economic_event_revisions")
              ? "SELECT 0 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("where the store lacks the events projection", () => {
  const bare = pageReadHarness("events-read-no-table", {
    get DB() {
      return withoutEventsTable(env.DB);
    },
  });

  it("the events read is neither listed nor callable, and nothing is recorded", async () => {
    const audited = () =>
      env.DB.prepare(
        "SELECT count(*) AS n FROM audit_records WHERE operation='events.read'",
      ).first<number>("n");
    const before = await audited();
    expect((await bare.route("/api/v2/activity")).status).toBe(404);
    expect(await bare.listed()).not.toContain(EVENTS);
    const called = await bare.mcpMessage({
      method: "tools/call",
      params: { name: EVENTS, arguments: { collection: "activity" } },
    });
    expect(called["error"]).toEqual({ code: -32602, message: "unknown_tool" });
    const overHttp = await bare.http(EVENTS, { collection: "activity" });
    expect(overHttp.status).toBe(404);
    expect(overHttp.body).toMatchObject({ error: "not_found" });
    expect(await audited()).toBe(before);
  });
});
