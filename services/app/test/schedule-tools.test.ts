// The maintenance MCP tools (ADR 0046) over the real App Worker, wired to the
// Processor's real settings route (`scheduleRoute`) and the real
// `ScheduleAlarm.reconcile` code over this test's CORE store. The Durable
// Object's storage is an in-memory stand-in, so nothing here fires an alarm or
// contacts a provider; services/processor/test/schedule-agent-maintenance.test.ts
// covers the same path with native workerd alarms. Every principal, host and
// window is synthetic.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { MCP_TOOLS } from "../src/mcp";
import { SCHEDULE_TOOL_NAMES } from "../src/schedule-tools";
import { scheduleUpdateSchema } from "../src/schedule-tools";
import { scheduleRoute } from "../../processor/src/schedule-store";
import { ScheduleAlarm } from "../../processor/src/schedule-alarm";

const OPERATOR = "schedule-operator";
const MAINTAINER = "maintenance-agent";
const READER = "maintenance-reader";
const FINANCIAL = "financial-agent";
const SCOPED_ONLY = "scope-without-capability";
const REFERENCE = "https://maintenance.synthetic.test/notices";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BUDGET = { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 1 };
const GRANTS = {
  [MAINTAINER]: {
    scopes: { sources: [], accounts: [], scheduleSources: ["vpass", "sony-bank"] },
    capabilities: ["schedules.read", "schedules.maintenance.update"],
    budget: BUDGET,
  },
  [READER]: {
    scopes: { sources: [], accounts: [], scheduleSources: ["vpass"] },
    capabilities: ["schedules.read"],
    budget: BUDGET,
  },
  [FINANCIAL]: {
    scopes: { sources: "*", accounts: "*" },
    capabilities: ["summary.read", "records.read", "evidence.read", "interpretation.propose"],
    budget: BUDGET,
  },
  [SCOPED_ONLY]: {
    scopes: { sources: "*", accounts: "*", scheduleSources: "*" },
    capabilities: ["summary.read"],
    budget: BUDGET,
  },
};

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;

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
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    environment?: Record<string, unknown>;
  },
): Promise<Response> {
  const jwt = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience("fixture-audience")
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
      ACCESS_AUDIENCE: "fixture-audience",
      SCHEDULES_ENABLED: "true",
      AGENT_API_GRANTS: JSON.stringify(GRANTS),
      OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]),
      AGENT_GRANTS: JSON.stringify([MAINTAINER, READER, FINANCIAL, SCOPED_ONLY]),
      RELEASE_SHA: "a".repeat(40),
      PIPELINE,
      ...options.environment,
    } as unknown as Env,
  );
}

async function mcp(
  subject: string,
  method: string,
  params: Record<string, unknown> = {},
  environment?: Record<string, unknown>,
): Promise<any> {
  const response = await request("/mcp", {
    subject,
    body: { jsonrpc: "2.0", id: 1, method, params },
    ...(environment ? { environment } : {}),
  });
  return response.json();
}
async function tool(subject: string, name: string, args: unknown) {
  const message = await mcp(subject, "tools/call", { name, arguments: args });
  return message.result as { isError: boolean; structuredContent: any };
}
const READ = "kogane.schedules.maintenance.read";
const UPDATE = "kogane.schedules.maintenance.update";
const iso = (ms: number) => new Date(ms).toISOString();

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
    reason: "Synthetic announcement checked on the registered site",
    ...overrides,
  };
}
async function revisionCount(): Promise<number> {
  return (await env.DB.prepare(
    "SELECT count(*) AS n FROM provider_maintenance_rules",
  ).first<number>("n"))!;
}

describe("publication follows the grant", () => {
  it("lists each tool only to a grant holding its capability, after the five", async () => {
    const names = async (subject: string, environment?: Record<string, unknown>) =>
      (await mcp(subject, "tools/list", {}, environment)).result.tools.map(
        (entry: { name: string }) => entry.name,
      );
    const five = MCP_TOOLS.map((entry) => entry.name);
    expect(await names(MAINTAINER)).toEqual([...five, ...SCHEDULE_TOOL_NAMES]);
    expect(await names(READER)).toEqual([...five, READ]);
    // A financial grant, even a full one, holds no maintenance capability, and
    // a schedule scope without a capability reaches nothing.
    expect(await names(FINANCIAL)).toEqual(five);
    expect(await names(SCOPED_ONLY)).toEqual(five);
    // Off with the settings routes: neither listed nor callable.
    expect(await names(MAINTAINER, { SCHEDULES_ENABLED: "false" })).toEqual(five);
    const off = await mcp(
      MAINTAINER,
      "tools/call",
      { name: READ, arguments: {} },
      { SCHEDULES_ENABLED: "false" },
    );
    expect(off.error).toEqual({ code: -32602, message: "unknown_tool" });
  });

  it("publishes closed schemas that take no host, SQL or job setting", async () => {
    const listed = (await mcp(MAINTAINER, "tools/list")).result.tools as {
      name: string;
      inputSchema: Record<string, any>;
      annotations: Record<string, boolean>;
    }[];
    const [read, update] = listed.slice(-2);
    expect(read!.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { source: { type: "string", pattern: "^[a-z0-9-]{1,100}$" } },
    });
    expect(read!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(update!.inputSchema["additionalProperties"]).toBe(false);
    // Every pattern variant is closed too.
    for (const variant of update!.inputSchema["properties"].pattern.oneOf ??
      update!.inputSchema["properties"].pattern.anyOf)
      expect(variant.additionalProperties).toBe(false);
    expect(update!.inputSchema["required"].sort()).toEqual([
      "enabled",
      "pattern",
      "reason",
      "referenceUrl",
      "revision",
      "scope",
      "source",
      "timezone",
      "verifiedAt",
    ]);
    // The schema the tool publishes is the one it enforces at the edge.
    expect(scheduleUpdateSchema.safeParse({ ...window("vpass"), actor: "x" }).success).toBe(false);
    expect(scheduleUpdateSchema.safeParse(window("vpass")).success).toBe(true);
    expect(Object.keys(update!.inputSchema["properties"]).sort()).toEqual([
      "enabled",
      "pattern",
      "reason",
      "referenceUrl",
      "revision",
      "ruleId",
      "scope",
      "source",
      "timezone",
      "verifiedAt",
    ]);
    expect(update!.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    const text = JSON.stringify(listed.slice(-2));
    expect(text).not.toMatch(/"format"\s*:\s*"uri"/u);
    expect(text).not.toMatch(/"(url|uri|sql|table|host|endpoint|orderBy|actor|leaseRef)"\s*:/u);
  });

  it("reports the schedule scope and the maintenance write in kogane.capabilities", async () => {
    const report = (await tool(READER, "kogane.capabilities", {})).structuredContent;
    expect(report.capabilities).toEqual(["schedules.read"]);
    expect(report.intents).toEqual([]);
    expect(report.scopes.scheduleSources).toEqual(["vpass"]);
    expect(report.writes).toMatchObject({ maintenanceRules: false, proposals: false });
    const writer = (await tool(MAINTAINER, "kogane.capabilities", {})).structuredContent;
    expect(writer.writes).toMatchObject({ maintenanceRules: true, adoption: false });
  });

  it("revoking the grant table closes the tools with the transport", async () => {
    const response = await request("/mcp", {
      subject: MAINTAINER,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      environment: { AGENT_API_GRANTS: "" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "agent_api_not_configured" });
  });
});

describe("reads stay inside the granted sources", () => {
  it("returns only granted sources and never names another", async () => {
    const result = await tool(READER, READ, {});
    expect(result.isError).toBe(false);
    const body = result.structuredContent;
    expect(body.sources.map((entry: { source: string }) => entry.source)).toEqual(["vpass"]);
    const vpass = body.sources[0];
    expect(vpass.reference).toMatchObject({ referenceUrl: REFERENCE });
    expect(vpass.schedules.map((s: { id: string }) => s.id)).toEqual(["vpass"]);
    expect(vpass.schedules[0]).toHaveProperty("nextNominalAt");
    expect(vpass.schedules[0]).toHaveProperty("nextRunAt");
    expect(vpass.schedules[0]).toHaveProperty("actualAlarmAt");
    expect(vpass.schedules[0]).toHaveProperty("reservation");
    expect(vpass.schedules[0]).toHaveProperty("latest");
    const text = JSON.stringify(body);
    for (const other of ["sony-bank", "mizuho-bank", "myjcb", "sbi-securities", "processor-tick"])
      expect(text).not.toContain(other);
    expect(relayed).toEqual([
      { path: "/internal/schedules/agent/read", agent: READER, operator: null },
    ]);
  });

  it("refuses a source outside the grant alike, whether or not it exists", async () => {
    const existing = await tool(READER, READ, { source: "sony-bank" });
    const missing = await tool(READER, READ, { source: "no-such-source" });
    expect(existing).toEqual({
      content: [{ type: "text", text: JSON.stringify({ error: "source_not_granted" }) }],
      structuredContent: { error: "source_not_granted" },
      isError: true,
    });
    expect(missing).toEqual(existing);
    expect((await tool(READER, READ, { source: "vpass", extra: 1 })).structuredContent).toEqual({
      error: "invalid_request",
    });
    expect(relayed).toEqual([]);
  });
});

describe("updates need the update capability and a granted source", () => {
  it("refuses a read-only, a financial and an out-of-scope caller without writing", async () => {
    const before = await revisionCount();
    for (const subject of [READER, FINANCIAL, SCOPED_ONLY]) {
      const refused = await tool(subject, UPDATE, window("vpass"));
      expect(refused).toMatchObject({
        isError: true,
        structuredContent: { error: "unauthorized" },
      });
    }
    for (const source of ["mizuho-bank", "no-such-source"]) {
      const refused = await tool(MAINTAINER, UPDATE, window(source));
      expect(refused.structuredContent).toEqual({ error: "source_not_granted" });
    }
    expect(relayed).toEqual([]);
    expect(await revisionCount()).toBe(before);
  });

  it("refuses a stale revision and an invalid timezone, pattern or period", async () => {
    const created = await tool(MAINTAINER, UPDATE, window("sony-bank"));
    expect(created.isError).toBe(false);
    const ruleId = created.structuredContent.ruleId as string;
    const before = await revisionCount();
    const cases: [Record<string, unknown>, string][] = [
      [{ ruleId, revision: 0 }, "revision_conflict"],
      [{ timezone: "Mars/Olympus" }, "invalid_request"],
      [
        { pattern: { kind: "weekly", weekdays: [], start: "01:00", end: "02:00" } },
        "invalid_request",
      ],
      [
        { pattern: { kind: "weekly", weekdays: [1], start: "25:00", end: "02:00" } },
        "invalid_request",
      ],
      [
        { pattern: { kind: "once", from: iso(Date.now() + 2 * DAY), to: iso(Date.now() + DAY) } },
        "invalid_request",
      ],
      [
        { pattern: { kind: "once", from: iso(Date.now() + DAY), to: iso(Date.now() + 9 * DAY) } },
        "maintenance_deferral_too_long",
      ],
      [{ referenceUrl: "https://elsewhere.synthetic.test/" }, "invalid_reference"],
      [{ reason: "" }, "invalid_request"],
      [{ reason: "   " }, "reason_required"],
      [{ actor: "someone-else" }, "invalid_request"],
    ];
    for (const [overrides, error] of cases) {
      const refused = await tool(MAINTAINER, UPDATE, window("sony-bank", overrides));
      expect([overrides, refused.structuredContent]).toEqual([overrides, { error }]);
    }
    expect(await revisionCount()).toBe(before);
  });

  it("writes one revision with the reason and the verified principal, then reads back the run", async () => {
    const nominal = Date.now() + 2 * DAY;
    await env.DB.prepare(
      "UPDATE collection_schedules SET enabled=1,next_nominal_at=?,next_run_at=? WHERE id='vpass'",
    )
      .bind(iso(nominal), iso(nominal))
      .run();
    const end = nominal + 3 * HOUR;
    const saved = await tool(
      MAINTAINER,
      UPDATE,
      window("vpass", {
        pattern: { kind: "once", from: iso(nominal - HOUR), to: iso(end) },
        reason: "Synthetic overnight system work",
      }),
    );
    expect(saved.isError).toBe(false);
    const body = saved.structuredContent;
    expect(body).toMatchObject({ saved: true, revision: 1, reconciled: true });
    expect(body.source.schedules[0]).toMatchObject({
      id: "vpass",
      nextNominalAt: iso(nominal),
      nextRunAt: iso(end),
      actualAlarmAt: iso(end),
      reservation: "armed",
    });
    const row = await env.DB.prepare(
      "SELECT revision,source,actor,actor_kind,change_reason FROM provider_maintenance_rules WHERE id=?",
    )
      .bind(body.ruleId)
      .first();
    expect(row).toEqual({
      revision: 1,
      source: "vpass",
      actor: MAINTAINER,
      actor_kind: "agent",
      change_reason: "Synthetic overnight system work",
    });
    expect(relayed).toEqual([
      { path: "/internal/schedules/agent/maintenance", agent: MAINTAINER, operator: null },
    ]);
    // The reader sees the same saved state, marked as not its own revision.
    const read = (await tool(READER, READ, { source: "vpass" })).structuredContent;
    const rule = read.sources[0].rules.find((r: { id: string }) => r.id === body.ruleId);
    expect(rule.revisions[0]).toMatchObject({
      actorKind: "agent",
      changeReason: "Synthetic overnight system work",
      byCaller: false,
    });
    expect(JSON.stringify(read)).not.toContain(MAINTAINER);
    // Disabling the window is a further revision; the first one stays.
    const withdrawn = await tool(
      MAINTAINER,
      UPDATE,
      window("vpass", {
        ruleId: body.ruleId,
        revision: 1,
        enabled: false,
        pattern: { kind: "once", from: iso(nominal - HOUR), to: iso(end) },
        reason: "Synthetic: window withdrawn",
      }),
    );
    expect(withdrawn.structuredContent.source.schedules[0]).toMatchObject({
      nextRunAt: iso(nominal),
      actualAlarmAt: iso(nominal),
      reservation: "armed",
    });
    const history = await env.DB.prepare(
      "SELECT revision,enabled FROM provider_maintenance_rules WHERE id=? ORDER BY revision",
    )
      .bind(body.ruleId)
      .all();
    expect(history.results).toEqual([
      { revision: 1, enabled: 1 },
      { revision: 2, enabled: 0 },
    ]);
    await env.DB.prepare("UPDATE collection_schedules SET enabled=0 WHERE id='vpass'").run();
  });
});

describe("the operator settings routes are unchanged", () => {
  const maintenanceBody = (id: string) => ({
    id,
    revision: 0,
    source: "vpass",
    timezone: "UTC",
    pattern: { kind: "weekly", weekdays: [2], start: "01:00", end: "02:00" },
    enabled: true,
    referenceUrl: REFERENCE,
    verifiedAt: iso(Date.now() - 60_000),
    scope: "collection",
  });
  const settings = {
    origin: "https://fixture.test",
    "content-type": "application/json",
    "x-kogane-settings": "1",
  };

  it("still refuse an agent holding the maintenance capability", async () => {
    const before = await revisionCount();
    expect((await request("/api/ops/v1/schedules", { subject: MAINTAINER })).status).toBe(403);
    const write = await request("/api/ops/v1/schedules/maintenance", {
      subject: MAINTAINER,
      body: maintenanceBody("synthetic-agent-via-operator-route"),
      headers: settings,
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: "operator_required" });
    expect(relayed).toEqual([]);
    expect(await revisionCount()).toBe(before);
  });

  it("still serve the operator, who is recorded as the operator", async () => {
    const read = await request("/api/ops/v1/schedules", { subject: OPERATOR });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { schedules: unknown[] }).schedules.length).toBeGreaterThan(0);
    const unmarked = await request("/api/ops/v1/schedules/maintenance", {
      subject: OPERATOR,
      body: maintenanceBody("synthetic-operator-rule"),
      headers: { ...settings, "x-kogane-settings": "" },
    });
    expect(unmarked.status).toBe(403);
    const saved = await request("/api/ops/v1/schedules/maintenance", {
      subject: OPERATOR,
      body: maintenanceBody("synthetic-operator-rule"),
      headers: settings,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ saved: true, revision: 1, reservation: "armed" });
    expect(
      await env.DB.prepare(
        "SELECT actor,actor_kind,change_reason FROM provider_maintenance_rules WHERE id='synthetic-operator-rule'",
      ).first(),
    ).toEqual({ actor: OPERATOR, actor_kind: "operator", change_reason: null });
    expect(relayed.map((entry) => [entry.path, entry.agent, entry.operator])).toEqual([
      ["/internal/schedules", null, null],
      ["/internal/schedules/maintenance", null, OPERATOR],
    ]);
  });
});
