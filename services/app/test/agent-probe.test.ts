// The agent reads that exist only where the store has some tables or views
// (the card purchase explanation, the card settlement reads, the reported and
// reconstructed state) ask the store first, as their routes do, and so does
// the tool list. When that probe itself fails, the agent paths answer what the
// route answers — `503 catalogue_read_failed` — on `/api/agent/v1/*` and on
// `/mcp`, for the call and for the tool list: never `500 internal_error`, and
// the failure's text reaches neither the client nor the log. Every store
// failure is synthetic.
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { pageReadHarness } from "./page-read-harness";

const FAILURE = "synthetic store failure during the agent probe";

/** A store whose schema probe naming `name` throws, and whose every other statement runs. */
function failingProbe(db: D1Database, name: string): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.includes("sqlite_master") && sql.includes(`'${name}'`)) throw new Error(FAILURE);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Each probe: a table or view only it names, its route, and the tools served beside that route. */
const PROBED = [
  {
    name: "card_purchase_recognitions",
    route: "/api/v2/card-purchases",
    tools: ["kogane.purchases.explain"],
  },
  {
    name: "card_settlement_readiness",
    route: "/api/v2/reconciliation/card-settlements",
    tools: ["kogane.card-settlements.read", "kogane.card-settlements.ownership"],
  },
  {
    name: "dataset_snapshot_policies",
    route: "/api/v2/reported-state?date=2026-01-01",
    tools: ["kogane.reported-state.read", "kogane.reconstructed-state.read"],
  },
] as const;

const harnesses = PROBED.map((probed) => ({
  ...probed,
  page: pageReadHarness(`agent-probe-${probed.name.replaceAll("_", "-")}`, {
    // The card routes are the operator's; the reader is one here, so the
    // route reaches its probe exactly as the tools do.
    OPERATOR_SUBJECTS: '["synthetic-agent","synthetic-reader"]',
    get DB() {
      return failingProbe(env.DB, probed.name);
    },
  }),
}));

const REFUSAL = { error: "catalogue_read_failed" };

describe("an agent read whose store probe fails", () => {
  for (const { name, route, tools, page } of harnesses) {
    it(`answers 503 catalogue_read_failed for ${tools.join(", ")}, as ${route.split("?")[0]} does`, async () => {
      const log = vi.spyOn(console, "log");
      const error = vi.spyOn(console, "error");
      const routed = await page.route(route);
      expect(routed.status, name).toBe(503);
      expect(routed.body).toMatchObject(REFUSAL);
      const answers: unknown[] = [routed];
      for (const tool of tools) {
        const overHttp = await page.http(tool, {});
        expect(overHttp.status, tool).toBe(503);
        expect(overHttp.body).toMatchObject(REFUSAL);
        const overMcp = await page.mcpResponse({
          method: "tools/call",
          params: { name: tool, arguments: {} },
        });
        const text = await overMcp.text();
        expect(overMcp.status, tool).toBe(503);
        expect(JSON.parse(text)).toMatchObject(REFUSAL);
        answers.push(overHttp, text);
      }
      const logged = [...log.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
      expect(`${JSON.stringify(answers)}\n${logged}`).not.toContain(FAILURE);
    });

    it(`the tool list answers 503 catalogue_read_failed when the ${name} probe fails`, async () => {
      const listed = await page.mcpResponse({ method: "tools/list" });
      const text = await listed.text();
      expect(listed.status).toBe(503);
      expect(JSON.parse(text)).toMatchObject(REFUSAL);
      expect(text).not.toContain(FAILURE);
    });
  }
});
