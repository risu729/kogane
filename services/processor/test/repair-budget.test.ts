// The repair lane's per-tick budget (docs/observation-lanes.md, "Repair
// budget and drain rate"): the constants, the arithmetic their comments
// state, and a scheduled tick that holds more repair work than one budget.
// Synthetic data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { runScheduled, sweep } from "../src/worker.ts";
import {
  IDENTITY_RUNS_PER_TICK,
  LANE_BUDGETS,
  MAX_LANE_JOBS,
  REPAIR_JOBS_PER_SWEEP,
} from "../src/lane-budgets.ts";
import { identitySweep } from "../src/identity-store.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const TICKS_PER_HOUR = 12; // the cron in wrangler.jsonc, pinned below
// identitySweep's own bound on runs per call, held against the function below.
const IDENTITY_SWEEP_MAX_RUNS = 40;
// vpass-statement-page 1.2.0: artifacts still published at 1.1.0 (2026-09-24).
const BACKLOG = 3133;

/** The JSDoc block right above `export const <name> =`, as one line of text. */
function commentAbove(source: string, name: string): string {
  const end = source.indexOf(`*/\nexport const ${name} =`);
  expect(end).toBeGreaterThan(0);
  const start = source.lastIndexOf("/**", end);
  return source
    .slice(start + 3, end)
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/u, "").trim())
    .filter(Boolean)
    .join(" ");
}

test("the repair budget, the identity budget that keeps pace with it and the hard bound are pinned", () => {
  expect(REPAIR_JOBS_PER_SWEEP).toBe(28);
  expect(LANE_BUDGETS).toEqual({ incremental: 12, repair: REPAIR_JOBS_PER_SWEEP, replay: 8 });
  // Every run the two unattended lanes publish in one tick is identified on it.
  expect(IDENTITY_RUNS_PER_TICK).toBe(LANE_BUDGETS.incremental + LANE_BUDGETS.repair);
  expect(IDENTITY_RUNS_PER_TICK).toBe(40);
  expect(MAX_LANE_JOBS).toBe(40);
  for (const budget of Object.values(LANE_BUDGETS))
    expect(budget).toBeLessThanOrEqual(MAX_LANE_JOBS);
  // The sum is what the identity stage has to cover, and identitySweep
  // refuses more than 40 runs a call (checked against the function below):
  // a larger sum would fail the identity stage on every tick.
  expect(LANE_BUDGETS.incremental + LANE_BUDGETS.repair).toBeLessThanOrEqual(IDENTITY_SWEEP_MAX_RUNS);
  // The drain rate counts ticks of the deployed cron.
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const minutes = /"crons": \["\*\/(\d+) \* \* \* \*"\]/u.exec(wrangler)?.[1];
  expect(60 / Number(minutes)).toBe(TICKS_PER_HOUR);
});

test("the comments above the budgets state the arithmetic of the constants", () => {
  const source = readFileSync(new URL("../src/lane-budgets.ts", import.meta.url), "utf8");
  const repair = commentAbove(source, "REPAIR_JOBS_PER_SWEEP");
  const perHour = REPAIR_JOBS_PER_SWEEP * TICKS_PER_HOUR;
  expect(repair).toContain(
    `${REPAIR_JOBS_PER_SWEEP} jobs x ${TICKS_PER_HOUR} ticks/hour = ${perHour} artifacts/hour`,
  );
  expect(repair).toContain(`3,133 / ${perHour} = ${(BACKLOG / perHour).toFixed(1)} hours`);
  expect(repair).toContain(
    `3,133 / (4 x ${TICKS_PER_HOUR} ticks/hour) = ${Math.round(BACKLOG / (4 * TICKS_PER_HOUR))} hours`,
  );
  const sum = `incremental ${LANE_BUDGETS.incremental} + repair ${REPAIR_JOBS_PER_SWEEP} = ${IDENTITY_RUNS_PER_TICK}`;
  expect(repair).toContain(sum);
  expect(commentAbove(source, "IDENTITY_RUNS_PER_TICK")).toContain(sum);
});

test("a tick with more repair work than the budget executes exactly the budget, and the rest on the next tick", async () => {
  const extra = 3;
  const total = REPAIR_JOBS_PER_SWEEP + extra;
  const balance = { amount: 987654, currency: "JPY", observedAt: "2026-09-07T00:00:00.000Z" };
  for (let id = 100; id < 100 + total; id++)
    await seedArtifact(
      env,
      id,
      "smbc-bank",
      "balance-normalized",
      "balance.normalized.json",
      balance,
    );
  // Sealed before the outbox existed, like the history a new parser version
  // re-parses: only the repair lane's scan finds these artifacts.
  await env.DB.prepare("DELETE FROM observation_work_items").run();
  const lines: Record<string, any>[] = [];
  const log = (line: string) => lines.push(JSON.parse(line));
  const event = (name: string) => lines.find((line) => line.event === name);

  await runScheduled(env, undefined, log);
  expect(event("observation_sweep")?.lanes.repair).toMatchObject({
    created: total,
    budget: REPAIR_JOBS_PER_SWEEP,
    executed: REPAIR_JOBS_PER_SWEEP,
    parsed: REPAIR_JOBS_PER_SWEEP,
    error: 0,
    pending: extra,
  });
  // The identity sweep later in the same tick takes every run the repair lane
  // just published; at its former default of 8 it would have taken 8.
  expect(event("identity_sweep")).toMatchObject({
    processedRuns: REPAIR_JOBS_PER_SWEEP,
    identifiedRuns: REPAIR_JOBS_PER_SWEEP,
  });
  // The log carries counts, never a value.
  expect(JSON.stringify(lines)).not.toContain("987654");

  lines.length = 0;
  await runScheduled(env, undefined, log);
  expect(event("observation_sweep")?.lanes.repair).toMatchObject({
    created: 0,
    executed: extra,
    pending: 0,
  });
  expect(event("identity_sweep")).toMatchObject({ processedRuns: extra, identifiedRuns: extra });
  expect(JSON.stringify(lines)).not.toContain("987654");
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM observation_parse_jobs WHERE lane='repair' AND status='done'",
    ).first<number>("n"),
  ).toBe(total);
}, 120000);

test("the hard bound holds for an operator override and for the identity sweep", async () => {
  expect((await sweep(env, { lane: "repair", maxJobs: 1000 })).lanes.repair).toMatchObject({
    budget: MAX_LANE_JOBS,
    executed: 0,
    pending: 0,
  });
  // IDENTITY_RUNS_PER_TICK is accepted and one more is refused: it is exactly
  // identitySweep's maximum. Everything above is identified, so nothing is left.
  expect(await identitySweep(env.DB, resolveIdentity, IDENTITY_RUNS_PER_TICK)).toEqual({
    processedRuns: 0,
    identifiedRuns: 0,
    identifiedObservations: 0,
  });
  await expect(identitySweep(env.DB, resolveIdentity, IDENTITY_SWEEP_MAX_RUNS + 1)).rejects.toThrow(
    "identity_batch_invalid",
  );
}, 30000);
