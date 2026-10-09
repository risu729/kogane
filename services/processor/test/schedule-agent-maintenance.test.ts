// The maintenance writer for a delegated principal (ADR 0046 as amended by
// ADR 0063, item 8) and the agent read route, through the real Processor
// Worker under workerd: its `/internal/schedules` route, real Durable Object
// alarms and named service RPC. The provider is a synthetic stub that only
// counts calls; every source reference is a synthetic host and every
// principal a synthetic name.
//
// No route reaches the writer as a delegated principal yet (ADR 0063's
// delegated execution is plan slice S3), so the delegated cases call the
// importable writer directly, as that slice's route will. They append no
// audit record: the builder admits no `delegated` record until S3 (ADR 0064,
// audit vocabulary). The record's batch is shown with the operator's edit,
// which is reachable, at the end of this file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import jobs from "../../../config/alarm-jobs.json";
import {
  DELEGATED_MAINTENANCE_REASONS,
  MAINTENANCE_CHANGE_REASONS,
} from "../../../packages/collection/src/schedule-model";
import { LAYER_A_SQL, layerBMigrations, applyMigration } from "./harness";
import { applyReadMigrations } from "../../../packages/storage-d1/src/migrations";
import {
  DELEGATED_MAX_DEFERRAL_MS,
  DELEGATED_WRITES_SINCE_SQL,
  MAINTENANCE_WRITE_CODES,
  type MaintenanceWrite,
  updateMaintenance,
  writeMaintenanceRevision,
} from "../src/schedule-store";
import { ACCEPTED_REASON, proposalRef } from "../src/maintenance-survey/decisions";
import { envelopeHeaders, testCall } from "./audit-envelope";

const DELEGATE = "mcp-client:maintenance-owner-synthetic";
const OTHER_DELEGATE = "mcp-client:other-owner-synthetic";
const OPERATOR = "synthetic-operator";
const REFERENCE = "https://maintenance.synthetic.test/notices";
const DAY = 86_400_000;
/** A token-shaped value and an amount, placed where a caller can put text. */
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.dG9rZW4";
let mf: Miniflare, db: D1Database, namespace: unknown, processorEnv: Env;
const alarms = () =>
  namespace as { getByName(name: string): { reconcile(id: string): Promise<string | null> } };
/** What a delegated write appends here: nothing (see the header). */
const NO_RECORD = () => ({ statements: [], settle: () => undefined });

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
  processorEnv = { DB: db, SCHEDULE_ALARMS: namespace } as unknown as Env;
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
  headers: Record<string, string>,
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
const read = (sources: unknown, headers: Record<string, string> = { "x-kogane-agent": DELEGATE }) =>
  post("/internal/schedules/agent/read", { sources }, headers);
/** The operator header with the audit envelope the App forwards (ADR 0064). */
const operatorHeaders = () => ({ "x-kogane-operator": OPERATOR, ...envelopeHeaders() });
const iso = (ms: number) => new Date(ms).toISOString();
const verified = () => iso(Date.now() - 60_000);

/** A delegated revision request in the tool's argument shape (`ruleId` omitted to create). */
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
    reason: "official-notice-added",
    ...overrides,
  };
}
/** The writer's answer for a delegated principal, shaped like a route's. */
async function write(
  body: Record<string, unknown>,
  principal = DELEGATE,
): Promise<{ status: number; body: any }> {
  const result = await writeMaintenanceRevision(
    processorEnv,
    {
      source: body["source"],
      ruleId: body["ruleId"] ?? null,
      expectedRevision: body["revision"],
      change: {
        timezone: body["timezone"],
        pattern: body["pattern"],
        enabled: body["enabled"],
        scope: body["scope"],
      },
      provenance: { referenceUrl: body["referenceUrl"], verifiedAt: body["verifiedAt"] },
      actor: { kind: "delegated", id: principal },
      reason: body["reason"],
    } as MaintenanceWrite,
    NO_RECORD,
  );
  return result.ok
    ? {
        status: 200,
        body: {
          saved: true,
          ruleId: result.ruleId,
          revision: result.revision,
          reconciled: result.reconciled,
        },
      }
    : { status: result.status, body: { error: result.code } };
}
async function revisions(id: string) {
  return (
    await db
      .prepare(
        "SELECT revision,actor,actor_kind,change_reason,decision_ref FROM provider_maintenance_rules WHERE id=? ORDER BY revision",
      )
      .bind(id)
      .all<Record<string, unknown>>()
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

test("a delegated principal creates and revises a rule; each revision records it, its kind and a closed reason", async () => {
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
      reason: "official-notice-withdrawn",
    }),
  );
  expect(revised).toMatchObject({ status: 200, body: { revision: 2 } });
  expect(await revisions(id)).toEqual([
    {
      revision: 1,
      actor: DELEGATE,
      actor_kind: "delegated",
      change_reason: "official-notice-added",
      decision_ref: null,
    },
    {
      revision: 2,
      actor: DELEGATE,
      actor_kind: "delegated",
      change_reason: "official-notice-withdrawn",
      decision_ref: null,
    },
  ]);
  // The read route shows the revisions with their kind and reason, marks the
  // reader's own, and names no actor.
  const view = (await read(["sony-bank"])).body.sources[0];
  const listed = view.rules.find((r: { id: string }) => r.id === id);
  expect(listed.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
  expect(listed.revisions[0]).toMatchObject({
    enabled: false,
    actorKind: "delegated",
    changeReason: "official-notice-withdrawn",
    byCaller: true,
  });
  const other = (await read(["sony-bank"], { "x-kogane-agent": OTHER_DELEGATE })).body.sources[0];
  expect(other.rules.find((r: { id: string }) => r.id === id).revisions[0].byCaller).toBe(false);
  expect(JSON.stringify(view)).not.toContain(`"${DELEGATE}"`);
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
  const after = await read(["sony-bank"]);
  expect(
    after.body.sources[0].schedules.find((s: { id: string }) => s.id === "sony-bank"),
  ).toMatchObject({
    nextNominalAt: iso(nominal),
    nextRunAt: iso(end),
    actualAlarmAt: iso(end),
    reservation: "armed",
  });
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
      reason: "outage-observed",
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

test("a stale revision, a bad window, missing provenance and a reason outside the closed set write nothing", async () => {
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
    // The reason is a closed code: no free text, nothing missing, never the
    // operator's own edit, never a survey acceptance without its proposal.
    [{ reason: undefined }, 400, "invalid_reason"],
    [{ reason: "   " }, 400, "invalid_reason"],
    [{ reason: `The provider said so ${TOKEN}` }, 400, "invalid_reason"],
    [{ reason: "Official-Notice-Added" }, 400, "invalid_reason"],
    [{ reason: "operator-edit" }, 400, "invalid_reason"],
    [{ reason: ACCEPTED_REASON }, 400, "invalid_reason"],
  ];
  for (const [overrides, status, error] of cases) {
    const body: Record<string, unknown> = rule("vpass", overrides);
    const result = await write(body);
    expect([JSON.stringify(overrides), result.status, result.body]).toEqual([
      JSON.stringify(overrides),
      status,
      { error },
    ]);
  }
  expect(await ruleCount()).toBe(count);
  const stored = JSON.stringify(
    (await db.prepare("SELECT * FROM provider_maintenance_rules").all()).results,
  );
  expect(stored).not.toContain("c3ludGhldGlj");
});

test("every reason a delegated principal may give is stored as itself", async () => {
  for (const reason of DELEGATED_MAINTENANCE_REASONS) {
    const saved = await write(
      rule("sbi-securities", {
        reason,
        pattern: { kind: "weekly", weekdays: [4], start: "03:00", end: "04:00" },
      }),
    );
    expect(saved.status).toBe(200);
    expect((await revisions(saved.body.ruleId))[0]).toMatchObject({ change_reason: reason });
  }
});

test("another source's rule answers exactly like a rule that does not exist", async () => {
  const foreign = await write(rule("myjcb"));
  expect(foreign.status).toBe(200);
  const owned = await write(rule("vpass", { ruleId: foreign.body.ruleId, revision: 1 }));
  const missing = await write(rule("vpass", { ruleId: "no-such-rule", revision: 1 }));
  expect(owned).toEqual({ status: 404, body: { error: "maintenance_rule_not_found" } });
  expect(missing).toEqual(owned);
});

describe("the seven-day bound (the R1 envelope of ADR 0063 item 8)", () => {
  test("exactly seven days is inside it; one millisecond more is refused and writes nothing", async () => {
    expect(DELEGATED_MAX_DEFERRAL_MS).toBe(7 * DAY);
    // Noon UTC, so no Wednesday 01:00-02:00 window can touch either end.
    const start = Math.floor(Date.now() / DAY) * DAY + 3 * DAY + DAY / 2;
    const count = await ruleCount();
    const over = await write(
      rule("sbi-vc-trade", {
        pattern: { kind: "once", from: iso(start), to: iso(start + 7 * DAY + 1) },
      }),
    );
    expect(over).toEqual({ status: 422, body: { error: "maintenance_deferral_too_long" } });
    expect(await ruleCount()).toBe(count);
    const exact = await write(
      rule("sbi-vc-trade", {
        pattern: { kind: "once", from: iso(start), to: iso(start + 7 * DAY) },
      }),
    );
    expect(exact.status).toBe(200);
    // Lengthening that exact window by one millisecond is refused as well.
    const lengthened = await write(
      rule("sbi-vc-trade", {
        ruleId: exact.body.ruleId,
        revision: 1,
        pattern: { kind: "once", from: iso(start), to: iso(start + 7 * DAY + 1) },
      }),
    );
    expect(lengthened).toEqual({ status: 422, body: { error: "maintenance_deferral_too_long" } });
  });

  test("a delegated principal cannot turn a maintenance window into a disabled job", async () => {
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
        reason: "official-notice-withdrawn",
      }),
    );
    expect(withdrawn.status).toBe(200);
  });

  test("an operator's longer window does not block a delegated principal's unrelated revision", async () => {
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
      operatorHeaders(),
    );
    expect(operator.body).toEqual({ saved: true, revision: 1, reservation: "armed" });
    // The operator's edit records its kind and its own closed reason.
    expect(await revisions("synthetic-operator-window")).toEqual([
      {
        revision: 1,
        actor: OPERATOR,
        actor_kind: "operator",
        change_reason: "operator-edit",
        decision_ref: null,
      },
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

  test("an operator's longer window does not admit a separate long delegated window", async () => {
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
      operatorHeaders(),
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
        reason: "official-notice-changed",
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
        reason: "correction",
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
        reason: "official-notice-changed",
      }),
    );
    expect(extended).toEqual({ status: 422, body: { error: "maintenance_deferral_too_long" } });
    // Ending it sooner is always possible.
    const shortened = await write(
      rule("prestia-globalpass", {
        ruleId: id,
        revision: 1,
        pattern: { kind: "once", from: iso(now - 5 * DAY), to: iso(now + 3_600_000) },
        reason: "official-notice-changed",
      }),
    );
    expect(shortened.status).toBe(200);
  });
});

test("the daily write budget is per delegated principal and refuses before writing", async () => {
  const at = new Date().toISOString();
  const statements = Array.from({ length: 30 }, (_, i) =>
    db
      .prepare(
        'INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at,actor_kind,change_reason) VALUES(?,1,\'sbi-shinsei\',\'UTC\',\'{"kind":"weekly","weekdays":[1],"start":"01:00","end":"02:00"}\',0,?,?,\'collection\',?,?,\'delegated\',\'correction\')',
      )
      .bind(`synthetic-budget-${i}`, REFERENCE, at, OTHER_DELEGATE, at),
  );
  await db.batch(statements);
  const count = await ruleCount();
  const spent = await write(rule("sbi-shinsei"), OTHER_DELEGATE);
  expect(spent).toEqual({ status: 429, body: { error: "maintenance_write_budget_exceeded" } });
  expect(await ruleCount()).toBe(count);
  const limits = (await read([], { "x-kogane-agent": OTHER_DELEGATE })).body.limits;
  expect(limits).toEqual({ maxDeferralHours: 168, writesPerDay: 30, writesUsedToday: 30 });
  // Another principal's budget is its own, and the operator has none.
  expect((await write(rule("sbi-shinsei"))).status).toBe(200);
});

test("the budget is counted again inside the INSERT: a spent budget that lands after the pre-check writes nothing", async () => {
  // Thirty delegated revisions of this principal land between the writer's
  // own count and its batch, as concurrent writers would: the count inside the
  // INSERT refuses, and nothing of the batch is written.
  const principal = "mcp-client:raced-budget-synthetic";
  const reference = () =>
    db.prepare("SELECT * FROM provider_maintenance_references WHERE source='sbi-shinsei'").first();
  const before = await reference();
  const racing = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const at = new Date().toISOString();
      await db.batch(
        Array.from({ length: 30 }, (_, i) =>
          db
            .prepare(
              'INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at,actor_kind,change_reason) VALUES(?,1,\'sbi-shinsei\',\'UTC\',\'{"kind":"weekly","weekdays":[1],"start":"01:00","end":"02:00"}\',0,?,?,\'collection\',?,?,\'delegated\',\'correction\')',
            )
            .bind(`synthetic-raced-budget-${i}`, REFERENCE, at, principal, at),
        ),
      );
      return db.batch(statements);
    },
  } as unknown as D1Database;
  const count = await ruleCount();
  const result = await writeMaintenanceRevision(
    { ...processorEnv, DB: racing } as Env,
    {
      source: "sbi-shinsei",
      ruleId: null,
      expectedRevision: 0,
      change: {
        timezone: "Asia/Tokyo",
        pattern: {
          kind: "once",
          from: iso(Date.now() + DAY),
          to: iso(Date.now() + DAY + 3_600_000),
        },
        enabled: true,
        scope: "collection",
      },
      provenance: { referenceUrl: `${REFERENCE}/raced`, verifiedAt: verified() },
      actor: { kind: "delegated", id: principal },
      reason: "official-notice-added",
    },
    NO_RECORD,
  );
  expect(result).toEqual({ ok: false, code: "maintenance_write_budget_exceeded", status: 429 });
  // Only the thirty racing rows were added; the revision and its provenance were not.
  expect(await ruleCount()).toBe(count + 30);
  expect(await reference()).toEqual(before);
});

test("the budget count reads the rewritten partial index, without table statistics", () => {
  const sqlite = new Database(":memory:");
  const dir = new URL("../../../packages/storage-d1/migrations/core/", import.meta.url);
  try {
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
    expect(
      sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE name='sqlite_stat1'",
        )
        .get()?.n,
    ).toBe(0);
    const plan = sqlite
      .query<{ detail: string }, [string, string]>(
        `EXPLAIN QUERY PLAN ${DELEGATED_WRITES_SINCE_SQL}`,
      )
      .all(DELEGATE, iso(Date.now() - DAY))
      .map((row) => row.detail);
    expect(plan).toEqual([
      "SEARCH provider_maintenance_rules USING COVERING INDEX maintenance_agent_writes (actor=? AND created_at>?)",
    ]);
  } finally {
    sqlite.close();
  }
});

test("a source without a registered maintenance reference takes no delegated rule", async () => {
  // No reference was ever registered for this source (CORE 0066 invents none).
  expect(await write(rule("prestia-bank"))).toEqual({
    status: 400,
    body: { error: "invalid_reference" },
  });
});

test("the actor's kind and name are closed: no bare agent, no operator under an MCP name", async () => {
  const base = rule("vpass");
  const count = await ruleCount();
  for (const actor of [
    { kind: "agent", id: "maintenance-agent" },
    { kind: "delegated", id: "maintenance-owner-synthetic" },
    { kind: "delegated", id: "mcp-client:" },
    { kind: "delegated", id: "mcp-client:has space" },
    { kind: "operator", id: DELEGATE },
    { kind: "operator", id: "" },
    { kind: "service", id: OPERATOR },
  ]) {
    const result = await writeMaintenanceRevision(
      processorEnv,
      {
        source: "vpass",
        ruleId: null,
        expectedRevision: 0,
        change: {
          timezone: "Asia/Tokyo",
          pattern: base.pattern,
          enabled: true,
          scope: "collection",
        },
        provenance: { referenceUrl: base.referenceUrl, verifiedAt: base.verifiedAt },
        actor: actor as MaintenanceWrite["actor"],
        reason: "correction",
      } as MaintenanceWrite,
      NO_RECORD,
    );
    expect([actor, result]).toEqual([actor, { ok: false, code: "invalid_request", status: 400 }]);
  }
  expect(await ruleCount()).toBe(count);
});

test("a delegated principal gives only its own closed reasons, and no decision reference", async () => {
  const base = rule("vpass");
  const count = await ruleCount();
  for (const [reason, decisionRef] of [
    // A survey acceptance is the operator's (ADR 0050), even with its proposal reference.
    [ACCEPTED_REASON, proposalRef(1)],
    // A delegated revision's own decision reference is plan slice S3's.
    ["correction", proposalRef(1)],
  ] as const) {
    const result = await writeMaintenanceRevision(
      processorEnv,
      {
        source: "vpass",
        ruleId: null,
        expectedRevision: 0,
        change: {
          timezone: "Asia/Tokyo",
          pattern: base.pattern,
          enabled: true,
          scope: "collection",
        },
        provenance: { referenceUrl: base.referenceUrl, verifiedAt: base.verifiedAt, decisionRef },
        actor: { kind: "delegated", id: DELEGATE },
        reason,
      } as MaintenanceWrite,
      NO_RECORD,
    );
    expect([reason, result]).toEqual([reason, { ok: false, code: "invalid_reason", status: 400 }]);
  }
  expect(await ruleCount()).toBe(count);
});

test("a read names only the requested sources and no revision's actor", async () => {
  const one = await read(["vpass"]);
  expect(one.status).toBe(200);
  expect(one.body.sources.map((s: { source: string }) => s.source)).toEqual(["vpass"]);
  const text = JSON.stringify(one.body);
  for (const other of jobs.map((job) => job.source).filter((s) => s && s !== "vpass"))
    expect(text).not.toContain(`"${other}`);
  expect(text).not.toContain(OPERATOR);
  expect(text).not.toContain(DELEGATE);
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

test("the agent path only reads: no write route, no operator or delegation header", async () => {
  const count = await ruleCount();
  // The bare-agent write route of the original change no longer exists.
  expect(
    await post("/internal/schedules/agent/maintenance", rule("vpass"), {
      "x-kogane-agent": DELEGATE,
    }),
  ).toEqual({ status: 404, body: { error: "not_found" } });
  expect(await read(["vpass"], {})).toEqual({ status: 403, body: { error: "agent_required" } });
  expect(await read(["vpass"], { "x-kogane-agent": "bad agent" })).toEqual({
    status: 403,
    body: { error: "agent_required" },
  });
  for (const extra of [
    { "x-kogane-operator": OPERATOR },
    { "x-kogane-delegation-ref": `dlg_${"0".repeat(64)}` },
  ])
    expect(await read(["vpass"], { "x-kogane-agent": DELEGATE, ...extra })).toEqual({
      status: 400,
      body: { error: "invalid_request" },
    });
  // The operator's write route refuses any request that also names an agent,
  // and any that carries a delegation reference (ADR 0064's envelope).
  expect(
    (
      await post("/internal/schedules/maintenance", rule("vpass"), {
        ...operatorHeaders(),
        "x-kogane-agent": DELEGATE,
      })
    ).body,
  ).toEqual({ error: "operator_required" });
  expect(
    (
      await post("/internal/schedules/maintenance", rule("vpass"), {
        ...operatorHeaders(),
        "x-kogane-delegation-ref": `dlg_${"0".repeat(64)}`,
      })
    ).body,
  ).toEqual({ error: "operator_required" });
  // No other settings function is reachable from the agent prefix.
  for (const path of ["/agent/vpass", "/agent/leases/vpass", "/agent/bootstrap"])
    expect(
      (await post(`/internal/schedules${path}`, {}, { "x-kogane-agent": DELEGATE })).status,
    ).toBe(404);
  expect(
    (await post("/internal/schedules/agent/read", "{", { "x-kogane-agent": DELEGATE })).status,
  ).toBe(400);
  expect(await ruleCount()).toBe(count);
});

describe("the store's own guards (CORE 0076)", () => {
  const insert = (actorKind: string | null, reason: string | null) =>
    db
      .prepare(
        "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at,actor_kind,change_reason) VALUES(?,1,'vpass','UTC','{}',0,?,?,'collection',?,?,?,?)",
      )
      .bind(
        `synthetic-check-${crypto.randomUUID()}`,
        REFERENCE,
        verified(),
        DELEGATE,
        verified(),
        actorKind,
        reason,
      )
      .run();

  test("the reason is a closed code required with every actor kind; there is no bare agent", async () => {
    for (const [kind, reason] of [
      ["delegated", null],
      ["operator", null],
      ["agent", "correction"],
      ["delegated", "Free text the caller wrote"],
      ["delegated", "operator-edit"],
      [null, "operator-edit"],
      [null, "correction"],
      ["delegated", "maintenance-survey-proposal-rejected"],
    ] as const)
      await expect(insert(kind, reason)).rejects.toThrow("CHECK constraint failed");
    for (const reason of MAINTENANCE_CHANGE_REASONS)
      await insert(reason === "operator-edit" ? "operator" : "delegated", reason);
    // A revision written before the migration recorded neither.
    await insert(null, null);
  });

  test("the CHECK's list is MAINTENANCE_CHANGE_REASONS, code for code", () => {
    const sql = readFileSync(
      new URL(
        "../../../packages/storage-d1/migrations/core/0076_maintenance_change_provenance.sql",
        import.meta.url,
      ),
      "utf8",
    );
    // Every quoted code of the change_reason statement, less the actor kinds it names.
    const statement = sql.slice(sql.indexOf("ADD COLUMN change_reason"));
    const named = [...statement.slice(0, statement.indexOf(";")).matchAll(/'([a-z-]+)'/gu)]
      .map((match) => match[1])
      .filter((code) => code !== "operator" && code !== "delegated");
    expect([...new Set(named)].sort()).toEqual([...MAINTENANCE_CHANGE_REASONS].sort());
  });

  test("revisions stay append-only", async () => {
    await expect(
      db.prepare("UPDATE provider_maintenance_rules SET change_reason='correction'").run(),
    ).rejects.toThrow("append_only");
  });
});

describe("the writer's batch: the revision and what its caller appends are one write", () => {
  const operatorWrite = (source: string, id: string, overrides: Partial<MaintenanceWrite> = {}) =>
    ({
      source,
      ruleId: id,
      expectedRevision: 0,
      change: {
        timezone: "UTC",
        pattern: { kind: "weekly", weekdays: [4], start: "03:00", end: "04:00" },
        enabled: true,
        scope: "collection",
      },
      provenance: {
        referenceUrl: `${REFERENCE}/batch?t=${TOKEN}&a=123456`,
        verifiedAt: verified(),
      },
      actor: { kind: "operator", id: OPERATOR },
      reason: "operator-edit",
      ...overrides,
    }) as MaintenanceWrite;
  const auditRows = async (correlationId: string) =>
    (
      await db
        .prepare("SELECT * FROM audit_records WHERE correlation_id=?")
        .bind(correlationId)
        .all<Record<string, unknown>>()
    ).results;

  test("the operator's edit writes its revision and its applied record, with the closed reason", async () => {
    const correlationId = crypto.randomUUID();
    const call = testCall("schedules.maintenance.update", OPERATOR, correlationId);
    const saved = await updateMaintenance(
      processorEnv,
      {
        id: "smbc-direct-batch",
        revision: 0,
        source: "smbc-direct",
        timezone: "UTC",
        pattern: { kind: "weekly", weekdays: [4], start: "03:00", end: "04:00" },
        enabled: true,
        referenceUrl: `${REFERENCE}/batch?t=${TOKEN}&a=123456`,
        verifiedAt: verified(),
        scope: "collection",
      },
      OPERATOR,
      call,
    );
    expect(saved).toEqual({ saved: true, revision: 1, reservation: "armed" });
    expect(call.recorded).toBe(true);
    const [record, ...rest] = await auditRows(correlationId);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      operation: "schedules.maintenance.update",
      result: "applied",
      principal: OPERATOR,
      principal_kind: "human",
      target_ref: "maintenance-rule:smbc-direct-batch",
      reason_code: "operator-edit",
      scope_source: "smbc-direct",
      refs_json: '["maintenance-rule:smbc-direct-batch@1"]',
    });
    expect(await revisions("smbc-direct-batch")).toEqual([
      {
        revision: 1,
        actor: OPERATOR,
        actor_kind: "operator",
        change_reason: "operator-edit",
        decision_ref: null,
      },
    ]);
    // The reference URL is provenance of the rule, never part of the record.
    for (const needle of ["c3ludGhldGlj", "123456", "batch?"])
      expect(JSON.stringify(record)).not.toContain(needle);
  });

  test("an appended record that fails leaves no revision and no provenance change", async () => {
    const reference = () =>
      db
        .prepare(
          "SELECT reference_url FROM provider_maintenance_references WHERE source='vpoint-pay'",
        )
        .first<string>("reference_url");
    const before = await reference();
    const correlationId = crypto.randomUUID();
    await expect(
      writeMaintenanceRevision(
        processorEnv,
        operatorWrite("vpoint-pay", "vpoint-pay-failing-record"),
        (saved) => ({
          // A record the table refuses raises, as a record that cannot be written would.
          statements: [
            db
              .prepare(
                `INSERT INTO audit_records(audit_id,correlation_id) SELECT 'not-an-audit-id',? WHERE ${saved.guard.sql}`,
              )
              .bind(correlationId, ...saved.guard.binds),
          ],
          settle: () => undefined,
        }),
      ),
    ).rejects.toThrow();
    expect(await revisions("vpoint-pay-failing-record")).toEqual([]);
    expect(await reference()).toBe(before);
    expect(await auditRows(correlationId)).toEqual([]);
  });

  test("a revision that loses its version check in the batch leaves no record", async () => {
    // Another writer's revision lands between this writer's read and its
    // batch: the version-checked insert writes nothing, and the record,
    // guarded on the row the insert would have written, writes nothing either.
    const racing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await db
          .prepare(
            "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at,actor_kind,change_reason) VALUES('vpoint-pay-raced',1,'vpoint-pay','UTC','{\"kind\":\"weekly\",\"weekdays\":[1],\"start\":\"01:00\",\"end\":\"02:00\"}',0,?,?,'collection','synthetic-other-operator',?,'operator','operator-edit')",
          )
          .bind(REFERENCE, verified(), verified())
          .run();
        return db.batch(statements);
      },
    } as unknown as D1Database;
    const correlationId = crypto.randomUUID();
    const call = testCall("schedules.maintenance.update", OPERATOR, correlationId);
    await expect(
      updateMaintenance(
        { ...processorEnv, DB: racing } as Env,
        {
          id: "vpoint-pay-raced",
          revision: 0,
          source: "vpoint-pay",
          timezone: "UTC",
          pattern: { kind: "weekly", weekdays: [4], start: "03:00", end: "04:00" },
          enabled: true,
          referenceUrl: REFERENCE,
          verifiedAt: verified(),
          scope: "collection",
        },
        OPERATOR,
        call,
      ),
    ).rejects.toMatchObject({ code: "revision_conflict", status: 409 });
    expect(call.recorded).toBe(false);
    expect(await auditRows(correlationId)).toEqual([]);
    expect(await revisions("vpoint-pay-raced")).toEqual([
      {
        revision: 1,
        actor: "synthetic-other-operator",
        actor_kind: "operator",
        change_reason: "operator-edit",
        decision_ref: null,
      },
    ]);
  });

  test("the writer is importable and answers closed codes instead of throwing", async () => {
    const base = operatorWrite("sbi-securities", "sbi-securities-importable", {
      provenance: { referenceUrl: REFERENCE, verifiedAt: verified(), decisionRef: proposalRef(1) },
      reason: ACCEPTED_REASON,
    });
    const created = await writeMaintenanceRevision(processorEnv, base, NO_RECORD);
    expect(created).toEqual({
      ok: true,
      ruleId: "sbi-securities-importable",
      revision: 1,
      reconciled: true,
    });
    expect(await revisions("sbi-securities-importable")).toEqual([
      {
        revision: 1,
        actor: OPERATOR,
        actor_kind: "operator",
        change_reason: ACCEPTED_REASON,
        decision_ref: "maintenance-survey:proposal:1",
      },
    ]);
    const refusals: [unknown, keyof typeof MAINTENANCE_WRITE_CODES][] = [
      [base, "revision_conflict"],
      [
        { ...base, provenance: { ...base.provenance, decisionRef: "has space" } },
        "invalid_request",
      ],
      [
        { ...base, provenance: { ...base.provenance, decisionRef: "proposal:synthetic-0001" } },
        "invalid_request",
      ],
      // The survey's reason and its proposal reference come together or not at all.
      [{ ...base, reason: "operator-edit" }, "invalid_reason"],
      [
        { ...base, provenance: { referenceUrl: REFERENCE, verifiedAt: verified() } },
        "invalid_reason",
      ],
      [{ ...base, reason: null }, "invalid_reason"],
      [{ ...base, change: { ...base.change, timezone: "Asia/Nowhere" } }, "invalid_request"],
      [
        { ...base, provenance: { ...base.provenance, referenceUrl: "ftp://x" } },
        "invalid_reference",
      ],
      [null, "invalid_request"],
    ];
    for (const [write, code] of refusals) {
      const result = await writeMaintenanceRevision(
        processorEnv,
        write as MaintenanceWrite,
        NO_RECORD,
      );
      expect([write, result]).toEqual([
        write,
        { ok: false, code, status: MAINTENANCE_WRITE_CODES[code] },
      ]);
    }
  });
});
