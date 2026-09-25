// The per-tick records of the lanes that otherwise leave only a log line
// (migration 0049, docs/processor.md §6). Before them, whether
// `purchase_recognition` had run at all could only be read from Workers Logs.
//
// Synthetic stage results only: every count below is invented, and the
// "provider text" in the failing stage is a made-up string that must never
// reach a row.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  LANE_TICK_RETENTION,
  recordLaneTick,
} from "../../../packages/storage-d1/src/core/lane-ticks.ts";
import { LANE_TICK_COUNTS, laneTick } from "../src/lane-ticks.ts";
import { runScheduled, type ScheduledStages } from "../src/worker.ts";
import { startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM processor_lane_ticks").run();
});

interface TickRow {
  id: number;
  lane: string;
  started_at_ms: number;
  finished_at_ms: number;
  outcome: string;
  error_code: string | null;
  counts_json: string;
}

async function ticks(): Promise<TickRow[]> {
  return (await env.DB.prepare("SELECT * FROM processor_lane_ticks ORDER BY id").all<TickRow>())
    .results;
}

const ALL_FLAGS = {
  RECONCILIATION_ENABLED: "true",
  PURCHASE_RECOGNITION_ENABLED: "true",
  REWARD_CLAIMS_ENABLED: "true",
  REWARD_READ_PROJECTION_ENABLED: "true",
  REPORTS_ENABLED: "true",
  OPS_DISPATCH_ENABLED: "true",
};
const withFlags = (flags: Record<string, string | undefined>) =>
  ({ ...env, ...flags }) as unknown as Env;

// What each stage returns, shaped like the real lane results.
const PURCHASES = {
  scanned: 7,
  recognized: 3,
  revised: 1,
  reanchored: 0,
  retired: 2,
  skipped: { payment_type_unsupported: 1, amount_not_exact: 2 },
  conflicts: 0,
  failed: 0,
  deferred: false,
  proposed: 4,
  merged: 1,
  groupsSkipped: 0,
};
const RESULTS = {
  parse: { lanes: { incremental: { parsed: 1 } } },
  collection: { enabled: true, status: "scanned", seen: 2 },
  identity: { processedRuns: 2, identifiedRuns: 1, identifiedObservations: 9 },
  balanceProjection: { enabled: true, status: "unchanged", snapshotId: "a".repeat(64) },
  reconcile: {
    slices: 2,
    scanned: 11,
    groups: 3,
    groupsSkipped: 0,
    proposed: 2,
    written: 1,
    autoAccepted: 0,
  },
  settlements: { scanned: 5, proposed: 1, written: 1 },
  purchases: PURCHASES,
  rewards: {
    enabled: true,
    scanned: 4,
    promoted: 2,
    skipped: 1,
    cursor: 812,
    release: "reward-promotion-v1",
  },
  rewardReadProjection: { enabled: true, status: "unchanged" },
  reports: { generated: 0, reused: 1, reportId: "report-synthetic" },
  operations: {
    enabled: true,
    status: "dispatched",
    claimed: 1,
    dispatched: 1,
    retried: 0,
    failed: 0,
    awaiting: 0,
  },
  decisions: {
    claimed: 2,
    processed: 2,
    failed: 0,
    waiting: 0,
    blocked: 0,
    published: 1,
    outcomes: { "blocked:synthetic_code": 0 },
  },
} satisfies Record<keyof ScheduledStages, object>;

/** Every stage wired, each resolving to its synthetic result and counting its calls. */
function stagesFor(
  overrides: Partial<ScheduledStages> = {},
  calls: Record<string, number> = {},
): ScheduledStages {
  const stages = Object.fromEntries(
    Object.entries(RESULTS).map(([name, result]) => [
      name,
      () => {
        calls[name] = (calls[name] ?? 0) + 1;
        return Promise.resolve(result);
      },
    ]),
  ) as unknown as ScheduledStages;
  return { ...stages, ...overrides };
}

const RECORDED = [
  "identity_sweep",
  "reconciliation_sweep",
  "card_settlement_sweep",
  "purchase_recognition",
  "reward_claims_sweep",
  "operation_dispatch",
  "decision_outbox",
];

test("the recorded lanes are exactly the ones that keep no state of their own", () => {
  expect(Object.keys(LANE_TICK_COUNTS)).toEqual(RECORDED);
  // A lane with its own bookkeeping is not recorded twice.
  for (const lane of [
    "observation_sweep",
    "collection_scan",
    "balance_projection",
    "reward_read_projection",
    "report_job",
  ])
    expect(laneTick(lane, 0, 0, { outcome: "skipped-by-flag" })).toBeNull();
  expect(laneTick("constructor", 0, 0, { outcome: "skipped-by-flag" })).toBeNull();
  // One day of the five-minute cron.
  expect(LANE_TICK_RETENTION).toBe(288);
});

test("a tick records one row per recorded lane with exactly the counts its log line carries", async () => {
  const lines: Record<string, unknown>[] = [];
  const before = Date.now();
  await runScheduled(withFlags(ALL_FLAGS), stagesFor(), (line) => lines.push(JSON.parse(line)));
  const after = Date.now();
  // The log is what it was: one line per lane, the settlement sweep now its own.
  expect(lines.map((line) => line.event)).toEqual([
    "observation_sweep",
    "collection_scan",
    "identity_sweep",
    "balance_projection",
    "reconciliation_sweep",
    "card_settlement_sweep",
    "purchase_recognition",
    "reward_claims_sweep",
    "reward_read_projection",
    "report_job",
    "operation_dispatch",
    "decision_outbox",
  ]);
  const rows = await ticks();
  expect(rows.map((row) => row.lane)).toEqual(RECORDED);
  for (const row of rows) {
    expect(row.outcome).toBe("ran");
    expect(row.error_code).toBeNull();
    expect(row.started_at_ms).toBeGreaterThanOrEqual(before);
    expect(row.finished_at_ms).toBeGreaterThanOrEqual(row.started_at_ms);
    expect(row.finished_at_ms).toBeLessThanOrEqual(after);
  }
  const counts = Object.fromEntries(rows.map((row) => [row.lane, JSON.parse(row.counts_json)]));
  // The operator's line, persisted field for field.
  const { event: _event, ...logged } = lines.find((line) => line.event === "purchase_recognition")!;
  expect(counts["purchase_recognition"]).toEqual(logged);
  expect(counts["purchase_recognition"]).toEqual(PURCHASES);
  expect(counts["reconciliation_sweep"]).toEqual(RESULTS.reconcile);
  expect(counts["card_settlement_sweep"]).toEqual(RESULTS.settlements);
  expect(counts["identity_sweep"]).toEqual(RESULTS.identity);
  // Identifiers, cursors, release names and open-ended outcome keys stay in
  // the log line only.
  expect(counts["reward_claims_sweep"]).toEqual({ scanned: 4, promoted: 2, skipped: 1 });
  expect(counts["operation_dispatch"]).toEqual({
    claimed: 1,
    dispatched: 1,
    retried: 0,
    failed: 0,
    awaiting: 0,
  });
  expect(counts["decision_outbox"]).toEqual({
    claimed: 2,
    processed: 2,
    failed: 0,
    waiting: 0,
    blocked: 0,
    published: 1,
  });
  const stored = rows.map((row) => row.counts_json).join("\n");
  for (const text of ["reward-promotion-v1", "812", "synthetic_code", "report-synthetic"])
    expect(stored).not.toContain(text);
}, 60000);

test("a failed lane records `failed` with its safe code, never the message, and stops nothing", async () => {
  const lines: Record<string, unknown>[] = [];
  await runScheduled(
    withFlags(ALL_FLAGS),
    stagesFor({
      purchases: () => Promise.reject(new TypeError("synthetic amount=98765 merchant=架空店舗")),
      settlements: () => Promise.reject("not an Error at all"),
    }),
    (line) => lines.push(JSON.parse(line)),
  );
  expect(lines).toContainEqual({ event: "purchase_recognition_failed", code: "TypeError" });
  expect(lines).toContainEqual({ event: "card_settlement_sweep_failed", code: "unknown" });
  const rows = await ticks();
  const byLane = Object.fromEntries(rows.map((row) => [row.lane, row]));
  expect(byLane["purchase_recognition"]).toMatchObject({
    outcome: "failed",
    error_code: "TypeError",
    counts_json: "{}",
  });
  expect(byLane["card_settlement_sweep"]).toMatchObject({
    outcome: "failed",
    error_code: "unknown",
    counts_json: "{}",
  });
  // The reconciliation sweep's counts survive its sibling's failure, and the
  // lanes after the failure still ran and recorded.
  expect(JSON.parse(byLane["reconciliation_sweep"]!.counts_json)).toEqual(RESULTS.reconcile);
  expect(byLane["reward_claims_sweep"]).toMatchObject({ outcome: "ran" });
  expect(byLane["decision_outbox"]).toMatchObject({ outcome: "ran" });
  expect(JSON.stringify(rows)).not.toMatch(/98765|架空|merchant|not an Error/u);
  // A code that is not a code is reported as `unknown`, as the 0049 check demands.
  expect(laneTick("purchase_recognition", 1, 2, { outcome: "failed", code: "a message" })).toEqual({
    lane: "purchase_recognition",
    startedAtMs: 1,
    finishedAtMs: 2,
    outcome: "failed",
    errorCode: "unknown",
    counts: {},
  });
}, 60000);

test("a lane whose flag is off records `skipped-by-flag`, is not run and still logs nothing", async () => {
  const lines: Record<string, unknown>[] = [];
  const calls: Record<string, number> = {};
  const off = Object.fromEntries(Object.keys(ALL_FLAGS).map((flag) => [flag, "0"]));
  await runScheduled(
    withFlags(off),
    stagesFor(
      {
        // Always wired: the stage runs and reports its own flag as off.
        operations: () =>
          Promise.resolve({
            enabled: false,
            status: "skipped",
            claimed: 0,
            dispatched: 0,
            retried: 0,
            failed: 0,
            awaiting: 0,
          }),
      },
      calls,
    ),
    (line) => lines.push(JSON.parse(line)),
  );
  expect(lines.map((line) => line.event)).toEqual([
    "observation_sweep",
    "collection_scan",
    "identity_sweep",
    "balance_projection",
    "operation_dispatch",
    "decision_outbox",
  ]);
  for (const stage of ["reconcile", "settlements", "purchases", "rewards"])
    expect(calls[stage]).toBeUndefined();
  const rows = await ticks();
  expect(rows.map((row) => [row.lane, row.outcome])).toEqual([
    ["identity_sweep", "ran"],
    ["reconciliation_sweep", "skipped-by-flag"],
    ["card_settlement_sweep", "skipped-by-flag"],
    ["purchase_recognition", "skipped-by-flag"],
    ["reward_claims_sweep", "skipped-by-flag"],
    ["operation_dispatch", "skipped-by-flag"],
    ["decision_outbox", "ran"],
  ]);
  for (const row of rows.filter((row) => row.outcome === "skipped-by-flag")) {
    expect(row.counts_json).toBe("{}");
    expect(row.error_code).toBeNull();
    expect(row.finished_at_ms).toBeGreaterThanOrEqual(row.started_at_ms);
  }
}, 60000);

test("a lane that is not wired records nothing", async () => {
  await runScheduled(
    withFlags(ALL_FLAGS),
    {
      parse: () => Promise.resolve({}),
      identity: () => Promise.resolve(RESULTS.identity),
      balanceProjection: () => Promise.resolve({}),
    },
    () => {},
  );
  expect((await ticks()).map((row) => row.lane)).toEqual(["identity_sweep"]);
}, 60000);

test("retention prunes each lane beyond its bound in the same write, never another lane", async () => {
  const tick = (lane: string, at: number) =>
    laneTick(lane, at, at + 5, { outcome: "ran", result: RESULTS.settlements })!;
  for (let at = 1; at <= 5; at++)
    await recordLaneTick(env.DB, tick("card_settlement_sweep", at), 3);
  for (let at = 1; at <= 2; at++) await recordLaneTick(env.DB, tick("reconciliation_sweep", at), 3);
  const rows = await ticks();
  expect(
    rows.filter((row) => row.lane === "card_settlement_sweep").map((row) => row.started_at_ms),
  ).toEqual([3, 4, 5]);
  expect(
    rows.filter((row) => row.lane === "reconciliation_sweep").map((row) => row.started_at_ms),
  ).toEqual([1, 2]);
  // Ids only grow, so "newest" is never ambiguous after a prune.
  const ids = rows.map((row) => row.id);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  // The scheduled path uses the default bound.
  await env.DB.prepare("DELETE FROM processor_lane_ticks").run();
  for (let at = 1; at <= LANE_TICK_RETENTION + 2; at++)
    await recordLaneTick(env.DB, tick("purchase_recognition", at));
  const kept = (await ticks()).map((row) => row.started_at_ms);
  expect(kept).toHaveLength(LANE_TICK_RETENTION);
  expect(kept[0]).toBe(3);
  expect(kept.at(-1)).toBe(LANE_TICK_RETENTION + 2);
}, 120000);

test("a tick that cannot be recorded is logged as a code and stops no lane", async () => {
  const lines: Record<string, unknown>[] = [];
  const failing = {
    ...withFlags(ALL_FLAGS),
    DB: {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: () => Promise.reject(new RangeError("synthetic D1 outage")),
    },
  } as unknown as Env;
  await runScheduled(failing, stagesFor(), (line) => lines.push(JSON.parse(line)));
  expect(lines.filter((line) => line.event === "lane_tick_record_failed")).toEqual(
    RECORDED.map((lane) => ({ event: "lane_tick_record_failed", lane, code: "RangeError" })),
  );
  expect(lines.at(-2)).toMatchObject({ event: "decision_outbox" });
  expect(await ticks()).toEqual([]);
}, 60000);

test("/status reports the latest tick of every recorded lane", async () => {
  await runScheduled(withFlags(ALL_FLAGS), stagesFor(), () => {});
  await runScheduled(
    withFlags(ALL_FLAGS),
    stagesFor({ purchases: () => Promise.reject(new Error("synthetic")) }),
    () => {},
  );
  const status = (await (await mf.dispatchFetch("https://pipeline.internal/status")).json()) as {
    laneTicks: Record<string, unknown>[];
  };
  expect(status.laneTicks.map((tick) => tick["lane"])).toEqual([...RECORDED].sort());
  const purchase = status.laneTicks.find((tick) => tick["lane"] === "purchase_recognition")!;
  expect(purchase).toMatchObject({ outcome: "failed", errorCode: "Error", counts: {} });
  expect(Object.keys(purchase).sort()).toEqual([
    "ageMs",
    "counts",
    "durationMs",
    "errorCode",
    "lane",
    "outcome",
    "startedAt",
  ]);
  const settlement = status.laneTicks.find((tick) => tick["lane"] === "card_settlement_sweep")!;
  expect(settlement).toMatchObject({
    outcome: "ran",
    errorCode: null,
    counts: RESULTS.settlements,
  });
}, 60000);
