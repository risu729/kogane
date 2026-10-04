// The deployed invocation probe and the queue consumer's shared budget
// (issue #87).
//
// The probe is only worth deploying if it changes nothing it measures: every
// binding of a cron or queue invocation runs through it. So the meter is
// checked for transparency first — against the sqlite CORE stand-in, the
// in-memory R2, and the Miniflare bindings the pipeline tests use — and then
// for what its one log line may carry: counts, booleans and the documented
// constants, never a key, a statement or an exception message.
//
// Synthetic throughout: `kogane-synthetic`, no amount, no account, no token.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Miniflare } from "miniflare";
import {
  DOCUMENTED_LIMITS,
  meterBucket,
  meterD1,
  OperationMeter,
  REGISTRATION_OPERATION_BUDGET,
} from "../../../packages/application/src/collection/index.ts";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket.ts";
import { fullCoreDatabase, sqliteD1 } from "../../../packages/storage-d1/test/sqlite.ts";
import {
  invocationContext,
  invocationProbe,
  meteredEnv,
  observeLane,
  platformLimitError,
} from "../src/invocation-probe.ts";
import { consumeTerminalNotifications, meteredInvocation, runScheduled } from "../src/worker.ts";
import {
  artifact,
  collectionHarness,
  notification,
  persistSyntheticRun,
  SOURCE,
  type CollectionHarness,
} from "./collection-harness.ts";
import { startPipeline } from "./harness.ts";

// The first build of the migrated CORE image runs every migration; pay it
// here under its own budget, not inside whichever test first asks for a copy
// (see packages/storage-d1/test/sqlite.ts).
beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

let mf: Miniflare;
let pipelineEnv: Env;

beforeAll(async () => {
  ({ mf, env: pipelineEnv } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

/** Every leaf of the probe line is a number or a boolean, except its two names. */
function leaves(value: unknown, path: string[] = []): [string, unknown][] {
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]));
  return [[path.join("."), value]];
}

function expectCountsOnly(line: Record<string, unknown>): void {
  for (const [path, value] of leaves(line)) {
    if (path === "event" || path === "trigger") continue;
    if (value === null) continue; // Unknown provider metadata is explicit.
    expect(["number", "boolean"]).toContain(typeof value);
  }
}

test("the D1 meter counts every statement it executes and changes nothing else", async () => {
  const raw = new Database(":memory:");
  raw.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const plain = sqliteD1(raw);
  const outer = new OperationMeter();
  const inner = new OperationMeter();
  // Two meters on one binding, as the probe's and the registration's are.
  const db = meterD1(meterD1(plain, inner), outer);
  await db.prepare("INSERT INTO t(v) VALUES (?)").bind("a").run();
  const results = await db.batch([
    db.prepare("INSERT INTO t(v) VALUES (?)").bind("b"),
    db.prepare("INSERT INTO t(v) VALUES (?)").bind("c"),
  ]);
  expect(results).toHaveLength(2);
  const second = await db.prepare("SELECT v FROM t WHERE id = ?").bind(2).first<{ v: string }>();
  expect(second?.v).toBe("b");
  expect((await db.prepare("SELECT v FROM t ORDER BY id").all()).results).toEqual([
    { v: "a" },
    { v: "b" },
    { v: "c" },
  ]);
  expect(await db.prepare("SELECT count(*) FROM t").raw()).toEqual([[3]]);
  for (const meter of [outer, inner]) {
    expect(meter.d1Statements).toBe(6);
    expect(meter.d1Batches).toBe(1);
    expect(meter.r2Operations).toBe(0);
  }
});

test("the R2 meter counts calls that reach the service and passes the rest through", async () => {
  const bucket = new FakeR2Bucket();
  const meter = new OperationMeter();
  const metered = meterBucket(bucket, meter);
  await metered.put("k", new TextEncoder().encode("synthetic"));
  expect((await metered.head("k"))?.size).toBe(9);
  expect(await (await metered.get("k"))?.arrayBuffer()).toBeDefined();
  expect((await metered.list({})).objects).toHaveLength(1);
  // A property that is not a service call is the original's, uncounted.
  expect(metered.entries).toBe(bucket.entries);
  expect(meter.r2Operations).toBe(4);
  expect(meter.total).toBe(4);
});

test("a cron invocation through the metered bindings runs every lane as it does without them", async () => {
  const unmetered: string[] = [];
  await runScheduled(pipelineEnv, undefined, (line) => unmetered.push(line));
  const lines: string[] = [];
  await meteredInvocation(
    "scheduled",
    pipelineEnv,
    (env, context) => runScheduled(env, undefined, (line) => lines.push(line), context),
    (line) => lines.push(line),
  );
  const events = (list: string[]) =>
    list.map((line) => (JSON.parse(line) as { event: string }).event);
  // The same lanes, none of them failed, then the one probe line.
  expect(events(lines).slice(0, -1)).toEqual(events(unmetered));
  expect(events(lines).some((event) => event.endsWith("_failed"))).toBe(false);
  const probe = JSON.parse(lines.at(-1)!) as Record<string, any>;
  expect(probe).toMatchObject({
    event: "invocation_budget",
    trigger: "scheduled",
    limitErrors: 0,
    documented: DOCUMENTED_LIMITS,
    registration: { budget: REGISTRATION_OPERATION_BUDGET, deferred: 0 },
  });
  expect(probe["d1Statements"]).toBeGreaterThan(0);
  expect(probe["d1RowsRead"]["statements"]).toBeGreaterThan(0);
  expect(probe["d1RowsRead"]["missing"]).toBeGreaterThan(0);
  expect(probe["lanes"]["observation_sweep"]["d1Statements"]).toBeGreaterThan(0);
  expect(probe["lanes"]["identity_sweep"]["runs"]).toBe(1);
  expect(probe["lanes"]["reconciliation_sweep"]["skipped"]).toBe(1);
  const laneStatements = Object.values(
    probe["lanes"] as Record<string, { d1Statements: number }>,
  ).reduce((sum, lane) => sum + lane.d1Statements, 0);
  // Tick audit writes belong to the invocation rather than any stage.
  expect(probe["d1Statements"]).toBeGreaterThan(laneStatements);
  expect(typeof probe["overDocumentedD1Queries"]).toBe("boolean");
  expectCountsOnly(probe);
}, 60_000);

/** A queue message whose acknowledgement is observable. */
function message(body: unknown): {
  body: unknown;
  acked: boolean;
  retried: boolean;
  ack(): void;
  retry(): void;
} {
  return {
    body,
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  };
}

async function persistPages(harness: CollectionHarness, runId: string, pages: number) {
  const artifacts = [];
  for (let index = 0; index < pages; index += 1)
    artifacts.push(await artifact(`page-${index}.json`, `{"synthetic":"${runId}-${index}"}`));
  await persistSyntheticRun(harness, { run: { runId }, artifacts });
}

test("a queue batch shares one budget: what it cannot start is retried, and the probe counts it", async () => {
  const harness = collectionHarness();
  for (const runId of ["run-001", "run-002", "run-003"]) await persistPages(harness, runId, 30);
  const messages = ["run-001", "run-002", "run-003"].map((runId) =>
    message(notification(SOURCE, runId)),
  );
  const lines: string[] = [];
  await meteredInvocation(
    "queue",
    harness.env as unknown as Env,
    (env, context) =>
      consumeTerminalNotifications(messages, env, context, (line) => lines.push(line)),
    (line) => lines.push(line),
  );
  const outcomes = lines
    .slice(0, -1)
    .map((line) => (JSON.parse(line) as { outcome: string }).outcome);
  // The first run spent the batch's budget and yielded with its progress in
  // CORE, so it is acknowledged; the scan continues it. The others did not
  // start, and are retried.
  expect(outcomes).toEqual(["pending", "deferred", "deferred"]);
  expect(messages.map((entry) => [entry.acked, entry.retried])).toEqual([
    [true, false],
    [false, true],
    [false, true],
  ]);
  const probe = JSON.parse(lines.at(-1)!) as Record<string, any>;
  expect(probe).toMatchObject({
    event: "invocation_budget",
    trigger: "queue",
    registration: { started: 1, yielded: 1, deferred: 2 },
  });
  expect(probe["registration"]["operations"]).toBeLessThanOrEqual(REGISTRATION_OPERATION_BUDGET);
  expect(probe["lanes"]["collection_notification"]).toMatchObject({
    runs: 3,
    failed: 0,
    acknowledgements: 1,
    retries: 2,
  });
  // Everything the registration spent went through the invocation's meter too.
  expect(probe["d1Statements"] + probe["r2Operations"]).toBeGreaterThanOrEqual(
    probe["registration"]["operations"],
  );
  expectCountsOnly(probe);
});

test("a continuation of the retired importer is refused and acknowledged, never registered", async () => {
  // The previous Vpass importer carried its signed transfer state on its own
  // queue as `{ v: 1, recordKey, continuation: "vpass-transfer-v2.…" }`. That
  // queue and its consumer are deleted and their backlogs were verified empty
  // (docs/legacy-retirement.md). Should such a body ever reach the terminal
  // queue it is not an R2 notification: it is refused as invalid and
  // acknowledged, so it can neither register anything nor loop into the DLQ.
  const harness = collectionHarness();
  await persistPages(harness, "run-001", 2);
  const legacy = message({
    v: 1,
    recordKey: "vpass/2026-09-01T00-00-00Z/card-001/manifest.json",
    continuation: "vpass-transfer-v2.eyJ2IjoyfQ.c2lnbmF0dXJl",
  });
  const lines: string[] = [];
  await consumeTerminalNotifications(
    [legacy],
    harness.env as unknown as Env,
    invocationContext(),
    (line) => lines.push(line),
  );
  expect(JSON.parse(lines[0]!)).toMatchObject({
    event: "collection_notification",
    outcome: "invalid",
  });
  expect([legacy.acked, legacy.retried]).toEqual([true, false]);
  expect(
    (harness.db.query("SELECT count(*) AS n FROM collection_runs").get() as { n: number }).n,
  ).toBe(0);
});

test("a failure that names a platform limit is counted, and its text is not kept", async () => {
  expect(
    platformLimitError(new Error("D1_ERROR: Too many API requests by single worker invocation.")),
  ).toBe(true);
  expect(platformLimitError(new Error("Too many subrequests."))).toBe(true);
  expect(platformLimitError(new Error("Subrequest depth limit exceeded."))).toBe(true);
  expect(platformLimitError(new Error("no such table: fetch_runs"))).toBe(false);
  expect(platformLimitError("Too many subrequests.")).toBe(false);

  const context = invocationContext();
  const lines: string[] = [];
  await runScheduled(
    pipelineEnv,
    {
      parse: async () => {
        throw new Error("D1_ERROR: Too many API requests by single worker invocation.");
      },
      identity: async () => ({}),
      balanceProjection: async () => ({}),
    },
    (line) => lines.push(line),
    context,
  );
  expect(lines[0]).toBe(
    JSON.stringify({ event: "observation_sweep_failed", code: "Error", limit: true }),
  );
  expect(context.limitErrors).toBe(1);
  const probe = invocationProbe("scheduled", new OperationMeter(), context);
  expect(probe).toMatchObject({
    limitErrors: 1,
    overDocumentedD1Queries: false,
    lanes: { observation_sweep: { failed: 1, limitErrors: 1 } },
  });
  expect(JSON.stringify(probe)).not.toContain("Too many");
});

test("the probe marks an invocation that went past a documented limit, by count alone", () => {
  const meter = new OperationMeter();
  meter.d1Statements = DOCUMENTED_LIMITS.d1QueriesPerInvocation + 1;
  expect(invocationProbe("queue", meter, invocationContext())).toMatchObject({
    overDocumentedD1Queries: true,
    overDocumentedSubrequests: false,
  });
  meter.r2Operations = DOCUMENTED_LIMITS.subrequestsPerInvocation;
  expect(invocationProbe("queue", meter, invocationContext())).toMatchObject({
    overDocumentedSubrequests: true,
  });
});

test("a binding the deployment lacks stays absent through the meter", () => {
  const env = meteredEnv(
    { RELEASE_SHA: "" } as unknown as Env,
    new OperationMeter(),
  ) as unknown as Record<string, unknown>;
  expect("DB" in env).toBe(false);
  expect(env["RELEASE_SHA"]).toBe("");
});

test("provider metadata is a covered subtotal and first/raw never expose row content as metadata", async () => {
  const result = {
    success: true,
    meta: {
      rows_read: 12,
      rows_written: 3,
      duration: 0.25,
      total_attempts: 3,
      served_by: "private-provider-detail",
    },
    results: [{ secret: "private-row" }],
  };
  const first = { meta: { rows_read: 999, rows_written: 999, duration: 999 } };
  const calls: string[] = [];
  const original = {
    bind(...args: unknown[]) {
      expect(this).toBe(original);
      calls.push("bind");
      expect(args).toEqual([7]);
      return original;
    },
    run() {
      expect(this).toBe(original);
      calls.push("run");
      return Promise.resolve(result);
    },
    all() {
      expect(this).toBe(original);
      calls.push("all");
      return Promise.resolve(result);
    },
    first() {
      expect(this).toBe(original);
      calls.push("first");
      return Promise.resolve(first);
    },
    raw() {
      expect(this).toBe(original);
      calls.push("raw");
      return Promise.resolve([[1]]);
    },
  };
  const meter = new OperationMeter();
  const db = meterD1(
    {
      prepare(_sql: string) {
        return original;
      },
    },
    meter,
  );
  expect(await db.prepare("synthetic SQL").bind(7).run()).toBe(result);
  expect(await db.prepare("synthetic SQL").all()).toBe(result);
  expect(await db.prepare("synthetic SQL").first()).toBe(first);
  expect(await db.prepare("synthetic SQL").raw()).toEqual([[1]]);
  expect(calls).toEqual(["bind", "run", "all", "first", "raw"]);
  expect(meter.summary()).toMatchObject({
    d1Statements: 4,
    d1SettledStatements: 4,
    d1FailedStatements: 0,
    d1RowsRead: { reported: 24, statements: 2, missing: 2 },
    d1RowsWritten: { reported: 6, statements: 2, missing: 2 },
    d1SqlDurationMs: { reported: 0.5, statements: 2, missing: 2 },
    d1Retries: { reported: 4, statements: 2, missing: 2 },
  });
  expect(JSON.stringify(meter.summary())).not.toContain("private");
});

test("nested meters preserve promise identity, batch statements, session semantics and independent coverage", async () => {
  const entries = [
    { success: true, meta: { rows_read: 4, rows_written: 0, duration: 0.5, total_attempts: 1 } },
    {
      success: false,
      meta: { rows_read: -1, rows_written: "private", duration: NaN, total_attempts: 0 },
    },
  ];
  const promise = Promise.resolve(entries);
  const original = {
    bind() {
      return original;
    },
  };
  const session = {
    prepare() {
      expect(this).toBe(session);
      return original;
    },
    batch(statements: object[]) {
      expect(this).toBe(session);
      expect(statements).toEqual([original, original]);
      return promise;
    },
    getBookmark() {
      expect(this).toBe(session);
      return "synthetic-bookmark";
    },
  };
  const database = {
    withSession(bookmark: string) {
      expect(this).toBe(database);
      expect(bookmark).toBe("synthetic");
      return session;
    },
  };
  const inner = new OperationMeter();
  const outer = new OperationMeter();
  const db = meterD1(meterD1(database, inner), outer).withSession("synthetic");
  expect(db.getBookmark()).toBe("synthetic-bookmark");
  expect(db.batch([db.prepare().bind(), db.prepare()])).toBe(promise);
  await promise;
  for (const meter of [inner, outer])
    expect(meter.summary()).toMatchObject({
      d1Statements: 2,
      d1Batches: 1,
      d1SettledStatements: 2,
      d1FailedStatements: 1,
      d1RowsRead: { reported: 4, statements: 1, missing: 1 },
      d1RowsWritten: { reported: 0, statements: 1, missing: 1 },
      d1SqlDurationMs: { reported: 0.5, statements: 1, missing: 1 },
      d1Retries: { reported: 0, statements: 1, missing: 1 },
    });
});

test("rejected batches and synchronous failures keep original errors and missing costs", async () => {
  const failure = new Error("private failure detail");
  const meter = new OperationMeter();
  const original = {
    run() {
      throw failure;
    },
  };
  const db = meterD1(
    {
      prepare() {
        return original;
      },
      batch(_statements: object[]) {
        return Promise.reject(failure);
      },
    },
    meter,
  );
  expect(() => db.prepare().run()).toThrow(failure);
  try {
    await db.batch([db.prepare(), db.prepare()]);
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBe(failure);
  }
  const bucket = meterBucket(
    {
      get() {
        return Promise.reject(failure);
      },
    },
    meter,
  );
  try {
    await bucket.get();
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBe(failure);
  }
  expect(meter.summary()).toMatchObject({
    d1Statements: 3,
    d1SettledStatements: 3,
    d1FailedStatements: 3,
    r2Operations: 1,
    r2SettledOperations: 1,
    r2FailedOperations: 1,
    d1RowsRead: { reported: null, statements: 0, missing: 3 },
    d1RowsWritten: { reported: null, statements: 0, missing: 3 },
    d1Retries: { reported: null, statements: 0, missing: 3 },
  });
  expect(meter.summary().d1ElapsedMs).toBeGreaterThanOrEqual(0);
  expect(meter.summary().r2ElapsedMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(meter.summary())).not.toContain("private");
  // Legacy spreads used by budget fixtures still contain exactly these counters.
  expect({ ...meter }).toEqual({ d1Statements: 3, d1Batches: 1, r2Operations: 1 });
});

test("lane aggregates isolate failures and copy only known numeric outcome fields", async () => {
  const context = invocationContext();
  const failure = new Error("private exception");
  const original = {
    run() {
      return Promise.resolve({ success: true, meta: { rows_read: 8, rows_written: 2 } });
    },
  };
  const env = {
    DB: {
      prepare() {
        return original;
      },
    },
  } as unknown as Env;
  const lines: string[] = [];
  await runScheduled(
    env,
    {
      parse: async (laneEnv) => {
        await laneEnv.DB.prepare("synthetic").run();
        return { error: 2, deferred: 1, secret: "private", retried: "private" };
      },
      identity: async () => {
        throw failure;
      },
      balanceProjection: async () => ({ enabled: false }),
      operations: async () => ({ enabled: false, failed: 0 }),
    },
    (line) => lines.push(line),
    context,
  );
  const probe = invocationProbe("scheduled", new OperationMeter(), context) as any;
  expect(probe.lanes.observation_sweep).toMatchObject({
    runs: 1,
    failed: 0,
    d1Statements: 1,
    resultCounts: { error: 2, deferred: 1 },
    d1RowsRead: { reported: 8, statements: 1, missing: 0 },
  });
  expect(probe.lanes.identity_sweep).toMatchObject({ runs: 0, failed: 1 });
  expect(probe.lanes.operation_dispatch).toMatchObject({ runs: 0, skipped: 1 });
  expect(probe.lanes.observation_sweep.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(probe)).not.toContain("private");
  expectCountsOnly(probe);
  expect(() => observeLane(env, context, "private-lane")).toThrow("unknown_observation_lane");
  expect(Object.keys(context.lanes)).toHaveLength(4);
});

test("stage-owned skipped results, deferred flags and refused outcomes stay distinct", () => {
  const env = {} as Env;
  const context = invocationContext();
  observeLane(env, context, "balance_projection").finish("ran", { status: "skipped" });
  observeLane(env, context, "collection_scan").finish("ran", { enabled: false, status: "skipped" });
  observeLane(env, context, "purchase_recognition").finish("ran", { deferred: true });
  observeLane(env, context, "purchase_recognition").finish("ran", { deferred: false });
  observeLane(env, context, "reward_read_projection").finish("ran", { status: "refused" });
  observeLane(env, context, "collection_notification").finish("ran", { outcome: "flag_off" });
  observeLane(env, context, "collection_notification").finish("ran", { outcome: "private-status" });
  const probe = invocationProbe("scheduled", new OperationMeter(), context) as any;
  expect(probe.lanes.balance_projection).toMatchObject({ runs: 0, skipped: 1 });
  expect(probe.lanes.collection_scan).toMatchObject({ runs: 0, skipped: 1 });
  expect(probe.lanes.purchase_recognition).toMatchObject({
    runs: 2,
    deferredFlags: { yes: 1, no: 1 },
    resultCounts: {},
  });
  expect(probe.lanes.reward_read_projection).toMatchObject({
    runs: 1,
    failed: 0,
    resultOutcomes: { refused: 1 },
  });
  expect(probe.lanes.collection_notification).toMatchObject({
    runs: 1,
    skipped: 1,
    resultOutcomes: { flag_off: 1 },
  });
  expect(JSON.stringify(probe)).not.toContain("private");
  expectCountsOnly(probe);
});
