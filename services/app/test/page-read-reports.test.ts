// `kogane.reports.read` and `kogane.collection-quality.read` (ADR 0081): the
// report pages and the collection quality page over MCP answer what their UI
// routes answer, through the routes' own readers. A report read by an agent
// is refused outright when its explanation and export are (ADR 0072,
// amendment of 2026-11-06). Every value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { canonicalJson, type ReportBody } from "../../../packages/domain/src/index";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import {
  PAGE_READ_ROUTES,
  pageReadMcpTools,
  pageReadServed,
  pageReadStore,
} from "../src/page-read-tools";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness, RECORDS_GRANT, tableCounts, withoutTables } from "./page-read-harness";

const REPORTS = "kogane.reports.read";
const QUALITY = "kogane.collection-quality.read";
const NOW = "2026-08-31T15:00:00.000Z";
/** Records and evidence over the whole store: the collection quality page needs evidence.read. */
const EVIDENCE_GRANT = { ...RECORDS_GRANT, capabilities: ["records.read", "evidence.read"] };
const page = pageReadHarness("report-read");

const bare = pageReadHarness("report-read-bare", { DB: withoutTables(env.DB) });
/** The open report's body key: under `racing`, it leaves R2 between the reader's `head` and `get`. */
let vanishing = "";
const racing = pageReadHarness("report-read-racing", {
  EVIDENCE: new Proxy(env.EVIDENCE, {
    get(target, property) {
      if (property === "get")
        return (key: string, ...rest: never[]) =>
          key === vanishing ? Promise.resolve(null) : target.get(key, ...rest);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
});

/** One stored report of `context`, its run complete, its body and explanation in R2. */
async function storeReport(reportId: string, context: string): Promise<string> {
  const body: ReportBody = {
    schemaVersion: "report-holdings-v1",
    purpose: "holdings-view",
    contextId: context,
    calculationRunId: `run-${reportId}`,
    policyRefs: ["decimal-v1", "instrument-valuation-v1"],
    unitRef: "JPY",
    partition: "partial-verified-scope",
    subtotal: { coefficient: "10000", scale: 0 },
    rows: [
      {
        subjectRef: "instrument:synthetic:-:FUND",
        scopeRef: "scope:synthetic",
        metric: "holdings.valuation",
        unitRef: "JPY",
        valued: true,
        value: { coefficient: "10000", scale: 0 },
      },
    ],
    coverage: { scopeRef: "perimeter:test", coveredRef: "positions:1", truncated: false },
  };
  const bytes = new TextEncoder().encode(canonicalJson(body));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const storageRef = `reports/${digest}`;
  await env.EVIDENCE.put(storageRef, bytes);
  await env.EVIDENCE.put(
    `${storageRef}.explanation`,
    new TextEncoder().encode(
      canonicalJson({ schemaVersion: "report-explanation-v1", contextId: context }),
    ),
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO calculation_runs(run_id,context_id,policy_refs_json,input_manifest_digest,status,replayability,started_at,completed_at)
       VALUES (?,?,?,?,'complete','replayable',?,?)`,
    ).bind(`run-${reportId}`, context, JSON.stringify(body.policyRefs), "c".repeat(64), NOW, NOW),
    env.DB.prepare(
      `INSERT INTO report_artifacts(report_id,context_id,purpose,schema_version,content_digest,storage_ref,created_by,created_at)
       VALUES (?,?,'holdings-view',?,?,?,'report-job',?)`,
    ).bind(reportId, context, body.schemaVersion, digest, storageRef, NOW),
    env.DB.prepare(
      "INSERT INTO report_events(report_id,kind,actor,related_report_id,occurred_at) VALUES(?,'generated','report-job',NULL,?)",
    ).bind(reportId, NOW),
  ]);
  return storageRef;
}

beforeAll(async () => {
  await seedRegistry();
  vanishing = await storeReport("rpt:synthetic-open", "ctx-open");
  await storeReport("rpt:synthetic-restricted", "ctx-restricted");
  // Its run is complete, but its body has left R2.
  await env.EVIDENCE.delete(await storeReport("rpt:synthetic-gone", "ctx-gone"));
  await env.DB.prepare(
    `INSERT INTO evidence_use_restrictions(evidence_ref,restriction,since,affected_manifests_json,actor,reason)
     VALUES ('ctx-restricted','no-reuse',?,'[]','operator:synthetic','synthetic exclusion drill')`,
  )
    .bind(NOW)
    .run();
  const run = await seedRun({ source: "sony-bank", count: 1, dataset: "yen-history-page-0001" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'sony-bank-history-json','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
});

describe("report page reads", () => {
  it("answer the routes they name, but never the export view", () => {
    expect(PAGE_READ_ROUTES[REPORTS]).toEqual([
      "/api/v2/reports",
      "/api/v2/reports/:id",
      "/api/v2/reports/:id/explanation",
    ]);
  });

  it("answer the list, a body and an explanation exactly as the routes do", async () => {
    const before = await tableCounts();
    const id = encodeURIComponent("rpt:synthetic-open");
    for (const [query, args] of [
      ["/api/v2/reports", {}],
      ["/api/v2/reports?offset=0", { offset: 0 }],
      [`/api/v2/reports/${id}`, { reportId: "rpt:synthetic-open" }],
      [`/api/v2/reports/${id}`, { reportId: "rpt:synthetic-open", view: "body" }],
      [
        `/api/v2/reports/${id}?decimalPolicy=decimal-v1`,
        { reportId: "rpt:synthetic-open", decimalPolicy: "decimal-v1" },
      ],
      [
        `/api/v2/reports/${id}/explanation`,
        { reportId: "rpt:synthetic-open", view: "explanation" },
      ],
    ] as const) {
      const served = await page.expectSameAnswer(query, REPORTS, args);
      expect(served.status, query).toBe(200);
      if (query.startsWith("/api/v2/reports?") || query === "/api/v2/reports")
        expect(validApiResponse("/api/v2/reports", served.body)).toBe(true);
    }
    const list = await page.mcp(REPORTS, {});
    expect(list.body.data.items.map((item: { reportId: string }) => item.reportId).sort()).toEqual([
      "rpt:synthetic-gone",
      "rpt:synthetic-open",
      "rpt:synthetic-restricted",
    ]);
    expect(await tableCounts()).toEqual(before);
  });

  it("refuse a restricted report on every view, where the operator page still shows its body", async () => {
    const id = encodeURIComponent("rpt:synthetic-restricted");
    const operator = await page.route(`/api/v2/reports/${id}`);
    expect(operator.status).toBe(200);
    expect(operator.body).toMatchObject({ report: { replayability: "restricted" } });
    for (const view of ["body", "explanation"] as const) {
      const overHttp = await page.http(REPORTS, { reportId: "rpt:synthetic-restricted", view });
      expect(overHttp.status, view).toBe(403);
      expect(overHttp.body).toEqual({ error: "evidence_restricted" });
      const overMcp = await page.mcp(REPORTS, { reportId: "rpt:synthetic-restricted", view });
      expect(overMcp.isError).toBe(true);
      expect(overMcp.body).toEqual(overHttp.body);
    }
  });

  it("refuse a report whose body is gone on every view, where the operator page shows it unavailable", async () => {
    const operator = await page.route(
      `/api/v2/reports/${encodeURIComponent("rpt:synthetic-gone")}`,
    );
    expect(operator.status).toBe(200);
    expect(operator.body).toMatchObject({ report: { replayability: "unavailable" }, body: null });
    for (const view of ["body", "explanation"] as const) {
      const overHttp = await page.http(REPORTS, { reportId: "rpt:synthetic-gone", view });
      expect(overHttp, view).toEqual({ status: 404, body: { error: "not_found" } });
      const overMcp = await page.mcp(REPORTS, { reportId: "rpt:synthetic-gone", view });
      expect(overMcp).toEqual({ isError: true, body: overHttp.body });
    }
  });

  it("refuse a report whose body leaves R2 while it is read, where the operator page shows it unavailable", async () => {
    const operator = await racing.route(
      `/api/v2/reports/${encodeURIComponent("rpt:synthetic-open")}`,
    );
    expect(operator.status).toBe(200);
    expect(operator.body).toMatchObject({ report: { replayability: "unavailable" }, body: null });
    const overHttp = await racing.http(REPORTS, { reportId: "rpt:synthetic-open" });
    expect(overHttp).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await racing.mcp(REPORTS, { reportId: "rpt:synthetic-open" })).toEqual({
      isError: true,
      body: overHttp.body,
    });
  });

  it("refuse what the routes refuse, and what the schema does not take", async () => {
    for (const [query, args, status] of [
      ["/api/v2/reports/rpt-absent", { reportId: "rpt-absent" }, 404],
      ["/api/v2/reports?offset=1000001", { offset: 1_000_001 }, 400],
      [
        "/api/v2/reports/rpt-absent?decimalPolicy=unknown-policy",
        { reportId: "rpt-absent", decimalPolicy: "unknown-policy" },
        400,
      ],
    ] as [string, Record<string, unknown>, number][]) {
      const refused = await page.expectSameAnswer(query, REPORTS, args);
      expect(refused.status, query).toBe(status);
    }
    for (const args of [
      { view: "export" },
      { reportId: "rpt:synthetic-open", view: "export" },
      { reportId: "/etc" },
      { view: "body" },
      { decimalPolicy: "decimal-v1" },
      { reportId: "rpt:synthetic-open", cursor: "x" },
    ]) {
      const overHttp = await page.http(REPORTS, args);
      expect(overHttp.status, JSON.stringify(args)).toBe(400);
      expect(overHttp.body).toMatchObject({ error: "invalid_request" });
      expect((await page.mcp(REPORTS, args)).body).toEqual(overHttp.body);
    }
    // The list takes neither a view nor a policy: each one given is a ref.
    for (const [args, refs] of [
      [{ view: "body" }, ["view"]],
      [{ decimalPolicy: "decimal-v1" }, ["decimalPolicy"]],
      [{ view: "explanation", decimalPolicy: "decimal-v1" }, ["view", "decimalPolicy"]],
    ] as [Record<string, unknown>, string[]][]) {
      const overHttp = await page.http(REPORTS, args);
      expect(overHttp, JSON.stringify(args)).toEqual({
        status: 400,
        body: { error: "invalid_request", refs },
      });
      expect((await page.mcp(REPORTS, args)).body).toEqual(overHttp.body);
    }
  });
});

describe("collection quality page reads", () => {
  it("answer the routes they name, listed only to evidence.read over the whole store", async () => {
    expect(PAGE_READ_ROUTES[QUALITY]).toEqual([
      "/api/collection-quality",
      "/api/collection-quality/:source",
    ]);
    const names = async (grant: unknown) =>
      (await pageReadMcpTools(grant as never, pageReadStore(env as Env))).map((tool) => tool.name);
    expect(await names(EVIDENCE_GRANT)).toContain(QUALITY);
    expect(await names(RECORDS_GRANT)).not.toContain(QUALITY);
    expect(
      await names({ ...EVIDENCE_GRANT, scopes: { sources: ["sony-bank"], accounts: "*" } }),
    ).not.toContain(QUALITY);
  });

  it("answer the summary and a source's cells exactly as the routes do", async () => {
    // One clock for every call: each answer counts its ages to `now`
    // (`freshnessAsOf`, collection-freshness-v1).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const before = await tableCounts();
    for (const [query, args] of [
      ["/api/collection-quality", {}],
      ["/api/collection-quality/sony-bank", { source: "sony-bank" }],
      ["/api/collection-quality/sony-bank?offset=0", { source: "sony-bank", offset: 0 }],
    ] as const) {
      const route = await page.route(query);
      expect(route.status, query).toBe(200);
      expect(validApiResponse(query.split("?")[0]!, route.body), query).toBe(true);
      const overHttp = await page.http(QUALITY, args);
      expect(overHttp).toEqual({
        status: 200,
        body: { schemaVersion: "kogane-page-read-v1", data: route.body },
      });
      const overMcp = await page.mcp(QUALITY, args);
      expect(overMcp).toEqual({ isError: false, body: overHttp.body });
    }
    expect(await tableCounts()).toEqual(before);
  });

  it("refuse a summary with an offset, an unknown source, and a grant without evidence.read", async () => {
    for (const [query, args, status] of [
      ["/api/collection-quality?offset=0", { offset: 0 }, 400],
      ["/api/collection-quality/absent-source", { source: "absent-source" }, 404],
    ] as [string, Record<string, unknown>, number][]) {
      const route = await page.route(query);
      expect(route.status, query).toBe(status);
      const { requestId: _requestId, ...refusal } = route.body as Record<string, unknown>;
      const overHttp = await page.http(QUALITY, args);
      expect(overHttp, query).toEqual({ status, body: refusal });
      expect((await page.mcp(QUALITY, args)).body).toEqual(refusal);
    }
    // No deployment configures a grant without evidence.read (ADR 0084), so
    // it is given to the shared service both transports call.
    const refused = await page.direct(QUALITY, {}, RECORDS_GRANT);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: "unauthorized",
      refs: ["capability:evidence.read"],
    });
  });
});

describe("where the store lacks the tables", () => {
  it("neither lists nor serves the report and collection quality reads, as the routes are absent", async () => {
    for (const tool of [REPORTS, QUALITY] as const) {
      expect(
        await pageReadServed(tool, pageReadStore({ ...env, DB: withoutTables(env.DB) } as Env)),
      ).toBe(false);
      expect(await pageReadServed(tool, pageReadStore(env as Env))).toBe(true);
    }
    const listed = await bare.listed();
    // The other page reads stay listed: only the two absent routes drop out.
    expect(listed).toContain("kogane.identity.read");
    expect(listed).not.toContain(REPORTS);
    expect(listed).not.toContain(QUALITY);
    expect((await bare.route("/api/v2/reports")).status).toBe(404);
    for (const tool of [REPORTS, QUALITY]) {
      const overHttp = await bare.http(tool, {});
      expect(overHttp.status, tool).toBe(404);
      expect(overHttp.body).toMatchObject({ error: "not_found" });
    }
  });
});

describe("the audit rows of the report and collection quality reads", () => {
  it("count the list's items, truncated while a cursor follows, one report, and a source's cells", async () => {
    // More reports than one page, so the list's first page has a cursor.
    await env.DB.batch(
      Array.from({ length: 50 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO report_artifacts(report_id,context_id,purpose,schema_version,content_digest,storage_ref,created_by,created_at)
           VALUES (?,?,'holdings-view','report-holdings-v1',?,?,'report-job','2026-08-01T00:00:00.000Z')`,
        ).bind(
          `rpt:synthetic-older-${String(index).padStart(2, "0")}`,
          `ctx-older-${index}`,
          "d".repeat(64),
          `reports/${"d".repeat(64)}`,
        ),
      ),
    );
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const list = await page.mcp(REPORTS, {});
    expect(list.body.data.items).toHaveLength(50);
    expect(list.body.data.nextCursor).toBe("50");
    expect((await page.http(REPORTS, { offset: 50 })).status).toBe(200);
    expect((await page.http(REPORTS, { reportId: "rpt:synthetic-open" })).status).toBe(200);
    expect(
      (await page.mcp(REPORTS, { reportId: "rpt:synthetic-open", view: "explanation" })).isError,
    ).toBe(false);
    const cells = await page.http(QUALITY, { source: "sony-bank" }, EVIDENCE_GRANT);
    expect(cells.status).toBe(200);
    const rows = (
      await env.DB.prepare(
        "SELECT path,operation,risk_class,result,diff_json FROM audit_records WHERE rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    const read = (path: string, operation: string, count: number, truncated = false) => ({
      path,
      operation,
      risk_class: "R0",
      result: "read",
      diff_json: JSON.stringify({ kind: "read", rows: count, truncated }),
    });
    expect(rows).toEqual([
      read("mcp", "reports.read", 50, true),
      read("agent-http", "reports.read", 3),
      // One report, not its events.
      read("agent-http", "reports.read", 1),
      read("mcp", "reports.read", 1),
      read(
        "agent-http",
        "collection-quality.read",
        cells.body.data.cells.length,
        cells.body.data.coverage.truncated,
      ),
    ]);
  });
});
