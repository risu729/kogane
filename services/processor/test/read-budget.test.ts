// The Processor's daily read budget (ADR 0129, migration 0107): invocations add
// their rows read to an hourly row, and above the budget the scheduled tick
// logs one error per hour and runs the derived lanes on the hour's first tick
// only, while collection, parsing and dispatch keep running.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  D1_ROWS_READ_DAILY_BUDGET,
  READ_BUDGET_THROTTLED_LANES,
  claimScheduledTick,
  hourStart,
  readBudgetState,
  recordRowsRead,
} from "../src/read-budget.ts";
import { IDENTITY_RUNS_PER_TICK } from "../src/lane-budgets.ts";
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
  // A scheduled tick counts itself when it starts (claimScheduledTick), not here.
  expect(await hours()).toEqual([
    { hour_start_ms: hourStart(NOW) - 2 * HOUR, rows_read: 5, ticks: 1 },
    { hour_start_ms: hourStart(NOW), rows_read: 150, ticks: 1 },
  ]);
});

test("a scheduled tick's claim answers how many ticks its hour has counted", async () => {
  expect(await claimScheduledTick(env.DB, NOW)).toBe(1);
  expect(await claimScheduledTick(env.DB, NOW + 60_000)).toBe(2);
  expect(await claimScheduledTick(env.DB, NOW + HOUR)).toBe(1);
  await recordRowsRead(env.DB, NOW, 100, "scheduled");
  expect(await hours()).toEqual([
    { hour_start_ms: hourStart(NOW), rows_read: 100, ticks: 2 },
    { hour_start_ms: hourStart(NOW) + HOUR, rows_read: 0, ticks: 1 },
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
  await claimScheduledTick(env.DB, NOW);
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

/** `env` whose CORE binding fails every statement once `broken.now` is set, as an overloaded D1 does. */
function breakable(broken: { now: boolean; sql?: RegExp }): Env {
  const db = new Proxy(env.DB, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "prepare")
        return (sql: string) => {
          if (broken.now && (!broken.sql || broken.sql.test(sql)))
            throw new Error("D1_ERROR: overloaded");
          return target.prepare(sql);
        };
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          if (broken.now && !broken.sql) throw new Error("D1_ERROR: overloaded");
          return target.batch(statements);
        };
      return typeof value === "function" ? (value as Function).bind(target) : value;
    },
  });
  return { ...env, DB: db } as Env;
}

test("over the budget, a first tick whose lanes leave D1 failing still claims the hour", async () => {
  await recordRowsRead(env.DB, NOW - 3 * HOUR, 400, "scheduled");
  const broken = { now: false };
  const failing = breakable(broken);
  const stages = stagesThatRecord([]);
  // The identity sweep leaves every later statement of the tick failing,
  // including the rows-read record at its end.
  stages.identity = () => {
    broken.now = true;
    return Promise.reject(new Error("D1_ERROR: overloaded"));
  };
  const firstLines: string[] = [];
  const firstAlerts: string[] = [];
  await meteredInvocation(
    "scheduled",
    failing,
    (metered, context) =>
      runScheduled(metered, stages, () => {}, context, {
        now: () => NOW,
        budget: 300,
        alert: (line) => firstAlerts.push(line),
      }),
    (line) => firstLines.push(line),
    () => NOW,
  );
  expect(broken.now).toBe(true);
  expect(firstAlerts.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual([
    "d1_read_budget_exceeded",
  ]);
  expect(firstLines.map((line) => (JSON.parse(line) as { event: string }).event)).toContain(
    "invocation_budget",
  );
  broken.now = false;

  const laterRan: string[] = [];
  await meteredInvocation(
    "scheduled",
    env,
    (metered, context) =>
      runScheduled(metered, stagesThatRecord(laterRan), () => {}, context, {
        now: () => NOW + 5 * 60_000,
        budget: 300,
        alert: () => {},
      }),
    () => {},
    () => NOW + 5 * 60_000,
  );
  expect(laterRan).not.toContain("identity_sweep");
  expect(laterRan).not.toContain("balance_projection");
  expect(laterRan).toContain("observation_sweep");
});

test("over the budget, a tick that cannot count itself skips the derived lanes", async () => {
  await recordRowsRead(env.DB, NOW - 3 * HOUR, 400, "scheduled");
  const failing = breakable({ now: true, sql: /RETURNING scheduled_ticks/u });
  const ran: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const alerts: string[] = [];
  await runScheduled(
    failing,
    stagesThatRecord(ran),
    (line) => lines.push(JSON.parse(line)),
    undefined,
    { now: () => NOW, budget: 300, alert: (line) => alerts.push(line) },
  );
  expect(ran).toEqual([
    "observation_sweep",
    "collection_scan",
    "operation_dispatch",
    "audit_overflow",
  ]);
  // The failed count is the error line; the budget line waits for a counted first tick.
  expect(alerts.map((line) => JSON.parse(line))).toEqual([
    { event: "read_budget_claim_failed", over: true },
  ]);
});

test("under the budget, a tick that cannot count itself still runs every lane", async () => {
  const failing = breakable({ now: true, sql: /RETURNING scheduled_ticks/u });
  const ran: string[] = [];
  const alerts: string[] = [];
  await runScheduled(failing, stagesThatRecord(ran), () => {}, undefined, {
    now: () => NOW,
    alert: (line) => alerts.push(line),
  });
  expect(ran).toContain("balance_projection");
  expect(alerts.map((line) => JSON.parse(line))).toEqual([
    { event: "read_budget_claim_failed", over: false },
  ]);
});

test("a tick whose budget read fails runs every lane and still counts itself", async () => {
  await recordRowsRead(env.DB, NOW - 3 * HOUR, 400, "scheduled");
  const failing = breakable({ now: true, sql: /SELECT coalesce\(sum\(rows_read\)/u });
  const ran: string[] = [];
  await runScheduled(failing, stagesThatRecord(ran), () => {}, undefined, {
    now: () => NOW,
    budget: 300,
    alert: () => ran.push("alert"),
  });
  expect(ran).toContain("balance_projection");
  expect(ran).not.toContain("alert");
  // The next tick of the hour reads the budget and sees this one.
  expect(await readBudgetState(env.DB, NOW + 5 * 60_000, 300)).toMatchObject({
    over: true,
    throttled: true,
  });
});

test("over the budget, of two ticks that overlap at the start of an hour only one runs the derived lanes", async () => {
  await recordRowsRead(env.DB, NOW - 3 * HOUR, 400, "scheduled");
  const ran: string[] = [];
  const alerts: string[] = [];
  // Both read the budget before either counts itself.
  let claims = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => (release = resolve));
  const gated: Env = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("RETURNING scheduled_ticks")) return statement;
            return new Proxy(statement, {
              get(inner, key) {
                const value = Reflect.get(inner, key, inner) as unknown;
                if (key === "bind")
                  return (...values: unknown[]) => {
                    const bound = inner.bind(...values);
                    return {
                      all: async () => {
                        claims += 1;
                        if (claims === 2) release();
                        await bothRead;
                        return bound.all();
                      },
                    };
                  };
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database,
  } as Env;
  await Promise.all(
    [0, 1].map(() =>
      runScheduled(gated, stagesThatRecord(ran), () => {}, undefined, {
        now: () => NOW,
        budget: 300,
        alert: (line) => alerts.push(line),
      }),
    ),
  );
  expect(claims).toBe(2);
  expect(ran.filter((lane) => lane === "identity_sweep")).toHaveLength(1);
  expect(alerts.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual([
    "d1_read_budget_exceeded",
  ]);
});

test("over the budget, an identity sweep that took a full page keeps running on every tick until it takes less", async () => {
  await env.DB.prepare("DELETE FROM processor_lane_ticks WHERE lane='identity_sweep'").run();
  await recordRowsRead(env.DB, NOW - 3 * HOUR, 400, "scheduled");
  const page = {
    processedRuns: IDENTITY_RUNS_PER_TICK,
    identifiedRuns: 1,
    identifiedObservations: 0,
  };
  const tick = async (at: number, identity: typeof page) => {
    const ran: string[] = [];
    const stages = stagesThatRecord(ran);
    stages.identity = () => {
      ran.push("identity_sweep");
      return Promise.resolve(identity);
    };
    await meteredInvocation(
      "scheduled",
      env,
      (metered, context) =>
        runScheduled(metered, stages, () => {}, context, {
          now: () => at,
          budget: 300,
          alert: () => {},
        }),
      () => {},
      () => at,
    );
    return ran;
  };
  // The hour's first tick runs every lane; its sweep takes a full page.
  expect(await tick(NOW, page)).toContain("balance_projection");
  // A later tick of the hour still runs the identity sweep, and only it.
  const draining = await tick(NOW + 5 * 60_000, { ...page, processedRuns: 3 });
  expect(draining).toContain("identity_sweep");
  expect(draining).not.toContain("balance_projection");
  expect(draining).not.toContain("instrument_auto_adoption");
  // That sweep took less than a page, so the next tick skips it again.
  expect(await tick(NOW + 10 * 60_000, page)).not.toContain("identity_sweep");
  // The 200-observation cap counts as a full page too.
  await env.DB.prepare("DELETE FROM processor_lane_ticks WHERE lane='identity_sweep'").run();
  expect(
    await tick(NOW + HOUR, { ...page, processedRuns: 5, identifiedObservations: 200 }),
  ).toContain("balance_projection");
  expect(await tick(NOW + HOUR + 5 * 60_000, page)).toContain("identity_sweep");
  // A cap page inside one large parse seals nothing but made progress: it drains.
  await env.DB.prepare("DELETE FROM processor_lane_ticks WHERE lane='identity_sweep'").run();
  const capPage = { processedRuns: 1, identifiedRuns: 0, identifiedObservations: 200 };
  expect(await tick(NOW + 5 * HOUR, capPage)).toContain("balance_projection");
  expect(await tick(NOW + 5 * HOUR + 5 * 60_000, page)).toContain("identity_sweep");
  // A full page that identified nothing stops it: runs selected again on every
  // tick but never sealed would otherwise keep a full page for ever.
  await env.DB.prepare("DELETE FROM processor_lane_ticks WHERE lane='identity_sweep'").run();
  expect(
    await tick(NOW + 3 * HOUR, { ...page, identifiedRuns: 0, identifiedObservations: 0 }),
  ).toContain("balance_projection");
  expect(await tick(NOW + 3 * HOUR + 5 * 60_000, page)).not.toContain("identity_sweep");
  // A full page whose record is older than the draining cadence stops it: a
  // sweep whose own record was lost must not run every tick on a stale row.
  // Tick records carry the wall clock, so the stale one is written directly.
  const fullPage = async (startedAtMs: number) => {
    await env.DB.prepare("DELETE FROM processor_lane_ticks WHERE lane='identity_sweep'").run();
    await env.DB.prepare(
      `INSERT INTO processor_lane_ticks(lane,started_at_ms,finished_at_ms,outcome,counts_json)
       VALUES('identity_sweep',?1,?1,'ran',?2)`,
    )
      .bind(startedAtMs, JSON.stringify(page))
      .run();
  };
  expect(await tick(NOW + 4 * HOUR, page)).toContain("balance_projection");
  await fullPage(Date.now() - 20 * 60_000);
  expect(await tick(NOW + 4 * HOUR + 5 * 60_000, page)).not.toContain("identity_sweep");
  await fullPage(Date.now() - 5 * 60_000);
  expect(await tick(NOW + 4 * HOUR + 10 * 60_000, page)).toContain("identity_sweep");
  // A failed sweep stops the exemption: one that keeps failing runs once an hour.
  await env.DB.prepare("DELETE FROM processor_lane_ticks WHERE lane='identity_sweep'").run();
  expect(await tick(NOW + 2 * HOUR, page)).toContain("balance_projection");
  const failing: string[] = [];
  const stages = stagesThatRecord(failing);
  stages.identity = () => Promise.reject(new Error("D1_ERROR: overloaded"));
  await runScheduled(env, stages, () => {}, undefined, {
    now: () => NOW + 2 * HOUR + 5 * 60_000,
    budget: 300,
    alert: () => {},
  });
  expect(await tick(NOW + 2 * HOUR + 10 * 60_000, page)).not.toContain("identity_sweep");
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
    const alerts: string[] = [];
    await meteredInvocation(
      "scheduled",
      env,
      (metered, context) =>
        runScheduled(metered, stagesThatRecord(ran), () => {}, context, {
          now: () => NOW,
          budget: 0,
          alert: (line) => alerts.push(line),
        }),
      (line) => lines.push(line),
      () => NOW,
    );
    expect(ran).toContain("balance_projection");
    // No budget line; the tick's failed count is reported as an error.
    expect(alerts.map((line) => JSON.parse(line))).toEqual([
      { event: "read_budget_claim_failed", over: null },
    ]);
    // The failed record does not displace the probe as the invocation's last line.
    expect((JSON.parse(lines.at(-1)!) as { event: string }).event).toBe("invocation_budget");
  } finally {
    await env.DB.prepare(
      "ALTER TABLE processor_read_budget_hours_away RENAME TO processor_read_budget_hours",
    ).run();
  }
});
