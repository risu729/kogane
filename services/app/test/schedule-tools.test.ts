// The maintenance tools (ADR 0046 as amended by ADR 0063 item 8; plan slice
// S4) over the real App Worker, wired to the Processor's real settings route
// (`scheduleRoute`) and the real `ScheduleAlarm.reconcile` code over this
// test's CORE store. The Durable Object's storage is an in-memory stand-in, so
// nothing here fires an alarm or contacts a provider;
// services/processor/test/schedule-agent-maintenance.test.ts covers the writer
// with native workerd alarms. Every principal, host, delegation and window is
// synthetic.
//
// What is shown: the read is one function on both agent paths (HTTP and MCP
// answer the same object) and records a `read`; the revision is reachable only
// as a delegated MCP operation, which no delegation can execute yet, so every
// call of it — with or without a delegation, in scope or not — is a closed,
// recorded refusal that relays nothing and writes no revision.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { scheduleUpdateSchema } from "../src/schedule-tools";
import { scheduleRoute } from "../../processor/src/schedule-store";
import { ScheduleAlarm } from "../../processor/src/schedule-alarm";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const OWNER = "maintenance-owner-synthetic";
const OWNER_MCP = `mcp-client:${OWNER}`;
const READER = "maintenance-reader-synthetic";
const FINANCIAL = "financial-agent-synthetic";
const REVIEWER = "reviewer-owner-synthetic";
const APP_AUD = "fixture-browser-audience";
const MCP_AUD = "fixture-mcp-audience";
const REFERENCE = "https://maintenance.synthetic.test/notices";
/** A token-shaped value and an amount, placed where a caller can put text. */
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.dG9rZW4";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BUDGET = { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 1 };
const scheduleGrant = (scheduleSources: string[] | "*") => ({
  scopes: { sources: [], accounts: [], scheduleSources },
  capabilities: ["schedules.read"],
  budget: BUDGET,
});
const financialGrant = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read", "evidence.read", "interpretation.propose"],
  budget: BUDGET,
};
/** Each subject has the same grant on the browser route and as its MCP client. */
const GRANTS = {
  [OWNER]: scheduleGrant(["vpass", "sony-bank"]),
  [OWNER_MCP]: scheduleGrant(["vpass", "sony-bank"]),
  [READER]: scheduleGrant(["vpass"]),
  [`mcp-client:${READER}`]: scheduleGrant(["vpass"]),
  [FINANCIAL]: financialGrant,
  [`mcp-client:${FINANCIAL}`]: financialGrant,
  [`mcp-client:${REVIEWER}`]: {
    scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
    capabilities: ["summary.read"],
    budget: BUDGET,
  },
};
/** The owner's maintainer delegation to its own MCP identity (ADR 0063), valid now. */
const MAINTAINER = {
  delegatedBy: OWNER,
  role: "maintainer",
  scopes: { sources: [], accounts: [], scheduleSources: ["vpass"] },
  issuedAt: iso(Date.now() - DAY),
  notAfter: iso(Date.now() + 30 * DAY),
  budget: { writesPerDay: 30 },
};
const delegations = (entries: Record<string, unknown>) => JSON.stringify(entries);

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;
let rpc = 0;

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
    // The real methods, without the platform constructor this runtime refuses.
    return Object.assign(Object.create(ScheduleAlarm.prototype) as ScheduleAlarm, {
      ctx: { storage, blockConcurrencyWhile: <T>(action: () => Promise<T>) => action() },
      env: processorEnv,
    });
  },
};
const relayed: { path: string; agent: string | null; operator: string | null }[] = [];
const PIPELINE = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    relayed.push({
      path: url.pathname,
      agent: request.headers.get("x-kogane-agent"),
      operator: request.headers.get("x-kogane-operator"),
    });
    return (
      (await scheduleRoute(request, processorEnv as unknown as Env, url)) ??
      Response.json({ error: "not_found" }, { status: 404 })
    );
  },
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  // Independent of the seeded research: every seeded rule disabled by a new
  // revision and every reference on a synthetic host.
  await env.DB.prepare(
    "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT id,revision+1,source,timezone,pattern_json,0,?,verified_at,scope,'migration:synthetic','2026-01-01T00:00:00.000Z' FROM provider_maintenance_rules",
  )
    .bind(REFERENCE)
    .run();
  await env.DB.prepare("UPDATE provider_maintenance_references SET reference_url=?")
    .bind(REFERENCE)
    .run();
  await env.DB.prepare("UPDATE collection_schedules SET enabled=0").run();
});
beforeEach(() => {
  issuer = `https://schedule-tools-${++sequence}.cloudflareaccess.com`;
  relayed.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("unexpected_external_request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

async function request(
  path: string,
  options: {
    subject: string;
    audience: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    environment?: Record<string, unknown>;
  },
): Promise<Response> {
  const jwt = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(options.audience)
    .setSubject(options.subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: { "cf-access-jwt-assertion": jwt, ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: APP_AUD,
      ACCESS_MCP_AUDIENCE: MCP_AUD,
      SCHEDULES_ENABLED: "true",
      AGENT_API_GRANTS: JSON.stringify(GRANTS),
      OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
      MCP_DELEGATIONS: "",
      RELEASE_SHA: "a".repeat(40),
      PIPELINE,
      ...options.environment,
    } as unknown as Env,
  );
}

/** One JSON-RPC message to `/mcp` from the MCP client of `subject`. */
async function mcp(
  subject: string,
  method: string,
  params: Record<string, unknown> = {},
  environment?: Record<string, unknown>,
): Promise<any> {
  const response = await request("/mcp", {
    subject,
    audience: MCP_AUD,
    body: { jsonrpc: "2.0", id: ++rpc, method, params },
    headers: { ...MCP_CLIENT_HEADERS, "mcp-protocol-version": "2025-11-25" },
    ...(environment ? { environment } : {}),
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function tool(
  subject: string,
  name: string,
  args: unknown,
  environment?: Record<string, unknown>,
) {
  const message = await mcp(subject, "tools/call", { name, arguments: args }, environment);
  return message.result as { isError: boolean; structuredContent: any };
}
/** The same tool on `/api/agent/v1/*`, from the browser session of `subject`. */
async function http(subject: string, name: string, body: unknown) {
  const response = await request(`/api/agent/v1/${name.slice("kogane.".length)}`, {
    subject,
    audience: APP_AUD,
    body,
    headers: { "content-type": "application/json" },
  });
  return { status: response.status, body: (await response.json()) as any };
}
const READ = "kogane.schedules.maintenance.read";
const UPDATE = "kogane.schedules.maintenance.update";

function window(source: string, overrides: Record<string, unknown> = {}) {
  return {
    source,
    revision: 0,
    timezone: "Asia/Tokyo",
    pattern: { kind: "once", from: iso(Date.now() + DAY), to: iso(Date.now() + DAY + HOUR) },
    enabled: true,
    scope: "collection",
    referenceUrl: `${REFERENCE}/window`,
    verifiedAt: iso(Date.now() - 60_000),
    reason: "official-notice-added",
    ...overrides,
  };
}
async function revisionCount(): Promise<number> {
  return (await env.DB.prepare(
    "SELECT count(*) AS n FROM provider_maintenance_rules",
  ).first<number>("n"))!;
}
async function referenceRows(): Promise<unknown[]> {
  return (
    await env.DB.prepare("SELECT * FROM provider_maintenance_references ORDER BY source").all()
  ).results;
}
/** The audit records of one operation, newest last. */
async function records(operation: string): Promise<Record<string, unknown>[]> {
  return (
    await env.DB.prepare(
      "SELECT * FROM audit_records WHERE operation=? ORDER BY recorded_at,audit_id",
    )
      .bind(operation)
      .all<Record<string, unknown>>()
  ).results;
}

describe("the maintenance read: one function on both agent paths", () => {
  it("is listed to an MCP client holding schedules.read, and the revision to nobody", async () => {
    const names = async (subject: string, environment?: Record<string, unknown>) =>
      ((await mcp(subject, "tools/list", {}, environment)).result.tools as { name: string }[]).map(
        (entry) => entry.name,
      );
    expect(await names(OWNER)).toContain(READ);
    expect(await names(READER)).toContain(READ);
    // A financial grant holds no schedule capability, and a schedule scope
    // without the capability reaches nothing.
    expect(await names(FINANCIAL)).not.toContain(READ);
    expect(await names(REVIEWER)).not.toContain(READ);
    // The revision is published to no one, even under a valid delegation:
    // nothing can execute it yet.
    for (const subject of [OWNER, READER, FINANCIAL])
      expect(
        await names(subject, { MCP_DELEGATIONS: delegations({ [OWNER_MCP]: MAINTAINER }) }),
      ).not.toContain(UPDATE);
    // Off with the settings routes: neither listed nor callable.
    expect(await names(OWNER, { SCHEDULES_ENABLED: "false" })).not.toContain(READ);
    for (const name of [READ, UPDATE]) {
      const off = await mcp(
        OWNER,
        "tools/call",
        { name, arguments: {} },
        { SCHEDULES_ENABLED: "false" },
      );
      expect(off.error).toEqual({ code: -32602, message: "unknown_tool" });
    }
    expect(relayed).toEqual([]);
  });

  it("answers HTTP and MCP with the same object, and records one read on each path", async () => {
    const before = (await records("schedules.maintenance.read")).length;
    for (const args of [{ source: "vpass" }, {}]) {
      const viaMcp = await tool(READER, READ, args);
      const viaHttp = await http(READER, READ, args);
      expect(viaMcp.isError).toBe(false);
      expect(viaHttp.status).toBe(200);
      expect(viaHttp.body).toEqual(viaMcp.structuredContent);
      expect(viaHttp.body.sources.map((entry: { source: string }) => entry.source)).toEqual([
        "vpass",
      ]);
    }
    // Each relayed as its own principal, never as an operator.
    expect(relayed).toEqual([
      { path: "/internal/schedules/agent/read", agent: `mcp-client:${READER}`, operator: null },
      { path: "/internal/schedules/agent/read", agent: READER, operator: null },
      { path: "/internal/schedules/agent/read", agent: `mcp-client:${READER}`, operator: null },
      { path: "/internal/schedules/agent/read", agent: READER, operator: null },
    ]);
    const written = (await records("schedules.maintenance.read")).slice(before);
    expect(written.map((row) => [row["path"], row["principal"], row["result"]])).toEqual([
      ["mcp", `mcp-client:${READER}`, "read"],
      ["agent-http", READER, "read"],
      ["mcp", `mcp-client:${READER}`, "read"],
      ["agent-http", READER, "read"],
    ]);
    for (const row of written)
      expect(row).toMatchObject({
        risk_class: "R0",
        principal_kind: "agent",
        delegation_ref: null,
      });
  });

  it("refuses alike on both paths: no capability, a source outside the scope or none at all", async () => {
    for (const [subject, args, status, error] of [
      [FINANCIAL, { source: "vpass" }, 403, "unauthorized"],
      [READER, { source: "sony-bank" }, 403, "source_not_granted"],
      [READER, { source: "no-such-source" }, 403, "source_not_granted"],
      [READER, { source: "vpass", extra: 1 }, 400, "invalid_request"],
    ] as const) {
      const viaMcp = await tool(subject, READ, args);
      const viaHttp = await http(subject, READ, args);
      expect([subject, args, viaHttp]).toEqual([subject, args, { status, body: { error } }]);
      expect(viaMcp).toMatchObject({ isError: true, structuredContent: { error } });
    }
    expect(relayed).toEqual([]);
  });

  it("is the only schedule tool on the HTTP agent route", async () => {
    const before = await revisionCount();
    const count = (await records("schedules.maintenance.update")).length;
    const refused = await http(OWNER, UPDATE, window("vpass"));
    expect(refused).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await revisionCount()).toBe(before);
    expect(relayed).toEqual([]);
    // A route this deployment does not serve is not an operation.
    expect((await records("schedules.maintenance.update")).length).toBe(count);
  });
});

describe("the maintenance revision: a delegated operation nothing can execute yet", () => {
  /** Calls the update tool as `subject`'s MCP client and shows it relayed and wrote nothing. */
  async function refusedUpdate(
    subject: string,
    args: unknown,
    environment?: Record<string, unknown>,
  ): Promise<{ status: string; record: Record<string, unknown> }> {
    const revisions = await revisionCount();
    const references = await referenceRows();
    const count = (await records("schedules.maintenance.update")).length;
    const result = await tool(subject, UPDATE, args, environment);
    expect(result.isError).toBe(true);
    expect(relayed).toEqual([]);
    expect(await revisionCount()).toBe(revisions);
    expect(await referenceRows()).toEqual(references);
    const written = (await records("schedules.maintenance.update")).slice(count);
    expect(written).toHaveLength(1);
    return { status: result.structuredContent.error as string, record: written[0]! };
  }

  it("refuses an MCP client without a delegation, the operator's own included", async () => {
    // The owner is the configured operator, yet on `/mcp` it is only
    // `mcp-client:<sub>`: no bare-subject fallback to the operator.
    for (const subject of [OWNER, READER, FINANCIAL]) {
      const { status, record } = await refusedUpdate(subject, window("vpass"));
      expect(status).toBe("delegation_not_configured");
      expect(record).toMatchObject({
        path: "mcp",
        subject,
        principal: `mcp-client:${subject}`,
        principal_kind: "agent",
        delegation_ref: null,
        operation: "schedules.maintenance.update",
        risk_class: "R1",
        result: "refused",
        result_code: "delegation_not_configured",
        target_ref: null,
      });
    }
    // Another owner's delegation is not this client's.
    const other = await refusedUpdate(READER, window("vpass"), {
      MCP_DELEGATIONS: delegations({ [OWNER_MCP]: MAINTAINER }),
    });
    expect(other.status).toBe("delegation_not_configured");
  });

  it("refuses under every invalid, early or late delegation table", async () => {
    const cases: [string, string][] = [
      ["{", "delegation_misconfigured"],
      // Keyed by the bare subject: never a delegation, and the table is unreadable.
      [delegations({ [OWNER]: MAINTAINER }), "delegation_misconfigured"],
      // A delegator who is not the operator.
      [
        delegations({ [`mcp-client:${READER}`]: { ...MAINTAINER, delegatedBy: READER } }),
        "delegation_misconfigured",
      ],
      // A schedule scope wider than the client's read grant.
      [
        delegations({
          [OWNER_MCP]: {
            ...MAINTAINER,
            scopes: { ...MAINTAINER.scopes, scheduleSources: ["vpass", "myjcb"] },
          },
        }),
        "delegation_misconfigured",
      ],
      [
        delegations({ [OWNER_MCP]: { ...MAINTAINER, issuedAt: iso(Date.now() + DAY) } }),
        "delegation_not_yet_valid",
      ],
      [
        delegations({
          [OWNER_MCP]: {
            ...MAINTAINER,
            issuedAt: iso(Date.now() - 2 * DAY),
            notAfter: iso(Date.now() - DAY),
          },
        }),
        "delegation_expired",
      ],
    ];
    for (const [configured, code] of cases) {
      const { status, record } = await refusedUpdate(OWNER, window("vpass"), {
        MCP_DELEGATIONS: configured,
      });
      expect([configured, status]).toEqual([configured, code]);
      expect(record).toMatchObject({
        result: code === "delegation_misconfigured" ? "failed" : "refused",
        result_code: code,
        delegation_ref: null,
      });
    }
  });

  it("refuses a delegation without the capability", async () => {
    const reviewer = {
      ...MAINTAINER,
      delegatedBy: REVIEWER,
      role: "reviewer",
      scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
    };
    const { status } = await refusedUpdate(REVIEWER, window("vpass"), {
      OPERATOR_SUBJECTS: JSON.stringify([OWNER, REVIEWER]),
      MCP_DELEGATIONS: delegations({ [`mcp-client:${REVIEWER}`]: reviewer }),
    });
    expect(status).toBe("delegation_capability_denied");
  });

  it("checks arguments and scope under a valid delegation, then is still not available", async () => {
    const environment = { MCP_DELEGATIONS: delegations({ [OWNER_MCP]: MAINTAINER }) };
    // Out of the delegation's scope, existing or not: one answer.
    const outside = await refusedUpdate(OWNER, window("sony-bank"), environment);
    const missing = await refusedUpdate(OWNER, window("no-such-source"), environment);
    expect(outside.status).toBe("source_not_granted");
    expect(missing.status).toBe(outside.status);
    // The reason is a closed code: free text is refused at the edge.
    const freeText = await refusedUpdate(
      OWNER,
      window("vpass", { reason: `Provider notice ${TOKEN} 123,456` }),
      environment,
    );
    expect(freeText.status).toBe("invalid_request");
    for (const reason of ["operator-edit", "maintenance-survey-proposal-accepted"])
      expect((await refusedUpdate(OWNER, window("vpass", { reason }), environment)).status).toBe(
        "invalid_request",
      );
    // Neither the writer's deferral bound nor a decision reference is an
    // argument: the writer's trusted option and the audit reference are set
    // by Processor code alone (ADR 0046's amendment), never by a caller.
    for (const extra of [
      { deferralBound: "confirmed-31d" },
      { decisionRef: "delegated-audit:aud_0a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d" },
    ])
      expect((await refusedUpdate(OWNER, window("vpass", extra), environment)).status).toBe(
        "invalid_request",
      );
    // Inside the envelope and inside the bound: the delegation, its capability,
    // the arguments and the scope all hold, and nothing executes it.
    const inside = await refusedUpdate(OWNER, window("vpass"), environment);
    expect(inside.status).toBe("delegation_execution_unavailable");
    expect(inside.record).toMatchObject({
      principal: OWNER_MCP,
      principal_kind: "agent",
      delegation_ref: null,
      result: "refused",
      result_code: "delegation_execution_unavailable",
      risk_class: "R1",
    });
    // Beyond the seven-day bound it is not available either; the writer, which
    // the call never reaches, would refuse it as maintenance_deferral_too_long.
    const long = await refusedUpdate(
      OWNER,
      window("vpass", {
        pattern: { kind: "once", from: iso(Date.now() + DAY), to: iso(Date.now() + 9 * DAY) },
      }),
      environment,
    );
    expect(long.status).toBe("delegation_execution_unavailable");
  });

  it("an agent grant cannot name the revision: the whole table is refused", async () => {
    const response = await request("/mcp", {
      subject: OWNER,
      audience: MCP_AUD,
      body: {
        jsonrpc: "2.0",
        id: ++rpc,
        method: "tools/call",
        params: { name: UPDATE, arguments: window("vpass") },
      },
      headers: { ...MCP_CLIENT_HEADERS, "mcp-protocol-version": "2025-11-25" },
      environment: {
        AGENT_API_GRANTS: JSON.stringify({
          ...GRANTS,
          [OWNER_MCP]: {
            ...GRANTS[OWNER_MCP],
            capabilities: ["schedules.read", "schedules.maintenance.update"],
          },
        }),
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "agent_api_not_configured" });
    expect(relayed).toEqual([]);
  });

  it("publishes no schema of its own, and enforces a closed one at the edge", () => {
    expect(scheduleUpdateSchema.safeParse(window("vpass")).success).toBe(true);
    for (const extra of [{ actor: "x" }, { ruleId: "Has Space" }, { reason: "correction " }])
      expect(scheduleUpdateSchema.safeParse({ ...window("vpass"), ...extra }).success).toBe(false);
    expect(
      scheduleUpdateSchema.safeParse({
        ...window("vpass"),
        pattern: { kind: "daily", time: "01:00", weekdays: [1] },
      }).success,
    ).toBe(false);
  });

  it("records codes and counts only: no argument value reaches a record or a revision", async () => {
    const environment = { MCP_DELEGATIONS: delegations({ [OWNER_MCP]: MAINTAINER }) };
    await refusedUpdate(
      OWNER,
      window("vpass", {
        reason: `Bearer ${TOKEN} ¥123,456`,
        referenceUrl: `${REFERENCE}/x?t=${TOKEN}&a=123456`,
      }),
      environment,
    );
    await refusedUpdate(
      OWNER,
      window("vpass", { referenceUrl: `${REFERENCE}/y?t=${TOKEN}&a=123456` }),
      environment,
    );
    const stored = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM audit_records").all()).results,
    );
    const rules = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM provider_maintenance_rules").all()).results,
    );
    for (const needle of ["c3ludGhldGlj", "123,456", "123456", "Bearer", "/x?t=", "/y?t="]) {
      expect(stored).not.toContain(needle);
      expect(rules).not.toContain(needle);
    }
  });
});

describe("the operator's edit is the one revision path that runs today", () => {
  it("records the operator's revision with its closed reason, while an MCP client reaches no operator route", async () => {
    const body = {
      id: "vpass-operator-window",
      revision: 0,
      source: "vpass",
      timezone: "Asia/Tokyo",
      pattern: { kind: "weekly", weekdays: [2], start: "02:00", end: "03:00" },
      enabled: true,
      referenceUrl: `${REFERENCE}/operator`,
      verifiedAt: iso(Date.now() - 60_000),
      scope: "collection",
    };
    const headers = {
      "content-type": "application/json",
      origin: "https://fixture.test",
      "x-kogane-settings": "1",
    };
    // An MCP-audience assertion never authenticates a browser route.
    const viaMcpAudience = await request("/api/ops/v1/schedules/maintenance", {
      subject: OWNER,
      audience: MCP_AUD,
      body,
      headers,
    });
    expect(viaMcpAudience.status).toBe(401);
    expect(relayed).toEqual([]);
    const saved = await request("/api/ops/v1/schedules/maintenance", {
      subject: OWNER,
      audience: APP_AUD,
      body,
      headers,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ saved: true, revision: 1, reservation: "armed" });
    expect(
      await env.DB.prepare(
        "SELECT actor,actor_kind,change_reason,decision_ref FROM provider_maintenance_rules WHERE id=?",
      )
        .bind("vpass-operator-window")
        .first(),
    ).toEqual({
      actor: OWNER,
      actor_kind: "operator",
      change_reason: "operator-edit",
      decision_ref: null,
    });
    const [record] = (await records("schedules.maintenance.update")).filter(
      (row) =>
        row["result"] === "applied" &&
        row["target_ref"] === "maintenance-rule:vpass-operator-window",
    );
    expect(record).toMatchObject({
      path: "ui",
      principal: OWNER,
      principal_kind: "human",
      reason_code: "operator-edit",
      risk_class: "R1",
    });
  });
});
