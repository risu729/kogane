// What waits for the owner's decision over the real Worker and the real CORE
// migrations (ADR 0126): `GET /api/v2/decisions/pending` for the operator's
// ホーム page, the agent HTTP route and `kogane.decisions.pending` over MCP
// answer one read. The store holds one undecided pending-to-posted proposal,
// two undecided re-survey proposals and one open plan; each line's counts
// against its own list are exercised in
// packages/application/test/pending-decisions.test.ts. Every value is
// invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PENDING_DECISIONS_MAX_BYTES } from "../../../packages/domain/src/pending-decisions";
import { validPendingDecisions } from "../../../packages/observation-shared/src/pending-decisions-contract";
import type { Grant } from "../../../packages/application/src/index";
import worker from "../src/worker";
import { callTool, toolContext } from "../src/agent-service";
import { readMcpTools } from "../src/read-tools";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const PATH = "/api/v2/decisions/pending";
const AGENT_PATH = "/api/agent/v1/decisions.pending";
const TOOL = "kogane.decisions.pending";
const FULL_GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read"],
  budget: { maxRows: 500, maxProposalTargets: 5, maxExplainDepth: 3 },
};
const MCP_AUDIENCE = "fixture-mcp-audience";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
const future = new Date(Date.now() + 10 * 60_000).toISOString();
const PLAN = "a".repeat(64);

beforeAll(async () => {
  const digest = (n: number) => String(n).padStart(64, "0");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,rationale_codes_json,
      rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
      VALUES('rp_synthetic','pending_to_posted','B',?,'rule','synthetic-v1','[]','[]','[]','proposed',NULL,?,'2099-01-02T00:00:00Z')`).bind(
      JSON.stringify([
        { kind: "transaction", id: "transaction:1", revision: "parse_run:1" },
        { kind: "transaction", id: "transaction:2", revision: "parse_run:2" },
      ]),
      digest(1),
    ),
    ...[1, 2].map((id) =>
      env.DB.prepare(`INSERT INTO maintenance_survey_fetches(id,target_id,source,url,fetched_at,outcome,sha256,object_key,extractor_version,windows)
        VALUES(?,'synthetic-target','vpass','https://synthetic.invalid/notice','2099-01-01T00:00:00Z','extracted',?,?,'synthetic-v1',1)`).bind(
        id,
        digest(id),
        `maintenance-survey/objects/00/${digest(id)}`,
      ),
    ),
    ...[1, 2].map((id) =>
      env.DB.prepare(`INSERT INTO maintenance_survey_proposals(id,fetch_id,target_id,source,kind,rule_id,base_revision,timezone,pattern_json,enabled,scope,status,reasons_json,proposal_key,created_at)
        VALUES(?,?,'synthetic-target','vpass','new',NULL,0,'Asia/Tokyo','{}',1,'collection','proposed','[]',?,?)`).bind(
        id,
        id,
        digest(100 + id),
        `2099-01-0${String(id)}T00:00:00Z`,
      ),
    ),
    env.DB.prepare(`INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
      VALUES(?,'relation.accept','{}','synthetic','{}','{}','synthetic-operator',?,?,'planned')`).bind(
      PLAN,
      new Date().toISOString(),
      future,
    ),
  ]);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://pending-decisions-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

interface CallOptions {
  method?: string;
  body?: unknown;
  subject?: string | null;
}

async function call(path: string, options: CallOptions = {}) {
  const subject = options.subject === undefined ? "synthetic-operator" : options.subject;
  const token =
    subject === null
      ? null
      : await new SignJWT({ type: "app" })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setIssuer(issuer)
          .setAudience(path === "/mcp" ? MCP_AUDIENCE : "fixture-audience")
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey);
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(token ? { "cf-access-jwt-assertion": token } : {}),
      ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return worker.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
    OPERATOR_SUBJECTS: '["synthetic-operator"]',
    AGENT_GRANTS: '["synthetic-agent"]',
    SCHEDULES_ENABLED: "true",
    COMMANDS_ENABLED: "true",
  } as Env);
}

async function mcp(message: Record<string, unknown>, options: CallOptions = {}) {
  const response = await call("/mcp", {
    subject: "synthetic-agent",
    ...options,
    body: { jsonrpc: "2.0", id: 1, ...message },
  });
  return (await response.json()) as Record<string, any>;
}

/** Every table's row count but the audit tables (an agent call's own record is its one write). */
async function tables() {
  const names = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of names.results.filter(
    ({ name }) => name !== "audit_records" && name !== "audit_overflow_counters",
  ))
    counts[name] = (await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<number>(
      "n",
    ))!;
  return counts;
}

/** The answer without its instant, which differs between two reads. */
const timeless = (answer: Record<string, unknown>) => {
  const { asOf: _, ...rest } = answer;
  return rest;
};

describe("GET /api/v2/decisions/pending", () => {
  it("serves the operator one line per kind, under the size bound, and writes nothing", async () => {
    const before = await tables();
    const response = await call(PATH);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(new TextEncoder().encode(text).length).toBeLessThan(PENDING_DECISIONS_MAX_BYTES);
    const answer = JSON.parse(text) as Record<string, any>;
    expect(validPendingDecisions(answer)).toBe(true);
    const lines = Object.fromEntries(
      (answer["kinds"] as Record<string, any>[]).map((line) => [line["kind"], line]),
    );
    expect(lines["pending-posted.link"]).toMatchObject({
      state: "counted",
      count: 1,
      ids: ["rp_synthetic"],
      oldestAt: "2099-01-02T00:00:00Z",
    });
    expect(lines["maintenance-survey.proposal"]).toMatchObject({
      state: "counted",
      count: 2,
      ids: ["1", "2"],
      oldestAt: "2099-01-01T00:00:00Z",
    });
    expect(lines["change-plan.open"]).toMatchObject({ state: "counted", count: 1, ids: [PLAN] });
    expect(lines["card-settlement.statement"]).toMatchObject({ state: "counted", count: 0 });
    expect(await tables()).toEqual(before);
  });

  it("is operator-only, GET-only, and refuses any parameter", async () => {
    expect((await call(PATH, { subject: "synthetic-reader" })).status).toBe(403);
    expect((await call(PATH, { subject: null })).status).toBe(401);
    expect((await call(PATH, { method: "POST", body: {} })).status).toBe(405);
    for (const query of ["?kind=x", "?offset=0", "?=x"]) {
      const response = await call(`${PATH}${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_query" });
    }
  });
});

// A narrower grant is given to the shared service directly, which is where it
// is graded (ADR 0084: no table configures one).
const narrow = (grant: Record<string, unknown>) =>
  ({ principal: "mcp-client:synthetic-agent", ...FULL_GRANT, ...grant }) as Grant;
const direct = (body: unknown, grant: Record<string, unknown>) =>
  callTool(
    TOOL,
    body,
    toolContext(
      { ...env, SCHEDULES_ENABLED: "true", COMMANDS_ENABLED: "true" } as Env,
      narrow(grant),
      "2026-11-07T00:00:00Z",
    ),
  );

describe("kogane.decisions.pending", () => {
  it("answers the same read over HTTP and MCP, and is listed to a whole-store records.read grant only", async () => {
    const listed = await mcp({ method: "tools/list" });
    expect(listed["result"].tools.map((tool: { name: string }) => tool.name)).toContain(TOOL);
    const summaryOnly = readMcpTools(narrow({ capabilities: ["summary.read"] }), {
      reportedState: true,
      cardSettlements: true,
    });
    expect(summaryOnly.map((tool) => tool.name)).not.toContain(TOOL);
    const narrowed = readMcpTools(narrow({ scopes: { sources: ["vpass"], accounts: "*" } }), {
      reportedState: true,
      cardSettlements: true,
    });
    expect(narrowed.map((tool) => tool.name)).not.toContain(TOOL);
    const overRoute = (await (await call(PATH)).json()) as Record<string, unknown>;
    // The operator on the agent HTTP route holds the same authority as an MCP
    // client (ADR 0084); another browser subject reads under its own grant.
    const overAgent = await call(AGENT_PATH, { subject: "synthetic-operator", body: {} });
    expect(overAgent.status).toBe(200);
    expect(timeless((await overAgent.json()) as Record<string, unknown>)).toEqual(
      timeless(overRoute),
    );
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: {} },
    });
    expect(overMcp["result"].isError).toBe(false);
    expect(validPendingDecisions(overMcp["result"].structuredContent)).toBe(true);
    expect(timeless(overMcp["result"].structuredContent)).toEqual(timeless(overRoute));
  });

  it("is graded by the agent's grant and its strict input, and writes nothing", async () => {
    const before = await tables();
    const summary = await direct({}, { capabilities: ["summary.read"] });
    expect(summary.status).toBe(403);
    expect(summary.body).toMatchObject({
      code: "unauthorized",
      refs: ["capability:records.read"],
    });
    const narrowed = await direct({}, { scopes: { sources: ["vpass"], accounts: "*" } });
    expect(narrowed.status).toBe(403);
    expect(narrowed.body).toMatchObject({
      code: "evidence_restricted",
      refs: ["scope:source"],
    });
    // Without schedules.read, the survey line says so; the others answer.
    const noSchedules = await direct({}, {});
    expect(noSchedules.status).toBe(200);
    const surveyLine = (noSchedules.body as { kinds: Record<string, unknown>[] }).kinds.find(
      (line) => line["kind"] === "maintenance-survey.proposal",
    );
    expect(surveyLine).toMatchObject({ state: "unavailable", reason: "unauthorized" });
    // A browser subject outside both lists holds the reader grant, which
    // cannot read a plan (`kogane.command.simulate` needs
    // interpretation.propose): the plans line names no plan id for it. A
    // subject in AGENT_GRANTS, which may plan and simulate, reads it.
    const planLine = async (subject: string) => {
      const response = await call(AGENT_PATH, { subject, body: {} });
      expect(response.status, subject).toBe(200);
      const answer = (await response.json()) as { kinds: Record<string, unknown>[] };
      return answer.kinds.find((line) => line["kind"] === "change-plan.open");
    };
    expect(await planLine("synthetic-reader")).toMatchObject({
      state: "unavailable",
      reason: "unauthorized",
      count: null,
      ids: [],
    });
    expect(await planLine("synthetic-agent")).toMatchObject({
      state: "counted",
      count: 1,
      ids: [PLAN],
    });
    const unknownKey = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: { kind: "x" },
    });
    expect(unknownKey.status).toBe(400);
    expect(await tables()).toEqual(before);
  });

  it("records each served agent call as one read of the lines it answers (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    expect((await call(AGENT_PATH, { subject: "synthetic-agent", body: {} })).status).toBe(200);
    const records = (
      await env.DB.prepare(
        "SELECT path,risk_class,result,diff_json FROM audit_records WHERE operation='decisions.pending' AND rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    expect(records).toEqual([
      {
        path: "agent-http",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({ kind: "read", rows: 9, truncated: false }),
      },
    ]);
  });
});
