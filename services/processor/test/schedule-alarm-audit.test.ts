// The `alarm` audit records (ADR 0064, plan slice S7): `ScheduleAlarm` writes
// one `accepted` record per occurrence of a `collection`-kind job it claims,
// in the claim's own batch; the `processor` tick and the `keepalive` job
// write none, and a redelivered alarm that claims nothing writes nothing.
//
// The production alarm and its SQL are bundled unchanged; only the Durable
// Object base is replaced, and every collector is a synthetic stub.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { loadBundleFixture } from "./bundle-module-fixture.ts";
import { startPipeline } from "./harness";

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(value: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface State {
  storage: Storage;
  blockConcurrencyWhile<T>(action: () => Promise<T>): Promise<T>;
  exports: { ScheduledPipeline: { runTick(): Promise<void> } };
}
interface Alarm {
  alarm(): Promise<void>;
}
let mf: Miniflare, env: Env, AlarmClass: new (state: State, env: Env) => Alarm;
let bundleFixture: { dispose(): Promise<void> } | undefined;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  // No synthetic occurrence may wait for a seeded maintenance window: every
  // current rule gets a disabled revision.
  await env.DB.prepare(
    "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT m.id,m.revision+1,m.source,m.timezone,m.pattern_json,0,m.reference_url,m.verified_at,m.scope,'synthetic','2026-01-01T00:00:00.000Z' FROM provider_maintenance_rules m WHERE NOT EXISTS(SELECT 1 FROM provider_maintenance_rules n WHERE n.id=m.id AND n.revision>m.revision)",
  ).run();
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/schedule-alarm.ts", import.meta.url).pathname],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "audit-durable-base",
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "base",
            namespace: "audit",
          }));
          build.onLoad({ filter: /.*/, namespace: "audit" }, () => ({
            contents:
              "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!bundle.success) throw new Error("audit_alarm_bundle_failed");
  const loaded = await loadBundleFixture<{ ScheduleAlarm: new (state: State, env: Env) => Alarm }>(
    await bundle.outputs[0]!.text(),
  );
  bundleFixture = loaded;
  AlarmClass = loaded.module.ScheduleAlarm;
}, 30000);
afterAll(async () => {
  try {
    await mf?.dispose();
  } finally {
    await bundleFixture?.dispose();
  }
});

function state(job: string): State {
  const values = new Map<string, unknown>([["job", job]]);
  let alarm: number | null = null;
  return {
    storage: {
      async get<T>(key: string) {
        return values.get(key) as T | undefined;
      },
      async put(key: string, value: unknown) {
        values.set(key, value);
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(value: number) {
        alarm = value;
      },
      async deleteAlarm() {
        alarm = null;
      },
    },
    async blockConcurrencyWhile<T>(action: () => Promise<T>) {
      return action();
    },
    exports: { ScheduledPipeline: { runTick: () => Promise.resolve() } },
  };
}

/** Makes `job` due a minute ago and returns its nominal instant. */
async function due(job: string): Promise<string> {
  const instant = new Date(Date.now() - 60000).toISOString();
  await env.DB.prepare(
    "UPDATE collection_schedules SET enabled=1,next_nominal_at=?,next_run_at=? WHERE id=?",
  )
    .bind(instant, instant, job)
    .run();
  return instant;
}

const COLLECTOR = {
  async runScheduled() {
    return { status: "completed", runIds: ["run-synthetic"], failureCode: null };
  },
};
const withCollectors = () =>
  ({
    ...env,
    SCHEDULE_MIZUHO: COLLECTOR,
    SCHEDULE_SBI_VC_TRADE: COLLECTOR,
  }) as unknown as Env;

async function alarmRecords(): Promise<Record<string, string | null>[]> {
  return (
    await env.DB.prepare(
      "SELECT * FROM audit_records WHERE path='alarm' ORDER BY recorded_at,audit_id",
    ).all<Record<string, string | null>>()
  ).results;
}

test("a claimed collection occurrence is one accepted record in its claim's batch; a redelivery adds none", async () => {
  const nominal = await due("mizuho-bank");
  const revision = await env.DB.prepare("SELECT revision FROM collection_schedules WHERE id=?")
    .bind("mizuho-bank")
    .first<number>("revision");
  const ctx = state("mizuho-bank");
  await new AlarmClass(ctx, withCollectors()).alarm();
  await new AlarmClass(ctx, withCollectors()).alarm();
  const records = await alarmRecords();
  expect(records).toHaveLength(1);
  const [record] = records;
  const occurrence = await env.DB.prepare(
    "SELECT id,started_at,status FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank' AND nominal_at=?",
  )
    .bind(nominal)
    .first<{ id: string; started_at: string; status: string }>();
  expect(occurrence!.status).toBe("completed");
  expect(record).toMatchObject({
    path: "alarm",
    subject: null,
    principal: "alarm:mizuho-bank",
    principal_kind: "automatic",
    delegation_ref: null,
    operation: "alarm.occurrence.claim",
    risk_class: "R2",
    step: "call",
    scope_namespace: "schedule-source",
    scope_source: "mizuho-bank",
    target_ref: "schedule:mizuho-bank",
    result: "accepted",
    result_code: null,
    recorded_at: occurrence!.started_at,
  });
  expect(JSON.parse(record!.refs_json!)).toEqual([
    `occurrence:${occurrence!.id}`,
    `schedule:mizuho-bank@${revision}`,
  ]);
  // The outcome stays in the occurrence row: the record has no run id.
  expect(JSON.parse(record!.diff_json!)).toEqual({ kind: "none" });
  expect(JSON.stringify(record)).not.toContain("run-synthetic");
});

test("an occurrence an earlier attempt already claimed is not claimed again and gets no record", async () => {
  const nominal = await due("mizuho-bank");
  const occurrenceId = `scheduled:mizuho-bank:${Date.parse(nominal)}`;
  // An earlier attempt's claim row of the same occurrence, at another instant.
  await env.DB.prepare(
    "INSERT INTO collection_schedule_occurrences(id,schedule_id,nominal_at,started_at,status) VALUES(?,'mizuho-bank',?,?,'started')",
  )
    .bind(occurrenceId, nominal, new Date(Date.parse(nominal) + 1000).toISOString())
    .run();
  const before = (await alarmRecords()).length;
  let calls = 0;
  await new AlarmClass(state("mizuho-bank"), {
    ...env,
    SCHEDULE_MIZUHO: {
      async runScheduled() {
        calls++;
        return { status: "completed", runIds: [], failureCode: null };
      },
    },
  } as unknown as Env).alarm();
  // The insert was ignored, so the record's guard found no row of this claim.
  expect(calls).toBe(0);
  expect((await alarmRecords()).length).toBe(before);
  expect(
    await env.DB.prepare("SELECT status FROM collection_schedule_occurrences WHERE id=?")
      .bind(occurrenceId)
      .first<string>("status"),
  ).toBe("uncertain");
});

test("the processor tick and the keepalive job claim their occurrences and write no audit record", async () => {
  const before = (await alarmRecords()).length;
  for (const job of ["processor-tick", "sbi-vc-keepalive"]) {
    const nominal = await due(job);
    await new AlarmClass(state(job), withCollectors()).alarm();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM collection_schedule_occurrences WHERE schedule_id=? AND nominal_at=?",
      )
        .bind(job, nominal)
        .first<number>("n"),
    ).toBe(1);
  }
  expect((await alarmRecords()).length).toBe(before);
});

test("a claim whose record cannot be written is not claimed either, and the alarm re-arms", async () => {
  const nominal = await due("mizuho-bank");
  await env.DB.prepare(
    "CREATE TRIGGER refuse_alarm_audit BEFORE INSERT ON audit_records WHEN NEW.path='alarm' BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END",
  ).run();
  let calls = 0;
  const ctx = state("mizuho-bank");
  try {
    await new AlarmClass(ctx, {
      ...env,
      SCHEDULE_MIZUHO: {
        async runScheduled() {
          calls++;
          return { status: "completed", runIds: [], failureCode: null };
        },
      },
    } as unknown as Env).alarm();
  } finally {
    await env.DB.prepare("DROP TRIGGER refuse_alarm_audit").run();
  }
  // The batch rolled back whole: no occurrence, no provider contact, and the
  // schedule still waits on the same nominal instant for the retry.
  expect(calls).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank' AND nominal_at=?",
    )
      .bind(nominal)
      .first<number>("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT next_nominal_at FROM collection_schedules WHERE id='mizuho-bank'")
      .bind()
      .first<string>("next_nominal_at"),
  ).toBe(nominal);
  expect((await ctx.storage.getAlarm())!).toBeGreaterThan(Date.now());
});

test("the processor tick frees a silent lease and records it as the tick (ADR 0085)", async () => {
  const ref = "4e1a2b3c-0000-4000-8000-0000000000c1";
  await env.DB.prepare(
    "INSERT OR REPLACE INTO collection_execution_leases(source,lease_ref,started_at,heartbeat_at) VALUES('myjcb',?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 minutes'))",
  )
    .bind(ref)
    .run();
  await due("processor-tick");
  await new AlarmClass(state("processor-tick"), withCollectors()).alarm();
  expect(
    await env.DB.prepare(
      "SELECT lease_ref FROM collection_execution_leases WHERE source='myjcb'",
    ).first<string | null>("lease_ref"),
  ).toBeNull();
  const records = (await alarmRecords()).filter(
    (record) => record.operation === "alarm.lease.expire",
  );
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    principal: "alarm:processor-tick",
    target_ref: "collection-lease:myjcb",
    result: "applied",
  });
});
