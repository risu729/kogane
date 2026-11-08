import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { LAYER_A_SQL, layerBMigrations, applyMigration } from "./harness.ts";
import { loadBundleFixture } from "./bundle-module-fixture.ts";
import { markAbandonedOccurrences, retryableOccurrence } from "../src/schedule-store.ts";
import { withCollectionLease } from "../../../packages/collection/src/schedule-lease.ts";

interface State {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(value: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  blockConcurrencyWhile<T>(action: () => Promise<T>): Promise<T>;
}
interface Alarm {
  alarm(): Promise<void>;
  reconcile(id: string): Promise<string | null>;
}
let mf: Miniflare, db: D1Database;
let AlarmClass: new (state: State, env: Env) => Alarm;
let fixture: { dispose(): Promise<void> };
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('synthetic')}}",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB", "UPGRADE"],
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await db.exec(LAYER_A_SQL);
  for (const name of layerBMigrations()) await applyMigration(db, name);
  await db
    .prepare(
      "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT id,revision+1,source,timezone,pattern_json,0,reference_url,verified_at,scope,'synthetic','2026-01-01T00:00:00.000Z' FROM provider_maintenance_rules",
    )
    .run();
  const upgrade = (await mf.getD1Database("UPGRADE")) as unknown as D1Database;
  await upgrade.exec(LAYER_A_SQL);
  const migrations = layerBMigrations();
  for (const name of migrations.slice(0, -1)) await applyMigration(upgrade, name);
  await upgrade
    .prepare(
      "INSERT INTO collection_schedule_occurrences(id,schedule_id,nominal_at,started_at,status,run_ids_json,failure_code) VALUES('before-upgrade','mizuho-bank','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','started','[]',NULL)",
    )
    .run();
  await applyMigration(upgrade, migrations.at(-1)!);
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/schedule-alarm.ts", import.meta.url))],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "synthetic-durable-base",
        setup(build) {
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "base",
            namespace: "synthetic",
          }));
          build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({
            contents:
              "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new Error("marker_alarm_bundle_failed");
  const loaded = await loadBundleFixture<{ ScheduleAlarm: typeof AlarmClass }>(
    await built.outputs[0]!.text(),
  );
  fixture = loaded;
  AlarmClass = loaded.module.ScheduleAlarm;
}, 30000);
afterAll(async () => {
  try {
    await mf?.dispose();
  } finally {
    await fixture?.dispose();
  }
});
beforeEach(async () => {
  await db.prepare("DELETE FROM collection_schedule_occurrences").run();
  await db
    .prepare(
      "UPDATE collection_execution_leases SET lease_ref=NULL,started_at=NULL,heartbeat_at=NULL",
    )
    .run();
  const at = new Date(Date.now() - 120000).toISOString();
  await db
    .prepare(
      "UPDATE collection_schedules SET enabled=1,next_nominal_at=?,next_run_at=? WHERE id='mizuho-bank'",
    )
    .bind(at, at)
    .run();
});
function state(): State {
  const values = new Map<string, unknown>([["job", "mizuho-bank"]]);
  let alarm: number | null = null;
  return {
    storage: {
      async get<T>(key: string) {
        return values.get(key) as T | undefined;
      },
      async put(key, value) {
        values.set(key, value);
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(value) {
        alarm = value;
      },
      async deleteAlarm() {
        alarm = null;
      },
    },
    async blockConcurrencyWhile<T>(action: () => Promise<T>) {
      return action();
    },
  };
}
function environment(database: D1Database, action: () => Promise<void>): Env {
  return {
    DB: database,
    SCHEDULE_MIZUHO: {
      async runScheduled() {
        await withCollectionLease({ SCHEDULE_DB: db }, "mizuho-bank", action);
        return { status: "completed", runIds: ["synthetic-marker-run"], failureCode: null };
      },
    },
  } as unknown as Env;
}
function intercepted(intercept: (sql: string) => void | Promise<void>): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (
        !sql.includes("SET dispatched_at=?") &&
        !sql.startsWith("UPDATE collection_schedule_occurrences SET status=?")
      )
        return statement;
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args);
          return {
            first: bound.first.bind(bound),
            all: bound.all.bind(bound),
            async run() {
              await intercept(sql);
              return bound.run();
            },
          };
        },
        first: statement.first.bind(statement),
        all: statement.all.bind(statement),
        run: statement.run.bind(statement),
      };
    },
    batch: db.batch.bind(db),
  } as unknown as D1Database;
}
const futureCutoff = () => new Date(Date.now() + 3600000).toISOString();
const receipt = () =>
  db
    .prepare(
      "SELECT status,failure_code,dispatch_protocol,dispatched_at,retry_claimed_at FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank' ORDER BY nominal_at LIMIT 1",
    )
    .first<Record<string, unknown>>();
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test("a claim stopped before the marker makes no RPC and is retried once through the normal lease", async () => {
  let calls = 0;
  const failed = intercepted((sql) => {
    if (sql.includes("SET dispatched_at=?")) throw new Error("synthetic_marker_failure");
  });
  await new AlarmClass(
    state(),
    environment(failed, async () => {
      calls++;
    }),
  ).alarm();
  expect(calls).toBe(0);
  await markAbandonedOccurrences(db, futureCutoff());
  expect(await receipt()).toMatchObject({
    status: "not_dispatched",
    dispatched_at: null,
    retry_claimed_at: null,
  });
  const env = environment(db, async () => {
    calls++;
    expect((await receipt())?.dispatched_at).not.toBeNull();
    expect(
      await db
        .prepare("SELECT lease_ref FROM collection_execution_leases WHERE source='mizuho-bank'")
        .first<string>("lease_ref"),
    ).not.toBeNull();
  });
  await new AlarmClass(state(), env).alarm();
  await new AlarmClass(state(), env).alarm();
  expect(calls).toBe(1);
  expect(await receipt()).toMatchObject({ status: "completed", dispatch_protocol: 1 });
  expect((await receipt())?.retry_claimed_at).not.toBeNull();
});
test("a persisted marker before RPC and lost completion remain uncertain and never replay", async () => {
  let calls = 0;
  const failed = intercepted((sql) => {
    if (sql.startsWith("UPDATE collection_schedule_occurrences SET status=?"))
      throw new Error("synthetic_receipt_failure");
  });
  const env = environment(failed, async () => {
    calls++;
    expect((await receipt())?.dispatched_at).not.toBeNull();
  });
  await new AlarmClass(state(), env).alarm();
  await markAbandonedOccurrences(db, futureCutoff());
  expect(await receipt()).toMatchObject({
    status: "uncertain",
    failure_code: "dispatch_uncertain",
  });
  await new AlarmClass(state(), env).alarm();
  expect(calls).toBe(1);
  expect(await retryableOccurrence(db, "mizuho-bank")).toBeNull();
});
test("a retry stopped before its marker exhausts its single retry without any provider call", async () => {
  let calls = 0;
  const failed = intercepted((sql) => {
    if (sql.includes("SET dispatched_at=?")) throw new Error("synthetic_marker_failure");
  });
  const env = environment(failed, async () => {
    calls++;
  });
  await new AlarmClass(state(), env).alarm();
  await markAbandonedOccurrences(db, futureCutoff());
  await new AlarmClass(state(), env).alarm();
  await markAbandonedOccurrences(db, futureCutoff());
  expect(await receipt()).toMatchObject({ status: "not_dispatched" });
  expect((await receipt())?.retry_claimed_at).not.toBeNull();
  expect(await retryableOccurrence(db, "mizuho-bank")).toBeNull();
  await new AlarmClass(state(), env).alarm();
  expect(calls).toBe(0);
});
test("a delayed original loses marker ownership while the retry races the next nominal alarm", async () => {
  const reached = gate(),
    resume = gate(),
    providerEntered = gate(),
    finishProvider = gate();
  let first = true,
    calls = 0;
  const delayed = intercepted(async (sql) => {
    if (first && sql.includes("SET dispatched_at=?")) {
      first = false;
      reached.release();
      await resume.promise;
    }
  });
  const action = async () => {
    calls++;
    providerEntered.release();
    await finishProvider.promise;
  };
  const original = new AlarmClass(state(), environment(delayed, action)).alarm();
  await reached.promise;
  await markAbandonedOccurrences(db, futureCutoff());
  const retry = new AlarmClass(state(), environment(db, action)).alarm();
  await providerEntered.promise;
  const next = new Date(Date.now() - 60000).toISOString();
  await db
    .prepare(
      "UPDATE collection_schedules SET next_nominal_at=?,next_run_at=? WHERE id='mizuho-bank'",
    )
    .bind(next, next)
    .run();
  await new AlarmClass(state(), environment(db, action)).alarm();
  resume.release();
  finishProvider.release();
  await Promise.all([original, retry]);
  expect(calls).toBe(1);
  expect(await receipt()).toMatchObject({ status: "completed" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM collection_schedule_occurrences")
      .first<number>("n"),
  ).toBe(2);
});
test("old build claims have no dispatch proof and cannot become retryable", async () => {
  await db
    .prepare(
      "INSERT INTO collection_schedule_occurrences(id,schedule_id,nominal_at,started_at,status) VALUES('legacy','mizuho-bank','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','started')",
    )
    .run();
  await markAbandonedOccurrences(db, futureCutoff());
  expect(await receipt()).toMatchObject({
    status: "uncertain",
    dispatch_protocol: 0,
    dispatched_at: null,
  });
  expect(await retryableOccurrence(db, "mizuho-bank")).toBeNull();
  await expect(
    db
      .prepare("UPDATE collection_schedule_occurrences SET dispatch_protocol=1 WHERE id='legacy'")
      .run(),
  ).rejects.toThrow("immutable_occurrence_identity");
});

test("the additive upgrade preserves old receipts without inventing dispatch proof", async () => {
  const upgrade = (await mf.getD1Database("UPGRADE")) as unknown as D1Database;
  await markAbandonedOccurrences(upgrade, futureCutoff());
  expect(
    await upgrade
      .prepare(
        "SELECT id,status,dispatch_protocol,dispatched_at,retry_claimed_at FROM collection_schedule_occurrences",
      )
      .first(),
  ).toEqual({
    id: "before-upgrade",
    status: "uncertain",
    dispatch_protocol: 0,
    dispatched_at: null,
    retry_claimed_at: null,
  });
  expect(await retryableOccurrence(upgrade, "mizuho-bank")).toBeNull();
});

test("a lost D1 marker acknowledgement never calls the collector or becomes replayable", async () => {
  let calls = 0;
  const lost = intercepted(async (sql) => {
    if (!sql.includes("SET dispatched_at=?")) return;
    const row = await db
      .prepare("SELECT id,attempt_ref FROM collection_schedule_occurrences WHERE status='started'")
      .first<{ id: string; attempt_ref: string }>();
    await db
      .prepare(
        "UPDATE collection_schedule_occurrences SET dispatched_at=? WHERE id=? AND attempt_ref=?",
      )
      .bind(new Date().toISOString(), row!.id, row!.attempt_ref)
      .run();
    throw new Error("synthetic_lost_marker_acknowledgement");
  });
  await new AlarmClass(
    state(),
    environment(lost, async () => {
      calls++;
    }),
  ).alarm();
  await markAbandonedOccurrences(db, futureCutoff());
  expect(await receipt()).toMatchObject({
    status: "uncertain",
    failure_code: "dispatch_uncertain",
  });
  expect((await receipt())?.dispatched_at).not.toBeNull();
  expect(await retryableOccurrence(db, "mizuho-bank")).toBeNull();
  expect(calls).toBe(0);
});
