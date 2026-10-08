// The agent maintenance path of the settings service (ADR 0046), through the
// real Processor Worker under workerd: its `/internal/schedules` route, real
// Durable Object alarms and named service RPC. The provider is a synthetic
// stub that only counts calls; every source reference is a synthetic host.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import jobs from "../../../config/alarm-jobs.json";
import { LAYER_A_SQL, layerBMigrations, applyMigration } from "./harness";
import { applyReadMigrations } from "../../../packages/storage-d1/src/migrations";
import {
  MAINTENANCE_WRITE_CODES,
  type MaintenanceWrite,
  writeMaintenanceRevision,
} from "../src/schedule-store";

const AGENT = "maintenance-agent";
const OTHER_AGENT = "other-maintenance-agent";
const OPERATOR = "synthetic-operator";
const REFERENCE = "https://maintenance.synthetic.test/notices";
const DAY = 86_400_000;
let mf: Miniflare, db: D1Database, namespace: unknown;
const alarms = () =>
  namespace as { getByName(name: string): { reconcile(id: string): Promise<string | null> } };

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/schedule-entrypoint.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
  });
  if (!bundle.success) throw new Error("agent_maintenance_bundle_failed");
  const serviceBindings = Object.fromEntries(
    jobs
      .filter((job) => job.workspace?.startsWith("collector-"))
      .map((job) => [
        `SCHEDULE_${job.workspace!.replace("collector-", "").replaceAll("-", "_").toUpperCase()}`,
        { name: "provider", entrypoint: "ScheduledCollection" },
      ]),
  );
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "processor",
          modules: true,
          script: await bundle.outputs[0]!.text(),
          compatibilityDate: "2026-09-07",
          compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"],
          d1Databases: ["DB", "READ"],
          r2Buckets: ["EVIDENCE", "DATA"],
          bindings: { SCHEDULES_ENABLED: "true" },
          serviceBindings,
          durableObjects: { SCHEDULE_ALARMS: { className: "ScheduleAlarm", useSQLite: true } },
        },
        {
          name: "provider",
          modules: true,
          script: `import {WorkerEntrypoint} from "cloudflare:workers";let calls=0;export class ScheduledCollection extends WorkerEntrypoint {async runScheduled(cron,time) {calls++;return {status:"completed",runIds:["synthetic-agent-run"],failureCode:null};}}export default {fetch(){return Response.json({calls});}};`,
          compatibilityDate: "2026-09-07",
        },
      ],
    }),
  );
  db = (await mf.getD1Database("DB", "processor")) as unknown as D1Database;
  await db.exec(LAYER_A_SQL);
  for (const name of layerBMigrations()) await applyMigration(db, name);
  await applyReadMigrations((await mf.getD1Database("READ", "processor")) as unknown as D1Database);
  namespace = (await mf.getBindings("processor"))["SCHEDULE_ALARMS"];
  // Independent of the seeded research: every job off and every seeded rule
  // disabled by a new revision, and every reference moved to a synthetic host.
  await db.prepare("UPDATE collection_schedules SET enabled=0").run();
  await db
    .prepare(
      "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT id,revision+1,source,timezone,pattern_json,0,?,verified_at,scope,'migration:synthetic','2026-01-01T00:00:00.000Z' FROM provider_maintenance_rules",
    )
    .bind(REFERENCE)
    .run();
  await db
    .prepare("UPDATE provider_maintenance_references SET reference_url=?,status='not-found'")
    .bind(REFERENCE)
    .run();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = { "x-kogane-agent": AGENT },
): Promise<{ status: number; body: any }> {
  // A service-binding style call: `dispatchFetch` would add the edge's
  // cf-connecting-ip header, which this route refuses by design.
  const processor = await mf.getWorker("processor");
  const response = await processor.fetch(`https://observation-pipeline.internal${path}`, {
    method: "POST",
    headers: {
      "x-kogane-internal-caller": "kogane-evidence-browser",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const write = (body: unknown, headers?: Record<string, string>) =>
  post("/internal/schedules/agent/maintenance", body, headers);
const read = (sources: unknown, headers?: Record<string, string>) =>
  post("/internal/schedules/agent/read", { sources }, headers);
const iso = (ms: number) => new Date(ms).toISOString();
const verified = () => iso(Date.now() - 60_000);

function rule(source: string, overrides: Record<string, unknown> = {}) {
  return {
    source,
    revision: 0,
    timezone: "Asia/Tokyo",
    pattern: { kind: "once", from: iso(Date.now() + DAY), to: iso(Date.now() + DAY + 3_600_000) },
    enabled: true,
    scope: "collection",
    referenceUrl: `${REFERENCE}/announcement`,
    verifiedAt: verified(),
    reason: "Synthetic announcement of a dated window",
    ...overrides,
  };
}
async function revisions(id: string) {
  return (
    await db
      .prepare(
        "SELECT revision,actor,actor_kind,change_reason FROM provider_maintenance_rules WHERE id=? ORDER BY revision",
      )
      .bind(id)
      .all<{
        revision: number;
        actor: string;
        actor_kind: string | null;
        change_reason: string | null;
      }>()
  ).results;
}
async function ruleCount(): Promise<number> {
  return (await db
    .prepare("SELECT count(*) AS n FROM provider_maintenance_rules")
    .first<number>("n"))!;
}
async function providerCalls(): Promise<number> {
  const provider = await mf.getWorker("provider");
  return (
    (await (await provider.fetch("https://synthetic.internal/count")).json()) as {
      calls: number;
    }
  ).calls;
}

test("an agent creates and revises a rule; each revision records the agent and its reason", async () => {
  const created = await write(rule("sony-bank"));
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ saved: true, revision: 1, reconciled: true });
  const id = created.body.ruleId as string;
  // The id is the store's choice, prefixed by the source, never the caller's.
  expect(id).toMatch(/^sony-bank-[0-9a-f]{12}$/u);
  const revised = await write(
    rule("sony-bank", {
      ruleId: id,
      revision: 1,
      enabled: false,
      reason: "Synthetic: the provider withdrew the window",
    }),
  );
  expect(revised.status).toBe(200);
  expect(revised.body.revision).toBe(2);
  expect(await revisions(id)).toEqual([
    {
      revision: 1,
      actor: AGENT,
      actor_kind: "agent",
      change_reason: "Synthetic announcement of a dated window",
    },
    {
      revision: 2,
      actor: AGENT,
      actor_kind: "agent",
      change_reason: "Synthetic: the provider withdrew the window",
    },
  ]);
  // The readback is the source's own view, with the caller's revisions marked.
  const view = revised.body.source;
  expect(view.source).toBe("sony-bank");
  const listed = view.rules.find((r: { id: string }) => r.id === id);
  expect(listed.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
  expect(listed.revisions[0]).toMatchObject({
    enabled: false,
    actorKind: "agent",
    changeReason: "Synthetic: the provider withdrew the window",
    byCaller: true,
  });
  // No revision's actor is returned, only its kind.
  expect(JSON.stringify(revised.body)).not.toContain(`"${AGENT}"`);
});

test("a revision of a deferred schedule reads back the next run and an armed reservation", async () => {
  const nominal = Date.now() + 2 * DAY;
  await db
    .prepare(
      "UPDATE collection_schedules SET enabled=1,next_nominal_at=?,next_run_at=? WHERE id='sony-bank'",
    )
    .bind(iso(nominal), iso(nominal))
    .run();
  const end = nominal + 2 * 3_600_000;
  const saved = await write(
    rule("sony-bank", { pattern: { kind: "once", from: iso(nominal - 3_600_000), to: iso(end) } }),
  );
  expect(saved.status).toBe(200);
  expect(saved.body.reconciled).toBe(true);
  const schedule = saved.body.source.schedules.find((s: { id: string }) => s.id === "sony-bank");
  expect(schedule).toMatchObject({
    nextNominalAt: iso(nominal),
    nextRunAt: iso(end),
    actualAlarmAt: iso(end),
    reservation: "armed",
  });
  // The same state is what a later read reports.
  const again = await read(["sony-bank"]);
  expect(
    again.body.sources[0].schedules.find((s: { id: string }) => s.id === "sony-bank"),
  ).toMatchObject({ nextRunAt: iso(end), actualAlarmAt: iso(end), reservation: "armed" });
  await db.prepare("UPDATE collection_schedules SET enabled=0 WHERE id='sony-bank'").run();
  await alarms().getByName("sony-bank").reconcile("sony-bank");
});

test("a collection deferred across days runs once after the window and resumes its schedule", async () => {
  const before = await providerCalls();
  // The window covered three nominal mornings and ended a minute ago.
  const from = Date.now() - 3 * DAY,
    to = Date.now() - 60_000,
    nominal = from + 3_600_000;
  await db
    .prepare(
      "UPDATE collection_schedules SET enabled=1,next_nominal_at=?,next_run_at=? WHERE id='mizuho-bank'",
    )
    .bind(iso(nominal), iso(nominal))
    .run();
  const saved = await write(
    rule("mizuho-bank", {
      pattern: { kind: "once", from: iso(from), to: iso(to) },
      reason: "Synthetic multi-day migration window",
    }),
  );
  expect(saved.status).toBe(200);
  const deadline = Date.now() + 5000;
  let row: { status: string } | null = null;
  while (Date.now() < deadline) {
    row = await db
      .prepare(
        "SELECT status FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank' AND nominal_at=?",
      )
      .bind(iso(nominal))
      .first<{ status: string }>();
    if (row && row.status !== "started") break;
    await Bun.sleep(20);
  }
  expect(row?.status).toBe("completed");
  // Reconciling again neither repeats the claimed occurrence nor replays the
  // skipped mornings: one receipt for the window, the next nominal is ahead.
  const stub = alarms();
  await stub.getByName("mizuho-bank").reconcile("mizuho-bank");
  await Bun.sleep(200);
  expect((await providerCalls()) - before).toBe(1);
  const receipts = await db
    .prepare(
      "SELECT count(*) AS n FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank' AND nominal_at>=? AND nominal_at<?",
    )
    .bind(iso(from), iso(Date.now()))
    .first<number>("n");
  expect(receipts).toBe(1);
  const next = await db
    .prepare("SELECT next_nominal_at FROM collection_schedules WHERE id='mizuho-bank'")
    .first<string>("next_nominal_at");
  expect(Date.parse(next!)).toBeGreaterThan(Date.now());
  await db.prepare("UPDATE collection_schedules SET enabled=0 WHERE id='mizuho-bank'").run();
  await stub.getByName("mizuho-bank").reconcile("mizuho-bank");
}, 15000);

test("a stale revision, a bad window and missing provenance are refused and write nothing", async () => {
  const created = await write(rule("vpass"));
  expect(created.status).toBe(200);
  const id = created.body.ruleId as string;
  const count = await ruleCount();
  const cases: [Record<string, unknown>, number, string][] = [
    [{ ruleId: id, revision: 0 }, 409, "revision_conflict"],
    [{ ruleId: id, revision: 2 }, 409, "revision_conflict"],
    [{ revision: 1 }, 400, "invalid_request"],
    [{ timezone: "Europe/Nowhere" }, 400, "invalid_request"],
    [{ timezone: "UTC+9" }, 400, "invalid_request"],
    [
      { pattern: { kind: "weekly", weekdays: [1], start: "02:00", end: "02:00" } },
      400,
      "invalid_request",
    ],
    [
      { pattern: { kind: "weekly", weekdays: [7], start: "01:00", end: "02:00" } },
      400,
      "invalid_request",
    ],
    [
      {
        pattern: {
          kind: "monthly",
          weekday: 1,
          nth: 6,
          offsetDays: 0,
          start: "01:00",
          end: "02:00",
        },
      },
      400,
      "invalid_request",
    ],
    [
      {
        pattern: { kind: "once", from: iso(Date.now() + 2 * DAY), to: iso(Date.now() + DAY) },
      },
      400,
      "invalid_request",
    ],
    [{ pattern: { kind: "daily", time: "01:00", weekdays: [1] } }, 400, "invalid_request"],
    [{ verifiedAt: iso(Date.now() + DAY) }, 400, "invalid_request"],
    [{ verifiedAt: "2026-01-01" }, 400, "invalid_request"],
    [{ referenceUrl: "https://elsewhere.synthetic.test/notices" }, 400, "invalid_reference"],
    [{ referenceUrl: "http://maintenance.synthetic.test/notices" }, 400, "invalid_reference"],
    [{ referenceUrl: "not a url" }, 400, "invalid_reference"],
    [{ reason: undefined }, 400, "reason_required"],
    [{ reason: "   " }, 400, "reason_required"],
    [{ reason: "x".repeat(501) }, 400, "reason_required"],
    [{ reason: "two\nlines" }, 400, "reason_required"],
    [{ actor: "someone-else" }, 400, "invalid_request"],
    [{ id: "chosen-id" }, 400, "invalid_request"],
  ];
  for (const [overrides, status, error] of cases) {
    const body: Record<string, unknown> = rule("vpass", overrides);
    if ("reason" in overrides && overrides["reason"] === undefined) delete body["reason"];
    const result = await write(body);
    expect([JSON.stringify(overrides), result.status, result.body]).toEqual([
      JSON.stringify(overrides),
      status,
      { error },
    ]);
  }
  expect(await ruleCount()).toBe(count);
});

test("another source's rule answers exactly like a rule that does not exist", async () => {
  const foreign = await write(rule("myjcb"));
  expect(foreign.status).toBe(200);
  const owned = await write(rule("vpass", { ruleId: foreign.body.ruleId, revision: 1 }));
  const missing = await write(rule("vpass", { ruleId: "no-such-rule", revision: 1 }));
  expect(owned).toEqual({ status: 404, body: { error: "maintenance_rule_not_found" } });
  expect(missing).toEqual(owned);
});

test("an agent cannot turn a maintenance window into a disabled job", async () => {
  const start = Date.now() + 2 * DAY;
  const long = await write(
    rule("st-george", { pattern: { kind: "once", from: iso(start), to: iso(start + 8 * DAY) } }),
  );
  expect(long).toEqual({ status: 422, body: { error: "maintenance_deferral_too_long" } });
  // Two adjacent windows of six days join to twelve: the second is refused.
  const first = await write(
    rule("st-george", { pattern: { kind: "once", from: iso(start), to: iso(start + 6 * DAY) } }),
  );
  expect(first.status).toBe(200);
  const adjacent = await write(
    rule("st-george", {
      pattern: { kind: "once", from: iso(start + 6 * DAY), to: iso(start + 12 * DAY) },
    }),
  );
  expect(adjacent.body).toEqual({ error: "maintenance_deferral_too_long" });
  // Recurring windows that cover every minute never end: refused, not stored.
  const morning = await write(
    rule("vpoint", {
      pattern: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "12:00" },
    }),
  );
  expect(morning.status).toBe(200);
  const evening = await write(
    rule("vpoint", {
      pattern: { kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], start: "12:00", end: "00:00" },
    }),
  );
  expect(evening).toEqual({ status: 422, body: { error: "maintenance_deferral_too_long" } });
  // Withdrawing a window is always possible.
  const withdrawn = await write(
    rule("st-george", {
      ruleId: first.body.ruleId,
      revision: 1,
      enabled: false,
      pattern: { kind: "once", from: iso(start), to: iso(start + 6 * DAY) },
    }),
  );
  expect(withdrawn.status).toBe(200);
});

test("an operator's longer window does not block an agent's unrelated revision", async () => {
  // Noon UTC, so no Wednesday 01:00-02:00 window can touch either end.
  const start = Math.floor(Date.now() / DAY) * DAY + 3 * DAY + DAY / 2;
  const operator = await post(
    "/internal/schedules/maintenance",
    {
      id: "synthetic-operator-window",
      revision: 0,
      source: "moneyforward-me",
      timezone: "UTC",
      pattern: { kind: "once", from: iso(start), to: iso(start + 10 * DAY) },
      enabled: true,
      referenceUrl: REFERENCE,
      verifiedAt: verified(),
      scope: "collection",
    },
    { "x-kogane-operator": OPERATOR },
  );
  expect(operator.body).toEqual({ saved: true, revision: 1, reservation: "armed" });
  // The operator path still records nothing it did not before but its kind.
  expect(await revisions("synthetic-operator-window")).toEqual([
    { revision: 1, actor: OPERATOR, actor_kind: "operator", change_reason: null },
  ]);
  const unrelated = await write(
    rule("moneyforward-me", {
      pattern: { kind: "weekly", weekdays: [3], start: "01:00", end: "02:00" },
    }),
  );
  expect(unrelated.status).toBe(200);
  const lengthening = await write(
    rule("moneyforward-me", {
      pattern: { kind: "once", from: iso(start + 10 * DAY), to: iso(start + 11 * DAY) },
    }),
  );
  expect(lengthening.body).toEqual({ error: "maintenance_deferral_too_long" });
});

test("an operator's longer window does not admit a separate long agent window", async () => {
  // Noon UTC, so no seeded window can touch either end of the operator's.
  const start = Math.floor(Date.now() / DAY) * DAY + 3 * DAY + DAY / 2;
  const operator = await post(
    "/internal/schedules/maintenance",
    {
      id: "synthetic-operator-long-window",
      revision: 0,
      source: "mobile-suica",
      timezone: "UTC",
      pattern: { kind: "once", from: iso(start), to: iso(start + 10 * DAY) },
      enabled: true,
      referenceUrl: REFERENCE,
      verifiedAt: verified(),
      scope: "collection",
    },
    { "x-kogane-operator": OPERATOR },
  );
  expect(operator.body).toEqual({ saved: true, revision: 1, reservation: "armed" });
  const count = await ruleCount();
  // A separate eight-day window is a new long deferral, whatever else exists.
  const separate = await write(
    rule("mobile-suica", {
      pattern: { kind: "once", from: iso(start + 30 * DAY), to: iso(start + 38 * DAY) },
    }),
  );
  expect(separate).toEqual({ status: 422, body: { error: "maintenance_deferral_too_long" } });
  // Moving the operator's window is a long deferral where there was none.
  const moved = await write(
    rule("mobile-suica", {
      ruleId: "synthetic-operator-long-window",
      revision: 1,
      timezone: "UTC",
      pattern: { kind: "once", from: iso(start + DAY), to: iso(start + 11 * DAY) },
    }),
  );
  expect(moved).toEqual({ status: 422, body: { error: "maintenance_deferral_too_long" } });
  expect(await ruleCount()).toBe(count);
  // Shortening it inside its old span is not.
  const shortened = await write(
    rule("mobile-suica", {
      ruleId: "synthetic-operator-long-window",
      revision: 1,
      timezone: "UTC",
      pattern: { kind: "once", from: iso(start + DAY), to: iso(start + 9 * DAY) },
    }),
  );
  expect(shortened.status).toBe(200);
});

test("a running window counts its spent part, so extending it cannot outlast the bound", async () => {
  const now = Date.now();
  const running = await write(
    rule("prestia-globalpass", {
      pattern: { kind: "once", from: iso(now - 5 * DAY), to: iso(now + DAY) },
    }),
  );
  expect(running.status).toBe(200);
  const id = running.body.ruleId as string;
  // Five days spent and three more is eight: refused, though only three remain.
  const extended = await write(
    rule("prestia-globalpass", {
      ruleId: id,
      revision: 1,
      pattern: { kind: "once", from: iso(now - 5 * DAY), to: iso(now + 3 * DAY) },
    }),
  );
  expect(extended).toEqual({ status: 422, body: { error: "maintenance_deferral_too_long" } });
  // Ending it sooner is always possible.
  const shortened = await write(
    rule("prestia-globalpass", {
      ruleId: id,
      revision: 1,
      pattern: { kind: "once", from: iso(now - 5 * DAY), to: iso(now + 3_600_000) },
    }),
  );
  expect(shortened.status).toBe(200);
});

test("the daily write budget is per principal and refuses before writing", async () => {
  const at = new Date().toISOString();
  const statements = Array.from({ length: 30 }, (_, i) =>
    db
      .prepare(
        'INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at,actor_kind,change_reason) VALUES(?,1,\'sbi-shinsei\',\'UTC\',\'{"kind":"weekly","weekdays":[1],"start":"01:00","end":"02:00"}\',0,?,?,\'collection\',?,?,\'agent\',\'synthetic budget fill\')',
      )
      .bind(`synthetic-budget-${i}`, REFERENCE, at, OTHER_AGENT, at),
  );
  await db.batch(statements);
  const count = await ruleCount();
  const spent = await write(rule("sbi-shinsei"), { "x-kogane-agent": OTHER_AGENT });
  expect(spent).toEqual({ status: 429, body: { error: "maintenance_write_budget_exceeded" } });
  expect(await ruleCount()).toBe(count);
  const limits = (await read([], { "x-kogane-agent": OTHER_AGENT })).body.limits;
  expect(limits).toEqual({ maxDeferralHours: 168, writesPerDay: 30, writesUsedToday: 30 });
  // Another principal's budget is its own.
  expect((await write(rule("sbi-shinsei"))).status).toBe(200);
});

test("a source without a registered maintenance reference takes no agent rule", async () => {
  // No reference was ever registered for this source (CORE 0066 invents none).
  expect(await write(rule("prestia-bank"))).toEqual({
    status: 400,
    body: { error: "invalid_reference" },
  });
});

test("a read names only the requested sources and no revision's actor", async () => {
  const one = await read(["vpass"]);
  expect(one.status).toBe(200);
  expect(one.body.sources.map((s: { source: string }) => s.source)).toEqual(["vpass"]);
  const text = JSON.stringify(one.body);
  for (const other of jobs.map((job) => job.source).filter((s) => s && s !== "vpass"))
    expect(text).not.toContain(`"${other}`);
  expect(text).not.toContain(OPERATOR);
  expect(text).not.toContain("migration:synthetic");
  // Receipts carry their outcome, never run or evidence references.
  expect(text).not.toContain("runIds");
  expect(text).not.toContain("evidenceId");
  const unknown = await read(["vpass", "no-such-source"]);
  expect(unknown.body.sources).toEqual(one.body.sources);
  const all = await read("*");
  expect(all.body.sources.map((s: { source: string }) => s.source)).toEqual(
    [...new Set(jobs.map((job) => job.source).filter(Boolean))].sort(),
  );
  for (const sources of [null, "vpass", [1], Array(65).fill("vpass")])
    expect((await read(sources)).status).toBe(400);
});

test("the agent path refuses an operator identity, and the operator path an agent one", async () => {
  expect(await write(rule("vpass"), {})).toEqual({
    status: 403,
    body: { error: "agent_required" },
  });
  expect(await write(rule("vpass"), { "x-kogane-agent": "bad agent" })).toEqual({
    status: 403,
    body: { error: "agent_required" },
  });
  expect(
    await write(rule("vpass"), { "x-kogane-agent": AGENT, "x-kogane-operator": OPERATOR }),
  ).toEqual({ status: 400, body: { error: "invalid_request" } });
  expect(
    (
      await post("/internal/schedules/maintenance", rule("vpass"), {
        "x-kogane-agent": AGENT,
        "x-kogane-operator": OPERATOR,
      })
    ).body,
  ).toEqual({ error: "operator_required" });
  // No other settings function is reachable from the agent prefix.
  for (const path of ["/agent/vpass", "/agent/leases/vpass", "/agent/bootstrap"])
    expect((await post(`/internal/schedules${path}`, {})).status).toBe(404);
  expect((await post("/internal/schedules/agent/maintenance", "{")).status).toBe(400);
});

test("the store refuses an agent revision without a reason and keeps revisions append-only", async () => {
  await expect(
    db
      .prepare(
        "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at,actor_kind) VALUES('synthetic-no-reason',1,'vpass','UTC','{}',0,?,?,'collection',?,?,'agent')",
      )
      .bind(REFERENCE, verified(), AGENT, verified())
      .run(),
  ).rejects.toThrow("CHECK constraint failed");
  await expect(
    db.prepare("UPDATE provider_maintenance_rules SET change_reason='rewritten'").run(),
  ).rejects.toThrow("append_only");
});

test("the writer is importable and answers closed codes instead of throwing", async () => {
  const processorEnv = { DB: db, SCHEDULE_ALARMS: namespace } as unknown as Env;
  const base: MaintenanceWrite = {
    source: "sbi-securities",
    ruleId: null,
    expectedRevision: 0,
    change: {
      timezone: "UTC",
      pattern: { kind: "weekly", weekdays: [4], start: "03:00", end: "04:00" },
      enabled: true,
      scope: "collection",
    },
    provenance: {
      referenceUrl: REFERENCE,
      verifiedAt: verified(),
      decisionRef: "proposal:synthetic-0001",
    },
    actor: { kind: "operator", id: OPERATOR },
    reason: "Synthetic reviewed proposal accepted",
  };
  const created = await writeMaintenanceRevision(processorEnv, base);
  expect(created).toMatchObject({ ok: true, revision: 1, reconciled: true });
  if (!created.ok) throw new Error("unreachable");
  expect(created.ruleId).toMatch(/^sbi-securities-[0-9a-f]{12}$/u);
  expect(
    await db
      .prepare(
        "SELECT actor,actor_kind,change_reason,decision_ref FROM provider_maintenance_rules WHERE id=?",
      )
      .bind(created.ruleId)
      .first<Record<string, unknown>>(),
  ).toEqual({
    actor: OPERATOR,
    actor_kind: "operator",
    change_reason: "Synthetic reviewed proposal accepted",
    decision_ref: "proposal:synthetic-0001",
  });
  const refusals: [unknown, keyof typeof MAINTENANCE_WRITE_CODES][] = [
    [{ ...base, ruleId: created.ruleId }, "revision_conflict"],
    [{ ...base, provenance: { ...base.provenance, decisionRef: "has space" } }, "invalid_request"],
    [{ ...base, actor: { kind: "service", id: OPERATOR } }, "invalid_request"],
    [{ ...base, actor: { kind: "agent", id: AGENT }, reason: null }, "reason_required"],
    [{ ...base, change: { ...base.change, timezone: "Asia/Nowhere" } }, "invalid_request"],
    [{ ...base, provenance: { ...base.provenance, referenceUrl: "ftp://x" } }, "invalid_reference"],
    [null, "invalid_request"],
  ];
  for (const [write, code] of refusals) {
    const result = await writeMaintenanceRevision(processorEnv, write as MaintenanceWrite);
    expect(result).toEqual({ ok: false, code, status: MAINTENANCE_WRITE_CODES[code] });
  }
});
