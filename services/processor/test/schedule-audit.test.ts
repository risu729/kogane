// The schedule settings writers and the common audit record (ADR 0064, plan
// S1): a job edit, a maintenance edit and a lease release each write their
// `applied` record as the last statement of their own batch, through the
// Processor's private route, under the App's correlation id. A version check
// or a lease guard that matches nothing leaves neither the effect nor a
// record, and the route refuses a request that carries no audit envelope.
// Every value is synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { scheduleRoute } from "../src/schedule-store.ts";
import { auditOverflowStage } from "../src/audit-overflow.ts";
import { envelopeHeaders } from "./audit-envelope.ts";
import { startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  const started = await startPipeline();
  mf = started.mf;
  env = {
    ...started.env,
    SCHEDULES_ENABLED: "true",
    SCHEDULE_ALARMS: {
      getByName: () => ({ reconcile: async () => null, alarmTime: async () => null }),
    },
  } as unknown as Env;
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

const OPERATOR = "operator@synthetic.test";
/** A token-shaped value and an amount, placed where a caller can put text: never recorded. */
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.dG9rZW4";

function post(path: string, body: unknown, correlationId?: string, envelope = true) {
  return scheduleRoute(
    new Request(`https://pipeline.internal/internal/schedules${path}`, {
      method: "POST",
      headers: {
        "x-kogane-internal-caller": "kogane-evidence-browser",
        "x-kogane-operator": OPERATOR,
        ...(envelope ? envelopeHeaders(correlationId) : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
    new URL(`https://pipeline.internal/internal/schedules${path}`),
  ) as Promise<Response>;
}

async function records(where = "1=1", ...binds: unknown[]) {
  return (
    await env.DB.prepare(`SELECT * FROM audit_records WHERE ${where} ORDER BY recorded_at,audit_id`)
      .bind(...binds)
      .all<Record<string, unknown>>()
  ).results;
}

async function scheduleRevision(id: string): Promise<number> {
  return (await env.DB.prepare("SELECT revision FROM collection_schedules WHERE id=?")
    .bind(id)
    .first<number>("revision"))!;
}

test("a job edit records its revision in its own batch; a stale revision records nothing", async () => {
  const revision = await scheduleRevision("vpass");
  const body = {
    revision,
    enabled: false,
    timezone: "Asia/Tokyo",
    pattern: { kind: "daily", time: "06:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
  };
  const saved = await post("/vpass", body, "00000000-0000-4000-8000-000000000101");
  expect(saved.status).toBe(200);
  expect(saved.headers.get("x-kogane-audit-recorded")).toBe("1");
  const [row] = await records("correlation_id=?", "00000000-0000-4000-8000-000000000101");
  expect(row).toMatchObject({
    path: "ui",
    subject: OPERATOR,
    principal: OPERATOR,
    principal_kind: "human",
    operation: "schedules.job.update",
    risk_class: "R2",
    result: "applied",
    target_ref: "schedule:vpass",
    scope_namespace: "schedule-source",
    scope_source: "vpass",
  });
  expect(JSON.parse(row!["refs_json"] as string)).toEqual([`schedule:vpass@${revision + 1}`]);
  // Only the field that changed is named, and never its value.
  expect(JSON.parse(row!["diff_json"] as string)).toEqual({
    kind: "revision",
    from: revision,
    to: revision + 1,
    fields: ["enabled"],
  });
  // The same edit against the old revision: the version check matches no row.
  const stale = await post("/vpass", body, "00000000-0000-4000-8000-000000000102");
  expect(stale.status).toBe(409);
  expect((await stale.json()) as unknown).toEqual({ error: "revision_conflict" });
  expect(stale.headers.get("x-kogane-audit-recorded")).toBeNull();
  expect(await scheduleRevision("vpass")).toBe(revision + 1);
  expect(await records("correlation_id=?", "00000000-0000-4000-8000-000000000102")).toEqual([]);
}, 60_000);

test("a maintenance edit's revision, provenance and record are one batch; a conflict writes none", async () => {
  const reference = () =>
    env.DB.prepare(
      "SELECT reference_url FROM provider_maintenance_references WHERE source='vpass'",
    ).first<string>("reference_url");
  const before = await reference();
  // The caller's reference URL carries a token-shaped query: stored with the
  // rule as provenance, never in the audit record.
  const url = `https://www.smbc-card.com/mem/notice.html?t=${TOKEN}&a=123456`;
  const body = {
    id: "vpass-audit-window",
    revision: 0,
    source: "vpass",
    timezone: "Asia/Tokyo",
    pattern: { kind: "weekly", weekdays: [2], start: "02:00", end: "03:00" },
    enabled: true,
    referenceUrl: url,
    verifiedAt: "2026-10-01T00:00:00.000Z",
    scope: "collection",
  };
  const saved = await post("/maintenance", body, "00000000-0000-4000-8000-000000000201");
  expect(saved.status).toBe(200);
  expect(saved.headers.get("x-kogane-audit-recorded")).toBe("1");
  expect(await reference()).toBe(url);
  const [row] = await records("correlation_id=?", "00000000-0000-4000-8000-000000000201");
  expect(row).toMatchObject({
    operation: "schedules.maintenance.update",
    risk_class: "R1",
    result: "applied",
    target_ref: "maintenance-rule:vpass-audit-window",
    scope_namespace: "schedule-source",
    scope_source: "vpass",
  });
  expect(JSON.parse(row!["refs_json"] as string)).toEqual([
    "maintenance-rule:vpass-audit-window@1",
  ]);
  expect(JSON.parse(row!["diff_json"] as string)).toMatchObject({
    kind: "revision",
    from: 0,
    to: 1,
  });
  // A second create against revision 0 conflicts: no revision, no provenance
  // change, no record.
  const conflicting = await post(
    "/maintenance",
    { ...body, referenceUrl: "https://www.smbc-card.com/mem/other.html" },
    "00000000-0000-4000-8000-000000000202",
  );
  expect(conflicting.status).toBe(409);
  expect(await reference()).toBe(url);
  expect(await records("correlation_id=?", "00000000-0000-4000-8000-000000000202")).toEqual([]);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM provider_maintenance_rules WHERE id=?")
      .bind("vpass-audit-window")
      .first<number>("n"),
  ).toBe(1);
  expect(before).not.toBeNull();
  const stored = JSON.stringify(await records());
  for (const needle of ["eyJ", "c3ludGhldGlj", "123456", "notice.html"])
    expect(stored).not.toContain(needle);
}, 60_000);

test("a lease release is recorded each time it releases, and not when the lease is held by another", async () => {
  const ref = "4e1a2b3c-0000-4000-8000-000000000001";
  await env.DB.prepare(
    "INSERT OR REPLACE INTO collection_execution_leases(source,lease_ref,started_at) VALUES('mizuho-bank',?,'2026-03-01T00:00:00.000Z')",
  )
    .bind(ref)
    .run();
  const release = (correlationId: string, leaseRef = ref) =>
    post("/leases/mizuho-bank", { leaseRef, confirmedStopped: true }, correlationId);
  expect((await release("00000000-0000-4000-8000-000000000301")).status).toBe(200);
  // Repeated while unlocked: released again, recorded again.
  expect((await release("00000000-0000-4000-8000-000000000302")).status).toBe(200);
  await env.DB.prepare(
    "UPDATE collection_execution_leases SET lease_ref='4e1a2b3c-0000-4000-8000-000000000002',started_at='2026-03-02T00:00:00.000Z' WHERE source='mizuho-bank'",
  ).run();
  const held = await release("00000000-0000-4000-8000-000000000303");
  expect(held.status).toBe(409);
  expect((await held.json()) as unknown).toEqual({ error: "lease_conflict" });
  const rows = await records("operation='schedules.lease.release'");
  expect(
    rows.map((row) => [
      row["correlation_id"],
      row["result"],
      row["risk_class"],
      row["target_ref"],
      row["diff_json"],
    ]),
  ).toEqual([
    [
      "00000000-0000-4000-8000-000000000301",
      "applied",
      "R3",
      "collection-lease:mizuho-bank",
      '{"kind":"release","released":true}',
    ],
    [
      "00000000-0000-4000-8000-000000000302",
      "applied",
      "R3",
      "collection-lease:mizuho-bank",
      '{"kind":"release","released":true}',
    ],
  ]);
}, 60_000);

test("a settings write without the audit envelope is refused like one without an operator", async () => {
  const revision = await scheduleRevision("myjcb");
  const before = (await records()).length;
  const refused = await post(
    "/myjcb",
    {
      revision,
      enabled: true,
      timezone: "Asia/Tokyo",
      pattern: { kind: "daily", time: "06:30", weekdays: [1] },
    },
    undefined,
    false,
  );
  expect(refused.status).toBe(403);
  expect((await refused.json()) as unknown).toEqual({ error: "operator_required" });
  expect(await scheduleRevision("myjcb")).toBe(revision);
  expect((await records()).length).toBe(before);
}, 60_000);

test("the overflow lane runs on D1: one aggregate per ended day's counter, then none", async () => {
  await env.DB.prepare(
    `INSERT INTO audit_overflow_counters(day,principal,path,result,subject,principal_kind,count)
     VALUES('2026-10-08','agent-synthetic','agent-http','read','agent-synthetic','agent',12)`,
  ).run();
  expect(await auditOverflowStage(env, new Date("2026-10-09T00:00:00.000Z"))).toEqual({
    counters: 1,
    written: 1,
  });
  expect(await auditOverflowStage(env, new Date("2026-10-09T00:05:00.000Z"))).toEqual({
    counters: 0,
    written: 0,
  });
  const [row] = await records("operation='audit.overflow'");
  expect(row).toMatchObject({
    path: "agent-http",
    principal: "agent-synthetic",
    result: "overflow",
    diff_json: '{"kind":"overflow","of":"read","count":12,"cap":2000}',
  });
}, 60_000);

test("a record that cannot be written leaves no job revision, maintenance revision or release", async () => {
  const count = async (sql: string, ...binds: unknown[]) =>
    (await env.DB.prepare(sql)
      .bind(...binds)
      .first<number>("n"))!;
  const lease = "4e1a2b3c-0000-4000-8000-000000000009";
  await env.DB.prepare(
    "INSERT OR REPLACE INTO collection_execution_leases(source,lease_ref,started_at) VALUES('mizuho-bank',?,'2026-03-03T00:00:00.000Z')",
  )
    .bind(lease)
    .run();
  const revision = await scheduleRevision("vpass");
  const revisionRows = await count(
    "SELECT count(*) AS n FROM collection_schedule_revisions WHERE schedule_id='vpass'",
  );
  const reference = await env.DB.prepare(
    "SELECT reference_url FROM provider_maintenance_references WHERE source='vpass'",
  ).first<string>("reference_url");
  const stored = (await records()).length;
  // A synthetic trigger makes every audit insert raise, as a record the table
  // refused would: each writer's batch must be rolled back with it.
  await env.DB.prepare(
    "CREATE TRIGGER review_audit_write_fails BEFORE INSERT ON audit_records BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END",
  ).run();
  try {
    const job = await post("/vpass", {
      revision,
      enabled: true,
      timezone: "Asia/Tokyo",
      pattern: { kind: "daily", time: "07:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    });
    const maintenance = await post("/maintenance", {
      id: "vpass-audit-refused",
      revision: 0,
      source: "vpass",
      timezone: "Asia/Tokyo",
      pattern: { kind: "weekly", weekdays: [4], start: "02:00", end: "03:00" },
      enabled: true,
      referenceUrl: "https://www.smbc-card.com/mem/refused.html",
      verifiedAt: "2026-10-01T00:00:00.000Z",
      scope: "collection",
    });
    const release = await post("/leases/mizuho-bank", { leaseRef: lease, confirmedStopped: true });
    for (const response of [job, maintenance, release]) {
      expect(response.status).toBe(503);
      expect((await response.json()) as unknown).toEqual({ error: "scheduling_unavailable" });
      expect(response.headers.get("x-kogane-audit-recorded")).toBeNull();
    }
  } finally {
    await env.DB.prepare("DROP TRIGGER review_audit_write_fails").run();
  }
  expect(await scheduleRevision("vpass")).toBe(revision);
  expect(
    await count(
      "SELECT count(*) AS n FROM collection_schedule_revisions WHERE schedule_id='vpass'",
    ),
  ).toBe(revisionRows);
  expect(
    await count(
      "SELECT count(*) AS n FROM provider_maintenance_rules WHERE id='vpass-audit-refused'",
    ),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT reference_url FROM provider_maintenance_references WHERE source='vpass'",
    ).first<string>("reference_url"),
  ).toBe(reference);
  expect(
    await env.DB.prepare(
      "SELECT lease_ref FROM collection_execution_leases WHERE source='mizuho-bank'",
    ).first<string>("lease_ref"),
  ).toBe(lease);
  expect((await records()).length).toBe(stored);
}, 60_000);
