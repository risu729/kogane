// A page read that exists only where the store has some tables or views
// (`needs`) asks the store first, as its route does. When that probe itself
// fails, the tool answers what the route answers — `503
// catalogue_read_failed` — on the HTTP agent path and on `/mcp`, for the call
// and for the tool list: never `500 internal_error`, and the failure's text
// reaches neither the client nor the log. Every store failure is synthetic.
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PAGE_READ_ROUTES, type PageReadToolName, pageReadServed } from "../src/page-read-tools";
import { pageReadHarness } from "./page-read-harness";

const FAILURE = "synthetic store failure during the probe";

/** A store whose schema probe for `table` throws, and whose every other statement runs. */
function failingProbe(db: D1Database, table: string): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.includes("sqlite_master") && sql.includes(`'${table}'`)) throw new Error(FAILURE);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Each page read with a store probe: a table its probe names, the route it
 * answers, and an argument for it. `listedAlone` is whether only page reads ask
 * that probe in a tool list (the reported state's views are also asked by the
 * reported and reconstructed state reads, outside this file's scope).
 */
const PROBED = [
  {
    tool: "kogane.events.read",
    table: "economic_event_revisions",
    route: "/api/v2/activity",
    args: { collection: "activity" },
    listedAlone: true,
  },
  {
    tool: "kogane.reports.read",
    table: "report_artifacts",
    route: "/api/v2/reports",
    args: {},
    listedAlone: true,
  },
  {
    tool: "kogane.collection-quality.read",
    table: "collection_run_stages",
    route: "/api/collection-quality",
    args: {},
    listedAlone: true,
  },
  {
    tool: "kogane.reported-holdings-change.read",
    table: "dataset_snapshot_policies",
    route: "/api/v2/reported-holdings-change?from=2026-01-01&to=2026-01-02",
    args: { from: "2026-01-01", to: "2026-01-02" },
    listedAlone: false,
  },
] as const;

const harnesses = PROBED.map((probed) => ({
  ...probed,
  page: pageReadHarness(`probe-${probed.table.replaceAll("_", "-")}`, {
    get DB() {
      return failingProbe(env.DB, probed.table);
    },
  }),
}));

const REFUSAL = { error: "catalogue_read_failed" };

describe("a page read whose store probe fails", () => {
  it("covers every page read that probes the store", async () => {
    // A page read with `needs` is not served where its feature is absent.
    const needing: string[] = [];
    for (const name of Object.keys(PAGE_READ_ROUTES))
      if (!(await pageReadServed(name as PageReadToolName, async () => false))) needing.push(name);
    // `kogane.schedules.read` is served by a deployment flag, which cannot fail.
    expect(needing.sort()).toEqual(
      [...PROBED.map(({ tool }) => tool), "kogane.schedules.read"].sort(),
    );
  });

  for (const { tool, route, args, page } of harnesses)
    it(`${tool} answers 503 catalogue_read_failed on every path, as ${route.split("?")[0]} does`, async () => {
      const log = vi.spyOn(console, "log");
      const error = vi.spyOn(console, "error");
      const routed = await page.route(route);
      expect(routed.status).toBe(503);
      expect(routed.body).toMatchObject(REFUSAL);

      const overHttp = await page.http(tool, args);
      expect(overHttp.status).toBe(503);
      expect(overHttp.body).toMatchObject(REFUSAL);

      const overMcp = await page.mcpResponse({
        method: "tools/call",
        params: { name: tool, arguments: args },
      });
      const text = await overMcp.text();
      expect(overMcp.status).toBe(503);
      expect(JSON.parse(text)).toMatchObject(REFUSAL);

      const logged = [...log.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
      expect(`${text}\n${JSON.stringify([routed, overHttp])}\n${logged}`).not.toContain(FAILURE);
    });

  for (const { tool, page } of harnesses.filter(({ listedAlone }) => listedAlone))
    it(`the tool list answers 503 catalogue_read_failed when ${tool}'s probe fails`, async () => {
      const listed = await page.mcpResponse({ method: "tools/list" });
      const text = await listed.text();
      expect(listed.status).toBe(503);
      expect(JSON.parse(text)).toMatchObject(REFUSAL);
      expect(text).not.toContain(FAILURE);
    });
});
