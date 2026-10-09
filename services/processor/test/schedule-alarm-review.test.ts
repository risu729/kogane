import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
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
}
interface Alarm {
  alarm(): Promise<void>;
}
let mf: Miniflare, env: Env, AlarmClass: new (state: State, env: Env) => Alarm;
let bundleFixture: { dispose(): Promise<void> } | undefined;
beforeAll(async () => {
  const started = await startPipeline();
  mf = started.mf;
  env = started.env;
  // Every CI date is valid: the synthetic alarm test is independent of the
  // seed's real recurring maintenance, disabled here by a new revision.
  await env.DB.prepare(
    "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT m.id,m.revision+1,m.source,m.timezone,m.pattern_json,0,m.reference_url,m.verified_at,m.scope,'synthetic','2026-01-01T00:00:00.000Z' FROM provider_maintenance_rules m WHERE m.source='mizuho-bank' AND NOT EXISTS(SELECT 1 FROM provider_maintenance_rules n WHERE n.id=m.id AND n.revision>m.revision)",
  ).run();
  // Only the platform base is replaced; the production alarm and SQL/store
  // code are bundled unchanged. The provider is an explicit synthetic stub.
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/schedule-alarm.ts", import.meta.url).pathname],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "review-durable-base",
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "base",
            namespace: "review",
          }));
          build.onLoad({ filter: /.*/, namespace: "review" }, () => ({
            contents:
              "export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!bundle.success) throw new Error("review_alarm_bundle_failed");
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
function state(job = "mizuho-bank") {
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
  } satisfies State;
}
async function due() {
  const instant = new Date(Date.now() - 60000).toISOString();
  await env.DB.prepare(
    "UPDATE collection_schedules SET enabled=1,next_nominal_at=?,next_run_at=? WHERE id='mizuho-bank'",
  )
    .bind(instant, instant)
    .run();
  return instant;
}
test("provider uncertainty is recorded once and immediate redelivery cannot resubmit", async () => {
  const nominal = await due();
  let calls = 0;
  const fake = {
    ...env,
    SCHEDULE_MIZUHO: {
      async runScheduled() {
        calls++;
        expect(
          await env.DB.prepare(
            "SELECT status FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank' AND nominal_at=?",
          )
            .bind(nominal)
            .first<string>("status"),
        ).toBe("started");
        return { status: "failed", runIds: [], failureCode: "dispatch_uncertain" };
      },
    },
  } as unknown as Env;
  const ctx = state();
  await new AlarmClass(ctx, fake).alarm();
  await new AlarmClass(ctx, fake).alarm();
  expect(calls).toBe(1);
  expect((await ctx.storage.getAlarm())!).toBeGreaterThan(Date.now());
  expect(
    await env.DB.prepare(
      "SELECT status FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank' AND nominal_at=?",
    )
      .bind(nominal)
      .first<string>("status"),
  ).toBe("uncertain");
});
test("D1 outage persists a new bookkeeping wakeup instead of exhausting native retries", async () => {
  let calls = 0;
  const ctx = state(),
    before = Date.now();
  const fake = {
    ...env,
    DB: {
      prepare() {
        throw new Error("synthetic_outage");
      },
    },
    SCHEDULE_MIZUHO: {
      async runScheduled() {
        calls++;
      },
    },
  } as unknown as Env;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await new AlarmClass(ctx, fake).alarm();
  } finally {
    log.mockRestore();
  }
  expect(calls).toBe(0);
  expect((await ctx.storage.getAlarm())!).toBeGreaterThanOrEqual(before + 60000);
  expect((await ctx.storage.getAlarm())!).toBeLessThanOrEqual(Date.now() + 60000);
});
test("lost receipt bookkeeping after provider return cannot cause another provider call", async () => {
  // Use a distinct occurrence even when the previous test ran within one minute.
  const nominal = new Date(Date.now() - 120000).toISOString();
  await env.DB.prepare(
    "UPDATE collection_schedules SET next_nominal_at=?,next_run_at=? WHERE id='mizuho-bank'",
  )
    .bind(nominal, nominal)
    .run();
  let calls = 0,
    failReceipt = true;
  const db = {
    prepare(sql: string) {
      if (failReceipt && sql.startsWith("UPDATE collection_schedule_occurrences SET status=?")) {
        failReceipt = false;
        throw new Error("synthetic_receipt_failure");
      }
      return env.DB.prepare(sql);
    },
    batch<T>(statements: D1PreparedStatement[]) {
      return env.DB.batch<T>(statements);
    },
  };
  const fake = {
    ...env,
    DB: db,
    SCHEDULE_MIZUHO: {
      async runScheduled() {
        calls++;
        return { status: "completed", runIds: [], failureCode: null };
      },
    },
  } as unknown as Env;
  const ctx = state(),
    log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await new AlarmClass(ctx, fake).alarm();
    await new AlarmClass(ctx, fake).alarm();
  } finally {
    log.mockRestore();
  }
  expect(calls).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT status FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank' AND nominal_at=?",
    )
      .bind(nominal)
      .first<string>("status"),
  ).toBe("started");
});
