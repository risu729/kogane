// The Processor's daily read budget (ADR 0129, migration 0106): invocations add
// their rows read to an hourly row, and above the budget the scheduled tick
// logs one error per hour and runs the derived lanes on the hour's first tick
// only, while collection, parsing and dispatch keep running.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  D1_ROWS_READ_DAILY_BUDGET,
  READ_BUDGET_THROTTLED_LANES,
  hourStart,
  readBudgetState,
  recordRowsRead,
} from "../src/read-budget.ts";
import { meteredInvocation, runScheduled, type ScheduledStages } from "../src/worker.ts";
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
  await env.DB.prepare("DELETE FROM processor_read_budget_hours").run();
});

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-23T10:20:00.000Z");

async function hours(): Promise<{ hour_start_ms: number; rows_read: number; ticks: number }[]> {
  const rows = await env.DB.prepare(
    `SELECT hour_start_ms,rows_read,scheduled_ticks+queue_invocations AS ticks
     FROM processor_read_budget_hours ORDER BY hour_start_ms`,
  ).all<{ hour_start_ms: number; rows_read: number; ticks: number }>();
  return rows.results;
}

test("invocations add to the hour they started in, and rows past 48 hours are dropped", async () => {
  await recordRowsRead(env.DB, NOW - 49 * HOUR, 7, "scheduled");
  await recordRowsRead(env.DB, NOW - 2 * HOUR, 5, "queue");
  await recordRowsRead(env.DB, NOW, 100, "scheduled");
  await recordRowsRead(env.DB, NOW + 30 * 60_000, 50, "queue");
  expect(await hours()).toEqual([
    { hour_start_ms: hourStart(NOW) - 2 * HOUR, rows_read: 5, ticks: 1 },
    { hour_start_ms: hourStart(NOW), rows_read: 150, ticks: 2 },
  ]);
});

test("the budget sums the current hour and the 23 before it", async () => {
  await recordRowsRead(env.DB, NOW - 24 * HOUR, 1_000, "scheduled");
  await recordRowsRead(env.DB, NOW - 23 * HOUR, 10, "scheduled");
  await recordRowsRead(env.DB, NOW, 20, "queue");
  expect(await readBudgetState(env.DB, NOW, 100)).toEqual({
    rowsRead24h: 30,
    over: false,
    throttled: false,
  });
  // Over the budget, but no scheduled tick ran this hour: the queue batch does not count.
  expect(await readBudgetState(env.DB, NOW, 25)).toEqual({
    rowsRead24h: 30,
    over: true,
    throttled: false,
  });
  await recordRowsRead(env.DB, NOW, 0, "scheduled");
  expect(await readBudgetState(env.DB, NOW, 25)).toMatchObject({ over: true, throttled: true });
  // An hour later the oldest hour has left the window; the first tick of the
  // new hour runs everything again.
  expect(await readBudgetState(env.DB, NOW + HOUR, 15)).toEqual({
    rowsRead24h: 20,
    over: true,
    throttled: false,
  });
});

test("the budget is a third of the included monthly reads", () => {
  expect(D1_ROWS_READ_DAILY_BUDGET).toBe(300_000_000);
});

/** Every stage, recording which ran; none reads or writes anything. */
function stagesThatRecord(ran: string[]): ScheduledStages {
  const stage = (name: string) => () => {
    ran.push(name);
    return Promise.resolve({});
  };
  return {
    parse: stage("observation_sweep"),
    collection: stage("collection_scan"),
    identity: stage("identity_sweep"),
    instrumentAutoAdoption: stage("instrument_auto_adoption"),
    balanceProjection: stage("balance_projection"),
    prices: stage("price_promotion"),
    operations: stage("operation_dispatch"),
    decisions: stage("decision_outbox"),
    auditOverflow: stage("audit_overflow"),
  };
}

test("over the budget, the hour's first tick runs every lane and logs the error once; later ticks skip the derived lanes", async () => {
  await recordRowsRead(env.DB, NOW - 3 * HOUR, 400, "scheduled");
  const guard = (alerts: string[]) => ({
    now: () => NOW,
    budget: 300,
    alert: (line: string) => alerts.push(line),
  });

  const firstRan: string[] = [];
  const firstAlerts: string[] = [];
  await meteredInvocation(
    "scheduled",
    env,
    (metered, context) =>
      runScheduled(metered, stagesThatRecord(firstRan), () => {}, context, guard(firstAlerts)),
    () => {},
    () => NOW,
  );
  expect(firstRan).toContain("balance_projection");
  expect(firstRan).toContain("identity_sweep");
  expect(firstAlerts.map((line) => JSON.parse(line))).toEqual([
    { event: "d1_read_budget_exceeded", rowsRead24h: 400, budget: 300 },
  ]);

  // meteredInvocation recorded that tick in the hour it started.
  const laterRan: string[] = [];
  const laterAlerts: string[] = [];
  const lines: Record<string, unknown>[] = [];
  await meteredInvocation(
    "scheduled",
    env,
    (metered, context) =>
      runScheduled(
        metered,
        stagesThatRecord(laterRan),
        (line) => lines.push(JSON.parse(line)),
        context,
        guard(laterAlerts),
      ),
    () => {},
    () => NOW + 60_000,
  );
  expect(laterRan).toEqual([
    "observation_sweep",
    "collection_scan",
    "operation_dispatch",
    "audit_overflow",
  ]);
  expect(laterAlerts).toEqual([]);
  expect(
    lines.filter((line) => line["skipped"] === "read_budget").map((line) => line["event"]),
  ).toEqual([
    "identity_sweep",
    "instrument_auto_adoption",
    "balance_projection",
    "price_promotion",
    "decision_outbox",
  ]);
  for (const lane of laterRan) expect(READ_BUDGET_THROTTLED_LANES.has(lane)).toBe(false);
});

test("under the budget every lane runs on every tick", async () => {
  const ran: string[] = [];
  const alerts: string[] = [];
  for (let tick = 0; tick < 2; tick += 1)
    await meteredInvocation(
      "scheduled",
      env,
      (metered, context) =>
        runScheduled(metered, stagesThatRecord(ran), () => {}, context, {
          now: () => NOW,
          alert: (line) => alerts.push(line),
        }),
      () => {},
      () => NOW,
    );
  expect(ran.filter((lane) => lane === "balance_projection")).toHaveLength(2);
  expect(alerts).toEqual([]);
  // Both ticks were recorded; real D1 reports rows read for their statements.
  expect((await hours()).map((row) => row.ticks)).toEqual([2]);
});

test("without its table the budget throttles nothing and the invocation still succeeds", async () => {
  await env.DB.prepare(
    "ALTER TABLE processor_read_budget_hours RENAME TO processor_read_budget_hours_away",
  ).run();
  try {
    expect(await readBudgetState(env.DB, NOW, 0)).toBeNull();
    const ran: string[] = [];
    const lines: string[] = [];
    await meteredInvocation(
      "scheduled",
      env,
      (metered, context) =>
        runScheduled(metered, stagesThatRecord(ran), () => {}, context, {
          now: () => NOW,
          budget: 0,
          alert: () => ran.push("alert"),
        }),
      (line) => lines.push(line),
      () => NOW,
    );
    expect(ran).toContain("balance_projection");
    expect(ran).not.toContain("alert");
    // The failed record does not displace the probe as the invocation's last line.
    expect((JSON.parse(lines.at(-1)!) as { event: string }).event).toBe("invocation_budget");
  } finally {
    await env.DB.prepare(
      "ALTER TABLE processor_read_budget_hours_away RENAME TO processor_read_budget_hours",
    ).run();
  }
});
