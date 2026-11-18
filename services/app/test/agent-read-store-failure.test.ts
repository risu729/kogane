// A read tool whose store fails inside its own read (after any check that its
// tables exist has passed) answers what its route answers, `503
// catalogue_read_failed`, as the tool's result: a body on
// `/api/agent/v1/*`, `isError: true` on `/mcp`. Never `500 internal_error` for
// the whole request, and the failure's text reaches neither the client, the
// log nor the audit record (ADR 0081, amendment of 2026-11-18). A proposal
// writes, so its store failure stays the Worker's `500 internal_error`. Every
// store failure is synthetic.
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_TOOL_NAMES,
  PURCHASES_TOOL_NAME,
  RECONSTRUCTED_STATE_TOOL_NAME,
} from "../src/agent-service";
import { HttpError } from "../src/http";
import { catalogueTool } from "../src/read";
import { READ_MCP_TOOLS } from "../src/read-tools";
import { pageReadHarness } from "./page-read-harness";

const FAILURE = "synthetic store failure inside the read";

/**
 * A store whose every statement fails but the audit record's writes
 * (`INSERT`), so each call is still recorded. Unless `schema` fails too, the
 * checks that a tool's tables exist (`sqlite_master`) also run, so the tool is
 * served and only its own read fails.
 */
function failingReads(db: D1Database, schema: boolean): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if ((schema || !sql.includes("sqlite_master")) && !/^\s*INSERT\b/iu.test(sql))
            throw new Error(FAILURE);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Each read tool outside the page reads (`page-read-probe.test.ts` covers
 * those): an argument its schema accepts, and the UI route that reads the same
 * service (null for a tool with none).
 *
 * - `schema`: the tool's only store reads are the schema checks
 *   (`kogane.capabilities` asks which tables exist), so its store fails there;
 *   no check runs before it on either agent path.
 * - `own`: the service answers its own store failure with a closed `503`
 *   (`kogane.economic-readiness.read`: `readiness_store_unavailable`), and
 *   the tool answers that same body.
 */
const READS: readonly {
  tool: string;
  args: unknown;
  route: string | null;
  schema?: true;
  own?: true;
}[] = [
  { tool: "kogane.capabilities", args: {}, route: "/api/meta", schema: true },
  { tool: "kogane.context.open", args: {}, route: null },
  {
    tool: "kogane.financial.query",
    args: { intent: "activity" },
    route: "/api/v2/query?intent=activity",
  },
  { tool: "kogane.explain", args: { ref: "observation:transaction:1" }, route: null },
  {
    tool: "kogane.instruments.candidates",
    args: {},
    route: "/api/identity/instrument-candidates",
  },
  { tool: PURCHASES_TOOL_NAME, args: {}, route: "/api/v2/card-purchases" },
  {
    tool: RECONSTRUCTED_STATE_TOOL_NAME,
    args: { account: "acct-synthetic", from: "2026-03-01", to: "2026-03-31" },
    route: "/api/v2/reconstructed-state?account=acct-synthetic&from=2026-03-01&to=2026-03-31",
  },
  {
    tool: "kogane.instruments.history",
    args: { identifierId: "identifier-synthetic" },
    route: "/api/identity/instrument-history?identifierId=identifier-synthetic",
  },
  {
    tool: "kogane.reported-state.read",
    args: { date: "2026-01-01" },
    route: "/api/v2/reported-state?date=2026-01-01",
  },
  { tool: "kogane.instruments.coverage", args: {}, route: "/api/identity/instrument-coverage" },
  { tool: "kogane.accounts.candidates", args: {}, route: "/api/identity/account-candidates" },
  {
    tool: "kogane.accounts.history",
    args: { sourceAccountId: "account-synthetic" },
    route: "/api/identity/account-history?sourceAccountId=account-synthetic",
  },
  {
    tool: "kogane.card-settlements.unmatched",
    args: {},
    route: "/api/v2/reconciliation/card-statements-unmatched",
  },
  {
    tool: "kogane.card-settlements.debit-accounts",
    args: {},
    route: "/api/v2/reconciliation/card-debit-accounts",
  },
  {
    tool: "kogane.card-settlements.read",
    args: {},
    route: "/api/v2/reconciliation/card-settlements",
  },
  {
    tool: "kogane.card-settlements.statements",
    args: {},
    route: "/api/v2/reconciliation/card-settlements/statements",
  },
  {
    tool: "kogane.card-settlements.ownership",
    args: { proposalId: "proposal-synthetic" },
    route: "/api/v2/reconciliation/card-settlements/ownership?proposalId=proposal-synthetic",
  },
  {
    tool: "kogane.economic-readiness.read",
    args: {
      schema: "economic-row-readiness-v1",
      family: "bank-movement",
      knowledge: "current",
      rows: [{ observationId: 1, parseRunId: 1 }],
    },
    route: "/api/v2/economic-readiness?family=bank-movement&observationId=1&parseRunId=1",
    own: true,
  },
  { tool: "kogane.audit.search", args: {}, route: "/api/v2/audit" },
  {
    tool: "kogane.audit.get",
    args: { auditId: "aud_00000000-0000-4000-8000-000000000000" },
    route: null,
  },
];

const harness = (schema: boolean) =>
  pageReadHarness(`agent-read-store-failure${schema ? "-schema" : ""}`, {
    // The card routes are the operator's; the reader is one here, so each
    // route reaches its own read exactly as its tools do.
    OPERATOR_SUBJECTS: '["synthetic-agent","synthetic-reader"]',
    get DB() {
      return failingReads(env.DB, schema);
    },
  });
const pages = { reads: harness(false), schema: harness(true) };

const REFUSAL = { error: "catalogue_read_failed" };

describe("a read tool whose store fails inside its read", () => {
  it("covers every read tool outside the page reads", () => {
    expect(READS.map(({ tool }) => tool).sort()).toEqual(
      [
        ...AGENT_TOOL_NAMES.filter((name) => name !== "kogane.reconcile.propose"),
        PURCHASES_TOOL_NAME,
        RECONSTRUCTED_STATE_TOOL_NAME,
        ...READ_MCP_TOOLS.map(({ name }) => name),
      ].sort(),
    );
  });

  for (const { tool, args, route, schema, own } of READS)
    it(`${tool} answers ${own ? "its service's 503" : "503 catalogue_read_failed"} as its result${route ? `, as ${route.split("?")[0]} does` : ""}`, async () => {
      const page = schema ? pages.schema : pages.reads;
      const log = vi.spyOn(console, "log");
      const error = vi.spyOn(console, "error");
      const last = (await env.DB.prepare(
        "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
      ).first<number>("n"))!;
      let expected: unknown = REFUSAL;
      const answers: unknown[] = [];
      if (route !== null) {
        const routed = await page.route(route);
        expect(routed.status, route).toBe(503);
        const { requestId: _requestId, ...body } = routed.body as Record<string, unknown>;
        if (own) expected = body;
        else expect(body).toEqual(REFUSAL);
        answers.push(routed);
      }

      const overHttp = await page.http(tool, args);
      expect(overHttp.status, tool).toBe(503);
      expect(overHttp.body).toEqual(expected);

      // A tool execution error the client reads, not a failed request.
      const overMcp = await page.mcp(tool, args);
      expect(overMcp.isError, tool).toBe(true);
      expect(overMcp.body).toEqual(expected);
      answers.push(overHttp, overMcp);

      // Each agent call is recorded once, failed with a closed code alone.
      const code = own ? (expected as { reason: string }).reason : REFUSAL.error;
      const recorded = (
        await env.DB.prepare(
          "SELECT path,operation,result,result_code FROM audit_records WHERE rowid>? AND path IN ('agent-http','mcp') ORDER BY rowid",
        )
          .bind(last)
          .all<Record<string, unknown>>()
      ).results;
      const operation = tool.slice("kogane.".length);
      expect(
        recorded.map((row) => [row["path"], row["operation"], row["result"], row["result_code"]]),
      ).toEqual([
        ["agent-http", operation, "failed", code],
        ["mcp", operation, "failed", code],
      ]);
      const logged = [...log.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
      expect(`${JSON.stringify(answers)}\n${logged}\n${JSON.stringify(recorded)}`).not.toContain(
        FAILURE,
      );
    });

  it("answers a refusal its read raises with that status and code alone, as the read tools do", async () => {
    // The observation reader's refusal past its row bound, as one read raises it.
    expect(
      await catalogueTool(async () => {
        throw new HttpError(413, "result_limit_exceeded", ["synthetic-ref"]);
      }),
    ).toEqual({ status: 413, body: { error: "result_limit_exceeded" } });
    expect(
      await catalogueTool(async () => {
        throw new TypeError(FAILURE);
      }),
    ).toEqual({ status: 503, body: REFUSAL });
    const answered = { status: 200, body: { synthetic: true } };
    expect(await catalogueTool(async () => answered)).toBe(answered);
  });

  it("a proposal's store failure stays the Worker's 500 internal_error", async () => {
    const overHttp = await pages.reads.http("kogane.reconcile.propose", {
      kind: "same_account",
      from: "source_account:1",
      to: "source_account:2",
      evidenceRefs: ["observation:transaction:1"],
      reason: "synthetic proposal while the store fails",
      method: "ai",
    });
    expect(overHttp.status).toBe(500);
    expect(overHttp.body).toEqual({ error: "internal_error", requestId: expect.any(String) });
  });
});
