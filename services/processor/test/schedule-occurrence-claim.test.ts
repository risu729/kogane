// The alarm's occurrence claim skips only an occurrence already claimed: its
// id, or its (schedule_id, nominal_at) under another id, each with its own ON
// CONFLICT clause, which D1 accepts here as SQLite 3.35+ does. Any other
// refusal raises, rolls the claim batch back with its schedule move and
// retries the alarm. The claim used `INSERT OR IGNORE`, which SQLite also
// applies to CHECK and NOT NULL failures: it skipped such a row, moved the
// schedule past its nominal and logged `claim_conflict`. Every value is
// synthetic.
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { LAYER_A_SQL, applyMigration, layerBMigrations } from "./harness.ts";
import { loadBundleFixture } from "./bundle-module-fixture.ts";

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
}

// Started while the module loads, so a timed-out case cannot take its
// workerd with it; every case shares it.
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default {fetch(){return new Response('synthetic')}}",
    compatibilityDate: "2026-09-07",
    d1Databases: ["DB"],
  }),
);
await mf.ready;
const db = (await mf.getD1Database("DB")) as unknown as D1Database;
let AlarmClass: new (state: State, env: Env) => Alarm;
let fixture: { dispose(): Promise<void> } | undefined;
beforeAll(async () => {
  await db.exec(LAYER_A_SQL);
  for (const name of layerBMigrations()) await applyMigration(db, name);
  // No maintenance window defers the claim: every rule's newest revision is off.
  await db
    .prepare(
      "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT id,revision+1,source,timezone,pattern_json,0,reference_url,verified_at,scope,'synthetic','2026-01-01T00:00:00.000Z' FROM provider_maintenance_rules",
    )
    .run();
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
  if (!built.success) throw new Error("claim_alarm_bundle_failed");
  const loaded = await loadBundleFixture<{ ScheduleAlarm: typeof AlarmClass }>(
    await built.outputs[0]!.text(),
  );
  fixture = loaded;
  AlarmClass = loaded.module.ScheduleAlarm;
}, 30000);
afterAll(async () => {
  try {
    await mf.dispose();
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

/** One alarm, with its log lines, its dispatches and the alarm it left armed. */
async function claimOnce(): Promise<{
  calls: number;
  lines: Record<string, unknown>[];
  errors: Record<string, unknown>[];
  alarm: number | null;
}> {
  let calls = 0;
  const context = state();
  const env = {
    DB: db,
    SCHEDULE_MIZUHO: {
      async runScheduled() {
        calls++;
        return { status: "completed", runIds: ["synthetic-claim-run"], failureCode: null };
      },
    },
  } as unknown as Env;
  const info = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await new AlarmClass(context, env).alarm();
    const parse = (logged: unknown[][]) =>
      logged.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    return {
      calls,
      lines: parse(info.mock.calls),
      errors: parse(error.mock.calls),
      alarm: await context.storage.getAlarm(),
    };
  } finally {
    info.mockRestore();
    error.mockRestore();
  }
}
const scheduleNominal = () =>
  db
    .prepare("SELECT next_nominal_at FROM collection_schedules WHERE id='mizuho-bank'")
    .first<string>("next_nominal_at");
const claimRecords = (occurrenceId: string) =>
  db
    .prepare(
      "SELECT count(*) n FROM audit_records a WHERE EXISTS(SELECT 1 FROM json_each(a.refs_json) r WHERE r.atom=?)",
    )
    .bind(`occurrence:${occurrenceId}`)
    .first<number>("n");
const occurrences = () =>
  db
    .prepare(
      "SELECT count(*) n FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank'",
    )
    .first<number>("n");

test("an unclaimed nominal is claimed once and dispatched", async () => {
  const nominal = (await scheduleNominal())!;
  const occurrenceId = `scheduled:mizuho-bank:${Date.parse(nominal)}`;
  const claimed = await claimOnce();
  expect(claimed.calls).toBe(1);
  expect(claimed.errors).toEqual([]);
  expect(claimed.lines).toContainEqual(
    expect.objectContaining({ outcome: "claimed", occurrenceId, nominalAt: nominal }),
  );
  expect(await occurrences()).toBe(1);
  expect(await claimRecords(occurrenceId)).toBe(1);
});

for (const holder of ["its id", "its schedule and nominal under another id"])
  test(`an occurrence already claimed under ${holder} is a claim_conflict, not an error`, async () => {
    const nominal = (await scheduleNominal())!;
    const occurrenceId = `scheduled:mizuho-bank:${Date.parse(nominal)}`;
    const id = holder === "its id" ? occurrenceId : "synthetic-earlier-claim";
    await db
      .prepare(
        "INSERT INTO collection_schedule_occurrences(id,schedule_id,nominal_at,started_at,status) VALUES(?,'mizuho-bank',?,?,'completed')",
      )
      .bind(id, nominal, nominal)
      .run();
    const outcome = await claimOnce();
    expect(outcome.calls).toBe(0);
    expect(outcome.errors).toEqual([]);
    expect(outcome.lines.filter((line) => line["event"] === "schedule_alarm")).toEqual([
      {
        event: "schedule_alarm",
        jobId: "mizuho-bank",
        occurrenceId,
        outcome: "claim_conflict",
        scheduleRevision: expect.any(Number),
      },
    ]);
    expect(
      await db
        .prepare(
          "SELECT id,status FROM collection_schedule_occurrences WHERE schedule_id='mizuho-bank'",
        )
        .all(),
    ).toMatchObject({ results: [{ id, status: "completed" }] });
    expect(await claimRecords(occurrenceId)).toBe(0);
  });

test("a claim the schema refuses rolls back with the schedule move and is retried, never a claim_conflict", async () => {
  const nominal = (await scheduleNominal())!;
  const occurrenceId = `scheduled:mizuho-bank:${Date.parse(nominal)}`;
  // One more CHECK on the real table, refusing this job's rows: the shape a
  // migration that tightens it would leave. The shipped CHECK constraints
  // refuse no row the claim builds.
  await db
    .prepare(
      "ALTER TABLE collection_schedule_occurrences ADD COLUMN refusal_probe INTEGER CHECK(schedule_id<>'mizuho-bank')",
    )
    .run();
  let refused: Awaited<ReturnType<typeof claimOnce>>;
  const before = Date.now();
  try {
    refused = await claimOnce();
  } finally {
    await db.prepare("ALTER TABLE collection_schedule_occurrences DROP COLUMN refusal_probe").run();
  }
  expect(refused.alarm).toBeGreaterThanOrEqual(before + 60_000);
  expect(refused.calls).toBe(0);
  expect(refused.lines.filter((line) => line["outcome"] === "claim_conflict")).toEqual([]);
  expect(refused.errors).toEqual([
    {
      event: "schedule_bookkeeping_retry",
      code: "scheduling_unavailable",
      jobId: "mizuho-bank",
      occurrenceId,
      phase: "claim",
      errorName: "Error",
      errorKind: "d1",
    },
  ]);
  // Nothing of the batch: no occurrence, no record, and the nominal is still due.
  expect(await occurrences()).toBe(0);
  expect(await claimRecords(occurrenceId)).toBe(0);
  expect(await scheduleNominal()).toBe(nominal);
  // The retry, once the table accepts the row, claims that same nominal.
  const retried = await claimOnce();
  expect(retried.calls).toBe(1);
  expect(retried.lines).toContainEqual(
    expect.objectContaining({ outcome: "claimed", occurrenceId, nominalAt: nominal }),
  );
  expect(await claimRecords(occurrenceId)).toBe(1);
});
