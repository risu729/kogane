// The common audit record on this Worker's paths (ADR 0064, plan S1).
//
// Every operator route (`ui`), every agent route (`agent-http`) and every MCP
// tool call (`mcp`) leaves exactly one record: the writer's own effect record
// in its batch, or this Worker's answer record — a read, a replay, a refusal
// (its own or the Processor's), a failure — written once, after the answer,
// under the request id as correlation id. Past a principal's daily caps the
// answer is unchanged and only a counter moves. The operator reads the log at
// `GET /api/v2/audit`. Nothing a caller sent and nothing a provider wrote
// reaches a record. Every value here is synthetic.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import {
  AUDIT_DAILY_CAPS,
  d1CommandStore,
  parseAuditEnvelope,
  processorCall,
  toolOperation,
} from "../../../packages/application/src/index";
import { AGENT_TOOL_NAMES, PURCHASES_TOOL_NAME } from "../src/agent-service";
import { OPS_MCP_TOOLS } from "../src/ops-tools";

/** A provider line with a token-shaped value and an amount in it. */
const PROVIDER_TEXT = "架空商店 eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.dG9rZW4 ¥123,456";
const NEEDLES = ["架空", "eyJ", "c3ludGhldGlj", "123,456", "98765"];
const OPERATOR = "operator@synthetic.test";
const AGENT = "agent@synthetic.test";
const GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read", "interpretation.propose"],
  budget: { maxRows: 500, maxProposalTargets: 20, maxExplainDepth: 6 },
};
const sourceAccounts: string[] = [];
let artifactId = 0;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;

beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  // Provider text and an amount in the store, where the agent tools read them.
  const run = await seedRun({ count: 1, source: "sony-bank" });
  artifactId = run.artifacts[0]!.id;
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'audit-fixture','1','2026-09-07','ok','[]') RETURNING id`)
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.prepare(`INSERT INTO transaction_observations
    (parse_run_id,source_account,external_id,as_of,amount_minor,currency,raw_locator,extra_json,description)
    VALUES (?,'audit-account','1','2026-09-07',98765,'JPY','$','{}',?)`)
    .bind(parse!.id, PROVIDER_TEXT)
    .run();
  for (const account of ["audit-account", "audit-account-two"]) {
    const id = `sa_audit_${account}`;
    await env.DB.prepare(
      "INSERT INTO source_accounts (id,source_id,producer_id,reference_json) VALUES (?,'sony-bank','evidence-test',?)",
    )
      .bind(id, JSON.stringify([account]))
      .run();
    sourceAccounts.push(id);
  }
});
beforeEach(() => {
  issuer = `https://audit-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function token(subject: string) {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience("fixture-audience")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

interface Call {
  method?: string;
  body?: unknown;
  subject?: string;
  headers?: Record<string, string>;
  environment?: Record<string, unknown>;
}

async function call(path: string, options: Call = {}) {
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      "cf-access-jwt-assertion": await token(options.subject ?? OPERATOR),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await worker.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]),
    AGENT_GRANTS: JSON.stringify([AGENT]),
    AGENT_API_GRANTS: JSON.stringify({ [AGENT]: GRANT }),
    COMMANDS_ENABLED: "true",
    OPS_API_ENABLED: "true",
    ...options.environment,
  } as Env);
  return { response, requestId: response.headers.get("x-request-id")! };
}

async function recordsOf(correlationId: string) {
  return (
    await env.DB.prepare("SELECT * FROM audit_records WHERE correlation_id=? ORDER BY rowid")
      .bind(correlationId)
      .all<Record<string, unknown>>()
  ).results;
}

const brief = (row: Record<string, unknown>) => ({
  path: row["path"],
  subject: row["subject"],
  principal: row["principal"],
  principalKind: row["principal_kind"],
  operation: row["operation"],
  result: row["result"],
  resultCode: row["result_code"],
});

/** A Processor stand-in that answers `status`/`body` and records what it was sent. */
function pipeline(
  answer: (request: Request) => Promise<Response> | Response,
  seen: Request[] = [],
): { fetch: (request: Request) => Promise<Response> } {
  return {
    fetch: async (request: Request) => {
      seen.push(request.clone());
      return answer(request);
    },
  };
}

describe("the operator's command routes (ui)", () => {
  it("records a refusal made here once, before anything is forwarded", async () => {
    const forwarded: Request[] = [];
    const environment = { PIPELINE: pipeline(() => Response.json({}), forwarded) };
    const stranger = await call("/api/command/v1/plan", {
      subject: "stranger@synthetic.test",
      body: {},
      environment,
    });
    expect(stranger.response.status).toBe(403);
    expect((await recordsOf(stranger.requestId)).map(brief)).toEqual([
      {
        path: "ui",
        subject: "stranger@synthetic.test",
        principal: "stranger@synthetic.test",
        principalKind: "human",
        operation: "command.plan",
        result: "refused",
        resultCode: "subject_not_granted",
      },
    ]);
    const agent = await call("/api/command/v1/commit", { subject: AGENT, body: {}, environment });
    expect(agent.response.status).toBe(403);
    expect((await recordsOf(agent.requestId)).map(brief)).toEqual([
      {
        path: "ui",
        subject: AGENT,
        principal: AGENT,
        principalKind: "agent",
        operation: "command.commit",
        result: "refused",
        resultCode: "approval_required",
      },
    ]);
    const disabled = await call("/api/command/v1/approve", {
      body: {},
      environment: { ...environment, COMMANDS_ENABLED: "false" },
    });
    expect((await recordsOf(disabled.requestId)).map((row) => row["result_code"])).toEqual([
      "commands_disabled",
    ]);
    // A path that is not a command is not an operation, and is not recorded.
    const unknown = await call("/api/command/v1/delete", { body: {}, environment });
    expect(unknown.response.status).toBe(404);
    expect(await recordsOf(unknown.requestId)).toEqual([]);
    expect(forwarded).toEqual([]);
  });

  it("forwards the envelope, and records the Processor's refusal once, by this Worker", async () => {
    const seen: Request[] = [];
    const refused = await call("/api/command/v1/approve", {
      body: { planId: "0".repeat(64), planDigest: "0".repeat(64) },
      environment: {
        PIPELINE: pipeline(() => Response.json({ error: "stale_context" }, { status: 409 }), seen),
      },
    });
    expect(refused.response.status).toBe(409);
    expect(await refused.response.json()).toEqual({ error: "stale_context" });
    // The Processor received this request's id and path, and nothing to name a delegation.
    expect(seen[0]!.headers.get("x-kogane-correlation-id")).toBe(refused.requestId);
    expect(seen[0]!.headers.get("x-kogane-audit-path")).toBe("ui");
    expect(seen[0]!.headers.has("x-kogane-delegation-ref")).toBe(false);
    expect((await recordsOf(refused.requestId)).map(brief)).toEqual([
      {
        path: "ui",
        subject: OPERATOR,
        principal: OPERATOR,
        principalKind: "human",
        operation: "command.approve",
        result: "refused",
        resultCode: "stale_context",
      },
    ]);
  });

  it("writes nothing when the Processor recorded the effect; a replay and a read are recorded here", async () => {
    const planId = "a".repeat(64);
    const recorded = await call("/api/command/v1/plan", {
      body: { kind: "identity.assign", payload: {} },
      environment: {
        PIPELINE: pipeline(
          () =>
            new Response(JSON.stringify({ plan: { planId }, created: true }), {
              headers: { "content-type": "application/json", "x-kogane-audit-recorded": "1" },
            }),
        ),
      },
    });
    expect(recorded.response.status).toBe(200);
    // The Processor's header never crosses back to the caller.
    expect(recorded.response.headers.has("x-kogane-audit-recorded")).toBe(false);
    expect(await recordsOf(recorded.requestId)).toEqual([]);
    const replay = await call("/api/command/v1/plan", {
      body: { kind: "identity.assign", payload: {} },
      environment: {
        PIPELINE: pipeline(() => Response.json({ plan: { planId }, created: false })),
      },
    });
    const [replayed] = await recordsOf(replay.requestId);
    expect(brief(replayed!)).toMatchObject({ operation: "command.plan", result: "replayed" });
    expect(replayed!["target_ref"]).toBe(`plan:${planId}`);
    const simulated = await call("/api/command/v1/simulate", {
      body: { planId },
      environment: { PIPELINE: pipeline(() => Response.json({ report: {} })) },
    });
    const [read] = await recordsOf(simulated.requestId);
    expect(brief(read!)).toMatchObject({ operation: "command.simulate", result: "read" });
    expect(read!["diff_json"]).toBe('{"kind":"read","rows":1,"truncated":false}');
  });

  it("a lost Processor answer leaves the Processor's applied record and this Worker's failed one", async () => {
    const lost = await call("/api/command/v1/commit", {
      body: { operationId: "op-lost", planId: "b".repeat(64), approvalId: "x" },
      environment: {
        PIPELINE: pipeline(async (request) => {
          // The Processor applies the commit and writes its own record under
          // the envelope it was sent, then its answer is lost.
          const audit = processorCall(
            parseAuditEnvelope(request.headers)!,
            "command.commit",
            request.headers.get("x-kogane-verified-actor")!,
            "human",
          );
          const write = audit.effect(
            {
              targetRef: `plan:${"b".repeat(64)}`,
              refs: ["operation:op-lost"],
              idempotencyKey: "op-lost",
              diff: { kind: "decision", decisionRevisions: 1, commitSeq: null, counts: {} },
            },
            { sql: "1=1", binds: [] },
            { kind: "target-ref", ref: "operation:op-lost" },
          );
          await d1CommandStore(env.DB).batch([write]);
          throw new Error("synthetic lost answer");
        }),
      },
    });
    // The caller's answer is what a lost executor always gave.
    expect(lost.response.status).toBe(500);
    expect(await lost.response.json()).toMatchObject({ error: "internal_error" });
    expect((await recordsOf(lost.requestId)).map(brief)).toEqual([
      {
        path: "ui",
        subject: OPERATOR,
        principal: OPERATOR,
        principalKind: "human",
        operation: "command.commit",
        result: "applied",
        resultCode: null,
      },
      {
        path: "ui",
        subject: OPERATOR,
        principal: OPERATOR,
        principalKind: "human",
        operation: "command.commit",
        result: "failed",
        resultCode: "upstream_unavailable",
      },
    ]);
  });
});

describe("the operations routes (ui)", () => {
  it("records an acceptance in its batch, a re-send as a replay and a refusal without its value", async () => {
    const body = {
      source: "sony-bank",
      requestedScope: { from: "2026-01-01", to: "2026-01-31" },
      idempotencyKey: "audit-ops-1",
    };
    const first = await call("/api/ops/v1/collections", { body });
    expect(first.response.status).toBe(202);
    const { operationId } = (await first.response.json()) as { operationId: string };
    const [accepted] = await recordsOf(first.requestId);
    expect(brief(accepted!)).toMatchObject({
      operation: "ops.collection.request",
      result: "accepted",
      principalKind: "human",
    });
    expect(accepted).toMatchObject({
      target_ref: operationId,
      scope_namespace: "core-source",
      scope_source: "sony-bank",
      idempotency_key: "audit-ops-1",
      diff_json: '{"kind":"request","status":"accepted"}',
    });
    const again = await call("/api/ops/v1/collections", { body });
    expect(again.response.status).toBe(202);
    expect(
      (await recordsOf(again.requestId)).map((row) => [row["result"], row["target_ref"]]),
    ).toEqual([["replayed", operationId]]);
    // A refused value is never echoed: the record names the field, not the value.
    const bad = await call("/api/ops/v1/collections", {
      body: { ...body, source: `${PROVIDER_TEXT}` },
    });
    expect(bad.response.status).toBe(400);
    const [refused] = await recordsOf(bad.requestId);
    expect(brief(refused!)).toMatchObject({ result: "refused", resultCode: "invalid_request" });
    expect(refused!["refs_json"]).toBe('["field:source"]');
    expect(refused!["target_ref"]).toBeNull();
    expect(refused!["scope_source"]).toBeNull();
    const read = await call(`/api/ops/v1/operations/${operationId}`);
    expect(read.response.status).toBe(200);
    expect(
      (await recordsOf(read.requestId)).map((row) => [row["operation"], row["result"]]),
    ).toEqual([["ops.operation.get", "read"]]);
  });

  it("an agent is refused the operations routes, and the refusal is recorded under its kind", async () => {
    const refused = await call("/api/ops/v1/projections", {
      subject: AGENT,
      body: { reason: PROVIDER_TEXT },
    });
    expect(refused.response.status).toBe(403);
    expect((await recordsOf(refused.requestId)).map(brief)).toEqual([
      {
        path: "ui",
        subject: AGENT,
        principal: AGENT,
        principalKind: "agent",
        operation: "ops.projection.request",
        result: "refused",
        resultCode: "approval_required",
      },
    ]);
  });
});

describe("the schedule settings routes (ui)", () => {
  const settings = (suffix: string, answer: () => Response, extra: Call = {}) =>
    call(`/api/ops/v1/schedules${suffix}`, {
      method: "POST",
      body: { revision: 1 },
      headers: { origin: "https://fixture.test", "x-kogane-settings": "1" },
      ...extra,
      environment: { SCHEDULES_ENABLED: "true", PIPELINE: pipeline(answer), ...extra.environment },
    });

  it("records a write's refusal here or the Processor's, once; the page load is not recorded", async () => {
    const crossSite = await settings("/sony-bank", () => Response.json({ saved: true }), {
      headers: { origin: "https://elsewhere.invalid", "x-kogane-settings": "1" },
    });
    expect(crossSite.response.status).toBe(403);
    expect(
      (await recordsOf(crossSite.requestId)).map((row) => [row["operation"], row["result_code"]]),
    ).toEqual([["schedules.job.update", "same_origin_required"]]);
    const conflict = await settings("/sony-bank", () =>
      Response.json({ error: "revision_conflict" }, { status: 409 }),
    );
    expect(conflict.response.status).toBe(409);
    expect(
      (await recordsOf(conflict.requestId)).map((row) => [row["result"], row["result_code"]]),
    ).toEqual([["refused", "revision_conflict"]]);
    const saved = await settings(
      "/leases/sony-bank",
      () =>
        new Response('{"released":true}', {
          headers: { "content-type": "application/json", "x-kogane-audit-recorded": "1" },
        }),
    );
    expect(saved.response.status).toBe(200);
    expect(saved.response.headers.has("x-kogane-audit-recorded")).toBe(false);
    expect(await recordsOf(saved.requestId)).toEqual([]);
    const page = await call("/api/ops/v1/schedules", {
      environment: { SCHEDULES_ENABLED: "true", PIPELINE: pipeline(() => Response.json({})) },
    });
    expect(page.response.status).toBe(200);
    expect(await recordsOf(page.requestId)).toEqual([]);
    // A rejection changes no rule: its refusal is recorded under R1, an acceptance under R2.
    for (const [decision, risk] of [
      ["reject", "R1"],
      ["accept", "R2"],
    ] as const) {
      const decided = await settings(
        "/proposals/9",
        () => Response.json({ error: "proposal_already_decided" }, { status: 409 }),
        { body: { decision } },
      );
      expect(
        (await recordsOf(decided.requestId)).map((row) => [row["result_code"], row["risk_class"]]),
      ).toEqual([["proposal_already_decided", risk]]);
    }
    const lost = await settings("/proposals/7", () => {
      throw new Error("synthetic");
    });
    expect(lost.response.status).toBe(503);
    expect(
      (await recordsOf(lost.requestId)).map((row) => [
        row["operation"],
        row["result"],
        row["result_code"],
      ]),
    ).toEqual([["schedules.survey.decide", "failed", "upstream_unavailable"]]);
  });
});

describe("the agent routes (agent-http) and MCP (mcp)", () => {
  it("every tool this Worker serves names a catalogued operation, so none goes unrecorded", () => {
    for (const tool of [...AGENT_TOOL_NAMES, PURCHASES_TOOL_NAME]) {
      expect(toolOperation(tool, "agent-http"), tool).not.toBeNull();
      expect(toolOperation(tool, "mcp"), tool).not.toBeNull();
    }
    for (const { name } of OPS_MCP_TOOLS) expect(toolOperation(name, "mcp"), name).not.toBeNull();
  });

  it("records every tool call: reads as row counts, a proposal in its batch, refusals by code", async () => {
    const capabilities = await call("/api/agent/v1/capabilities", { subject: AGENT, body: {} });
    expect(capabilities.response.status).toBe(200);
    expect((await recordsOf(capabilities.requestId)).map(brief)).toEqual([
      {
        path: "agent-http",
        subject: AGENT,
        principal: AGENT,
        principalKind: "agent",
        operation: "capabilities",
        result: "read",
        resultCode: null,
      },
    ]);
    const query = await call("/api/agent/v1/financial.query", {
      subject: AGENT,
      body: { intent: "activity" },
    });
    expect(query.response.status).toBe(200);
    // The answer carries the provider's line; its record carries a count.
    expect(JSON.stringify(await query.response.json())).toContain("eyJ");
    const [read] = await recordsOf(query.requestId);
    expect(brief(read!)).toMatchObject({ operation: "financial.query", result: "read" });
    expect(JSON.parse(read!["diff_json"] as string)).toMatchObject({ kind: "read", rows: 1 });
    const proposed = await call("/api/agent/v1/reconcile.propose", {
      subject: AGENT,
      body: {
        kind: "same_account",
        from: `source_account:${sourceAccounts[0]}`,
        to: `source_account:${sourceAccounts[1]}`,
        evidenceRefs: [`fetch_artifact:${artifactId}`],
        reason: PROVIDER_TEXT,
        method: "ai",
      },
    });
    expect(proposed.response.status).toBe(200);
    const receipt = (await proposed.response.json()) as { decisionRevisionId: string };
    const rows = await recordsOf(proposed.requestId);
    expect(rows.map((row) => [row["operation"], row["result"], row["risk_class"]])).toEqual([
      ["reconcile.propose", "applied", "R1"],
    ]);
    expect(JSON.parse(rows[0]!["refs_json"] as string)).toEqual([
      `decision:${receipt.decisionRevisionId}`,
    ]);
    // The proposal and its record are one batch: the decision row exists.
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM decision_revisions WHERE id=?")
        .bind(receipt.decisionRevisionId)
        .first<number>("n"),
    ).toBe(1);
    // No grant: refused on the tool the path names.
    const ungranted = await call("/api/agent/v1/capabilities", {
      subject: "stranger@synthetic.test",
      body: {},
    });
    expect(ungranted.response.status).toBe(403);
    expect(
      (await recordsOf(ungranted.requestId)).map((row) => [row["operation"], row["result_code"]]),
    ).toEqual([["capabilities", "agent_api_not_configured"]]);
    // A path no tool serves is not an operation.
    const unknown = await call("/api/agent/v1/audit.search", { subject: AGENT, body: {} });
    expect(unknown.response.status).toBe(404);
    expect(await recordsOf(unknown.requestId)).toEqual([]);
  });

  it("records each MCP tool call, and nothing for the protocol's own messages", async () => {
    const mcp = (message: Record<string, unknown>, subject = AGENT) =>
      call("/mcp", { subject, body: { jsonrpc: "2.0", id: 1, ...message } });
    for (const method of ["initialize", "tools/list", "ping"]) {
      const quiet = await mcp({ method });
      expect(await recordsOf(quiet.requestId)).toEqual([]);
    }
    const tool = await mcp({
      method: "tools/call",
      params: { name: "kogane.capabilities", arguments: {} },
    });
    expect((await recordsOf(tool.requestId)).map(brief)).toEqual([
      {
        path: "mcp",
        subject: AGENT,
        principal: AGENT,
        principalKind: "agent",
        operation: "capabilities",
        result: "read",
        resultCode: null,
      },
    ]);
    const unknown = await mcp({
      method: "tools/call",
      params: { name: "kogane.nothing", arguments: {} },
    });
    expect(await recordsOf(unknown.requestId)).toEqual([]);
    const ungranted = await mcp({ method: "tools/list" }, "stranger@synthetic.test");
    expect(ungranted.response.status).toBe(403);
    expect(
      (await recordsOf(ungranted.requestId)).map((row) => [
        row["path"],
        row["operation"],
        row["result_code"],
      ]),
    ).toEqual([["mcp", "mcp.request", "agent_api_not_configured"]]);
  });

  it("a proposal whose audit record cannot be written is not stored either", async () => {
    const rows = async () =>
      (await env.DB.prepare(
        "SELECT (SELECT count(*) FROM decision_revisions) AS decisions,(SELECT count(*) FROM audit_records) AS records",
      ).first<{ decisions: number; records: number }>())!;
    const before = await rows();
    // A synthetic trigger makes every audit insert raise, as a record the
    // table refused would: the proposal's batch must be rolled back with it.
    await env.DB.prepare(
      "CREATE TRIGGER review_audit_write_fails BEFORE INSERT ON audit_records BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END",
    ).run();
    let answer: { status: number; body: unknown };
    try {
      const proposed = await call("/api/agent/v1/reconcile.propose", {
        subject: AGENT,
        body: {
          kind: "same_account",
          from: `source_account:${sourceAccounts[0]}`,
          to: `source_account:${sourceAccounts[1]}`,
          evidenceRefs: [`fetch_artifact:${artifactId}`],
          reason: "synthetic proposal whose record fails",
          method: "ai",
        },
      });
      answer = { status: proposed.response.status, body: await proposed.response.json() };
    } finally {
      await env.DB.prepare("DROP TRIGGER review_audit_write_fails").run();
    }
    // The proposal tool answers any failed append with its existing code.
    expect(answer).toMatchObject({ status: 409, body: { code: "idempotency_conflict" } });
    expect(await rows()).toEqual(before);
  });
});

describe("the operations MCP tools (mcp)", () => {
  it("records an acceptance in its batch and a re-send as a replay of the same operation", async () => {
    const environment = { AGENT_API_GRANTS: JSON.stringify({ [OPERATOR]: GRANT }) };
    const request = (id: number) =>
      call("/mcp", {
        body: {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "kogane.ops.import.request",
            arguments: {
              source: "sony-bank",
              runId: "run-audit-mcp",
              idempotencyKey: "audit-mcp-1",
            },
          },
        },
        environment,
      });
    const first = await request(1);
    const [accepted] = await recordsOf(first.requestId);
    expect(brief(accepted!)).toEqual({
      path: "mcp",
      subject: OPERATOR,
      principal: OPERATOR,
      principalKind: "human",
      operation: "ops.import.request",
      result: "accepted",
      resultCode: null,
    });
    const second = await request(2);
    const [replayed] = await recordsOf(second.requestId);
    expect([replayed!["result"], replayed!["target_ref"]]).toEqual([
      "replayed",
      accepted!["target_ref"],
    ]);
  });
});

describe("daily caps", () => {
  async function seedDay(principal: string, result: "read" | "refused", count: number) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?3)
       INSERT INTO audit_records(audit_id,recorded_at,path,subject,principal,principal_kind,operation,risk_class,step,result,result_code,correlation_id,refs_json,diff_json)
       SELECT 'aud_'||printf('%08x',i)||'-0000-4000-8000-'||printf('%012x',?4),?5,'agent-http',?1,?1,'agent','capabilities','R0','call',?2,
         CASE WHEN ?2='refused' THEN 'evidence_restricted' END,'00000000-0000-4000-8000-000000000000','[]',
         CASE WHEN ?2='read' THEN '{"kind":"read","rows":1,"truncated":false}' ELSE '{"kind":"none"}' END FROM n`,
    )
      .bind(principal, result, count, result === "read" ? 1 : 2, now)
      .run();
  }

  it("past the read and refusal caps the answer is unchanged and only the day's counter moves", async () => {
    const capped = "capped-agent@synthetic.test";
    await seedDay(capped, "read", AUDIT_DAILY_CAPS.read);
    await seedDay(capped, "refused", AUDIT_DAILY_CAPS.refused);
    const environment = { AGENT_API_GRANTS: JSON.stringify({ [capped]: GRANT }) };
    const served = await call("/api/agent/v1/capabilities", {
      subject: capped,
      body: {},
      environment,
    });
    expect(served.response.status).toBe(200);
    expect(await recordsOf(served.requestId)).toEqual([]);
    const refused = await call("/api/agent/v1/explain", {
      subject: capped,
      body: { ref: PROVIDER_TEXT },
      environment,
    });
    expect(refused.response.status).toBe(400);
    expect(await recordsOf(refused.requestId)).toEqual([]);
    expect(
      (
        await env.DB.prepare(
          "SELECT path,result,count FROM audit_overflow_counters WHERE principal=? ORDER BY result",
        )
          .bind(capped)
          .all()
      ).results,
    ).toEqual([
      { path: "agent-http", result: "read", count: 1 },
      { path: "agent-http", result: "refused", count: 1 },
    ]);
  });
});

describe("the operator's read and the never-recorded list", () => {
  it("serves the whole store to the operator only, filtered before its limit", async () => {
    expect((await call("/api/v2/audit", { subject: AGENT })).response.status).toBe(403);
    expect((await call("/api/v2/audit?bogus=1")).response.status).toBe(400);
    expect((await call("/api/v2/audit?result=nope")).response.status).toBe(400);
    const page = await call("/api/v2/audit?result=refused");
    expect(page.response.status).toBe(200);
    const body = (await page.response.json()) as {
      schemaVersion: string;
      records: { result: string }[];
      cursor: string | null;
    };
    expect(body.schemaVersion).toBe("kogane-audit-page-v1");
    expect(body.records.length).toBeGreaterThan(0);
    expect(body.records.length).toBeLessThanOrEqual(50);
    expect(body.records.every((record) => record.result === "refused")).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["cursor", "records", "schemaVersion"]);
    // Reading the log is a page load: it is not recorded.
    expect(await recordsOf(page.requestId)).toEqual([]);
    if (body.cursor !== null) {
      const stale = await call(`/api/v2/audit?result=read&cursor=${body.cursor}`);
      expect(stale.response.status).toBe(409);
    }
  });

  it("no record holds provider text, a token-shaped value or an amount", async () => {
    const rows = (await env.DB.prepare("SELECT * FROM audit_records").all()).results;
    expect(rows.length).toBeGreaterThan(10);
    const stored = JSON.stringify(rows);
    for (const needle of NEEDLES) expect(stored).not.toContain(needle);
  });
});
