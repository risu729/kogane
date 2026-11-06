// `/api/v2/activity` and `/api/v2/obligations` (A10). The routes are 404 unless
// the projection table exists, they are GET-only behind the existing Access
// gate, and every figure they return names its basis and its explanation refs.
// Their agent tool `kogane.events.read` answers the same pages on both agent
// paths. Every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS_TOOL_NAME, READ_MCP_TOOLS } from "../src/read-tools";
import worker from "../src/worker";
import { seedRegistry } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const TOOL_PATH = "/api/agent/v1/events.read";
const FULL_GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read"],
  budget: { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 3 },
};
/** The MCP Access application's audience (ADR 0047); `/mcp` accepts nothing else. */
const MCP_AUDIENCE = "fixture-mcp-audience";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

beforeAll(async () => {
  await seedRegistry().catch(() => undefined);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  await seedProjection();
});
beforeEach(() => {
  issuer = `https://events-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

const DATE = '{"kind":"local-date","value":"2026-03-01","zone":null,"basis":"provider"}';

/** One synthetic purchase event with two bases, and one obligation with a settlement. */
async function seedProjection() {
  const decision = (id: string, subjectRef: string) =>
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,1,'accept','rule','rule:test',NULL,'synthetic','[]',NULL,NULL,'2026-03-01T00:00:00Z')`,
    ).bind(id, subjectRef);
  await env.DB.batch([
    decision("dr_ev_1", "event:ev-1"),
    env.DB.prepare(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
       VALUES('ev-1',1,'purchase','captured',NULL,?,'purchase-recognition','[{"kind":"transaction","id":"transaction:1","revision":"parse_run:1"}]','dr_ev_1',NULL,'2026-03-01T00:00:00Z')`,
    ).bind(DATE),
    env.DB.prepare(
      "INSERT INTO economic_legs VALUES('ev-1',1,0,'account:card','JPY','exact','3000',0,NULL,'decrease','cash-movement')",
    ),
    env.DB.prepare(
      "INSERT INTO economic_legs VALUES('ev-1',1,1,'claim:cost','JPY','exact','3000',0,NULL,'increase','purchase-recognition')",
    ),
    decision("dr_obl_1", "obligation:obl-1"),
    env.DB.prepare(
      `INSERT INTO obligation_revisions(obligation_id,revision,creditor_ref,debtor_ref,principal_unit_ref,principal_status,principal_coefficient,principal_scale,fee_components_json,schedule_json,state,unknown_reason,state_evidence_refs_json,decision_revision_id,superseded_by,created_at)
       VALUES('obl-1',1,'party:issuer','party:self','JPY','exact','12000',0,'[]','[]','partially-settled',NULL,'["transaction:1"]','dr_obl_1',NULL,'2026-03-01T00:00:00Z')`,
    ),
    decision("dr_st_1", "settlement:st-1"),
    env.DB.prepare(
      `INSERT INTO settlement_relations(id,obligation_id,settlement_component_ref,unit_ref,coefficient,scale,occurred_json,unresolved_coefficient,unresolved_scale,decision_revision_id,superseded_by,created_at)
       VALUES('st-1','obl-1','leg:ev-1#0','JPY','4000',0,?,NULL,NULL,'dr_st_1',NULL,'2026-03-01T00:00:00Z')`,
    ).bind(DATE),
  ]);
}

async function token(subject = "synthetic-user", audience = "fixture-audience") {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

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

async function call(
  path: string,
  options: {
    retired?: string;
    schema?: boolean;
    jwt?: string | null;
    method?: string;
    subject?: string;
    body?: unknown;
    environment?: Record<string, unknown>;
  } = {},
) {
  const jwt =
    options.jwt === undefined
      ? await token(options.subject, path === "/mcp" ? MCP_AUDIENCE : "fixture-audience")
      : options.jwt;
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}),
      // What an MCP client sends on every POST (Streamable HTTP).
      ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return worker.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    DB: options.schema === false ? withoutEventsTable(env.DB) : env.DB,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
    ...(options.retired === undefined ? {} : { EVENTS_V2_ENABLED: options.retired }),
    ...options.environment,
  } as Env);
}

describe("events v2 capability gate", () => {
  it("stays available when the retired flag is set and the projection exists", async () => {
    for (const retired of ["0", "false", "1", "true"]) {
      for (const path of ["/api/v2/activity", "/api/v2/obligations"]) {
        const response = await call(path, { retired });
        expect(response.status, `${path} ${retired}`).toBe(200);
      }
      const meta = await (await call("/api/meta", { retired })).json();
      expect(meta).toMatchObject({ capabilities: { eventsV2: true } });
    }
  });

  it("is absent when the projection table is missing, even if the retired flag is on", async () => {
    for (const path of ["/api/v2/activity", "/api/v2/obligations"]) {
      const response = await call(path, { schema: false, retired: "true" });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "not_found" });
    }
    const meta = await (await call("/api/meta", { schema: false, retired: "true" })).json();
    expect(meta).toMatchObject({ capabilities: { eventsV2: false } });
  });

  it("stays behind the Access gate and stays GET-only", async () => {
    expect((await call("/api/v2/activity", { jwt: null })).status).toBe(401);
    expect((await call("/api/v2/activity", { method: "POST" })).status).toBe(405);
  });
});

describe("GET /api/v2/activity", () => {
  it("returns the page envelope with the basis and the explanation chain", async () => {
    const response = await call("/api/v2/activity?basis=cash-movement");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apiVersion: number;
      basis: string;
      items: {
        eventId: string;
        kind: string;
        totals: { basis: string; quantity: { unitRef: string } }[];
        explanationRefs: string[];
      }[];
      nextCursor: string | null;
      dataCoverage: { scopeRef: string; truncated: boolean };
    };
    expect(body.apiVersion).toBe(2);
    expect(body.basis).toBe("cash-movement");
    expect(body.nextCursor).toBeNull();
    expect(body.dataCoverage).toMatchObject({ scopeRef: "activity:cash-movement" });
    const event = body.items.find((item) => item.eventId === "ev-1")!;
    expect(event.kind).toBe("purchase");
    // Cash out and cost recognised at purchase are separate totals.
    expect(event.totals.map((total) => total.basis)).toEqual([
      "cash-movement",
      "purchase-recognition",
    ]);
    expect(event.explanationRefs[0]).toBe("event:ev-1@1");
    expect(event.explanationRefs).toContain("decision_revision:dr_ev_1");
  });

  it("defaults to the cash-movement basis and refuses an unknown one", async () => {
    const body = (await (await call("/api/v2/activity")).json()) as { basis: string };
    expect(body.basis).toBe("cash-movement");
    expect((await call("/api/v2/activity?basis=tax")).status).toBe(400);
    expect((await call("/api/v2/activity?unknown=1")).status).toBe(400);
    expect((await call("/api/v2/activity?offset=-1")).status).toBe(400);
  });
});

describe("GET /api/v2/obligations", () => {
  it("computes the outstanding amount from settlements with exact values", async () => {
    const body = (await (await call("/api/v2/obligations")).json()) as {
      apiVersion: number;
      items: {
        obligationId: string;
        state: string;
        outstanding: { unitRef: string; value: { value: { coefficient: string } } } | null;
        outstandingReasonCode: string | null;
        explanationRefs: string[];
      }[];
    };
    expect(body.apiVersion).toBe(2);
    const obligation = body.items.find((item) => item.obligationId === "obl-1")!;
    expect(obligation.state).toBe("partially-settled");
    expect(obligation.outstanding?.value.value.coefficient).toBe("8000");
    expect(obligation.outstandingReasonCode).toBeNull();
    expect(obligation.explanationRefs).toContain("settlement:st-1");
  });

  it("accepts no query parameter other than offset", async () => {
    expect((await call("/api/v2/obligations?basis=cash-movement")).status).toBe(400);
    expect((await call("/api/v2/obligations?offset=0")).status).toBe(200);
  });
});

describe("the agent tool", () => {
  // Through `/mcp` the same subject is the agent-only `mcp-client:<sub>`
  // (ADR 0047), so it has a grant under that name too.
  const withGrant = (grant: unknown) => ({
    AGENT_API_GRANTS: JSON.stringify({
      "agent-principal": grant,
      "mcp-client:agent-principal": grant,
    }),
  });
  const granted = withGrant(FULL_GRANT);
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
  const http = (
    args: unknown,
    options: { environment?: Record<string, unknown>; schema?: boolean } = {},
  ) =>
    call(TOOL_PATH, {
      subject: "agent-principal",
      body: args,
      environment: options.environment ?? granted,
      ...(options.schema === undefined ? {} : { schema: options.schema }),
    });
  const mcpCall = async (
    args: unknown,
    options: { environment?: Record<string, unknown>; schema?: boolean } = {},
  ) =>
    (await (
      await call("/mcp", {
        subject: "agent-principal",
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: EVENTS_TOOL_NAME, arguments: args },
        },
        environment: options.environment ?? granted,
        ...(options.schema === undefined ? {} : { schema: options.schema }),
      })
    ).json()) as {
      result?: { isError: boolean; structuredContent: Record<string, unknown> };
      error?: { code: number; message: string };
    };
  /** Rows of the tables the routes read: none may change. */
  const counts = async () =>
    await env.DB.prepare(
      `SELECT (SELECT count(*) FROM economic_event_revisions) AS events,
              (SELECT count(*) FROM obligation_revisions) AS obligations,
              (SELECT count(*) FROM settlement_relations) AS settlements,
              (SELECT count(*) FROM decision_revisions) AS decisions`,
    ).first();

  it("answers on both agent paths exactly what the routes answer, and writes nothing", async () => {
    const before = await counts();
    const cases: [string, Record<string, unknown>][] = [
      ["/api/v2/activity", { list: "activity" }],
      [
        "/api/v2/activity?basis=purchase-recognition",
        { list: "activity", basis: "purchase-recognition" },
      ],
      [
        "/api/v2/activity?basis=cash-movement&offset=1",
        { list: "activity", basis: "cash-movement", offset: 1 },
      ],
      ["/api/v2/obligations", { list: "obligations" }],
      ["/api/v2/obligations?offset=0", { list: "obligations", offset: 0 }],
    ];
    for (const [path, args] of cases) {
      const route = (await (await call(path)).json()) as Record<string, unknown>;
      const response = await http(args);
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toEqual(route);
      const viaMcp = await mcpCall(args);
      expect(viaMcp.result?.isError, path).toBe(false);
      expect(viaMcp.result?.structuredContent, path).toEqual(route);
    }
    // The seeded event and obligation are there, so no comparison is of two empty pages.
    const activity = (await (await http({ list: "activity" })).json()) as { items: unknown[] };
    const obligations = (await (await http({ list: "obligations" })).json()) as {
      items: unknown[];
    };
    expect(activity.items).toHaveLength(1);
    expect(obligations.items).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });

  it("is listed with the routes' parameters to a whole-store records.read grant only", async () => {
    const tool = READ_MCP_TOOLS.find((entry) => entry.name === EVENTS_TOOL_NAME)!;
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["list"],
      properties: {
        list: { type: "string", enum: ["activity", "obligations"] },
        basis: { type: "string", enum: ["cash-movement", "purchase-recognition"] },
        offset: { type: "integer" },
      },
    });
    expect(Object.keys(tool.inputSchema["properties"] as object).sort()).toEqual([
      "basis",
      "list",
      "offset",
    ]);
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(await listed(granted)).toContain(EVENTS_TOOL_NAME);
    for (const grant of [
      { ...FULL_GRANT, capabilities: ["summary.read"] },
      { ...FULL_GRANT, scopes: { sources: ["synthetic-source"], accounts: "*" } },
      { ...FULL_GRANT, scopes: { sources: "*", accounts: ["acct-synthetic"] } },
    ])
      expect(await listed(withGrant(grant))).not.toContain(EVENTS_TOOL_NAME);
    expect(await listed(granted, false)).not.toContain(EVENTS_TOOL_NAME);
  });

  it("refuses with the routes' codes and the same status on both agent paths", async () => {
    // [tool arguments, the equivalent route request or null, expected code]
    const cases: [unknown, string | null, string][] = [
      [
        { list: "obligations", basis: "cash-movement" },
        "/api/v2/obligations?basis=cash-movement",
        "invalid_query",
      ],
      [{ list: "activity", offset: -1 }, "/api/v2/activity?offset=-1", "invalid_offset"],
      [
        { list: "obligations", offset: 1_000_001 },
        "/api/v2/obligations?offset=1000001",
        "invalid_offset",
      ],
      [{}, null, "invalid_request"],
      // The basis is a closed list in the schema; the route refuses the same
      // values as `invalid_query`.
      [{ list: "activity", basis: "tax" }, null, "invalid_request"],
      [{ list: "activity", basis: "" }, null, "invalid_request"],
      [{ list: "positions" }, null, "invalid_request"],
      [{ list: "activity", offset: 1.5 }, null, "invalid_request"],
      [{ list: "activity", offset: "1" }, null, "invalid_request"],
      [{ list: "activity", cursor: "200" }, null, "invalid_request"],
    ];
    for (const [args, path, code] of cases) {
      const label = JSON.stringify(args);
      if (path !== null) {
        const route = await call(path);
        expect(route.status, label).toBe(400);
        expect(((await route.json()) as { error: string }).error, label).toBe(code);
      }
      const response = await http(args);
      expect(response.status, label).toBe(400);
      expect(await response.json(), label).toEqual({ error: code });
      const viaMcp = await mcpCall(args);
      expect(viaMcp.result?.isError, label).toBe(true);
      expect(viaMcp.result?.structuredContent, label).toEqual({ error: code });
    }
  });

  it("needs records.read over the whole store, checked before the body is validated", async () => {
    const refusals: [unknown, Record<string, unknown>][] = [
      [
        { ...FULL_GRANT, capabilities: ["summary.read"] },
        { code: "unauthorized", refs: ["capability:records.read"] },
      ],
      [
        { ...FULL_GRANT, scopes: { sources: ["synthetic-source"], accounts: "*" } },
        { code: "evidence_restricted", refs: ["scope:source"] },
      ],
      [
        { ...FULL_GRANT, scopes: { sources: "*", accounts: ["acct-synthetic"] } },
        { code: "evidence_restricted", refs: ["scope:account"] },
      ],
    ];
    for (const [grant, expected] of refusals) {
      // A malformed body is not reached: the grant decides first.
      const response = await http({ list: "nothing" }, { environment: withGrant(grant) });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        schemaVersion: "financial-error-v1",
        ...expected,
      });
      const viaMcp = await mcpCall({ list: "activity" }, { environment: withGrant(grant) });
      expect(viaMcp.result?.isError).toBe(true);
      expect(viaMcp.result?.structuredContent).toMatchObject(expected);
    }
    // No grant at all, and no Access identity.
    expect((await http({ list: "activity" }, { environment: {} })).status).toBe(403);
    expect(
      (await call(TOOL_PATH, { jwt: null, body: { list: "activity" }, environment: granted }))
        .status,
    ).toBe(401);
  });

  it("is neither a tool nor a path where the routes are absent", async () => {
    expect((await mcpCall({ list: "activity" }, { schema: false })).error).toEqual({
      code: -32602,
      message: "unknown_tool",
    });
    expect((await http({ list: "activity" }, { schema: false })).status).toBe(404);
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
    await mcpCall({ list: "activity" }, { schema: false });
    await http({ list: "activity" }, { schema: false });
    expect(await records()).toEqual([]);
    expect((await http({ list: "activity" })).status).toBe(200);
    await mcpCall({ list: "obligations" });
    // One event, then one obligation: one row each, and no amount, ref or date.
    const read = {
      principal_kind: "agent",
      operation: "events.read",
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
