// Lane progress records after an interrupted sweep (docs/observation-lanes.md).
//
// Job creation and the progress row that records it are separate statements:
// a Worker killed between them leaves the jobs and the old cursor. The next
// sweep re-examines the same artifacts, its inserts are no-ops, and what the
// progress row says about the jobs must still be true.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { sweep } from "../src/worker.ts";
import { REPLAY_STEP_PROGRESS_SQL, WORK_ITEM_PROGRESS_SQL } from "../src/lane-progress-sql.ts";
import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";
import { fullCoreDatabase } from "../../../packages/storage-d1/test/sqlite.ts";
import { seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const PARSER = "smbc-direct-balance";
const VERSION = PARSERS.find((parser) => parser.name === PARSER)!.version;
const balance = { amount: 1, currency: "JPY", observedAt: "2026-09-07T00:00:00.000Z" };

async function post(path: string, body: unknown) {
  const response = await mf.dispatchFetch(`https://pipeline.internal${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
const workItem = (runId: number) =>
  env.DB.prepare(
    "SELECT id,outcome,jobs_created,cursor_artifact_id FROM observation_work_items WHERE fetch_run_id=?",
  )
    .bind(runId)
    .first<{
      id: number;
      outcome: string | null;
      jobs_created: number;
      cursor_artifact_id: number;
    }>();
const laneCursor = (lane: string) =>
  env.DB.prepare("SELECT cursor FROM observation_lane_state WHERE lane=?")
    .bind(lane)
    .first<number>("cursor");

test("a work item whose jobs were inserted before an interrupted sweep still records them", async () => {
  await seedArtifact(
    env,
    7000,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  // Park the repair cursor past the artifact so only the work item reaches it.
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=7000 WHERE id=1").run();
  // The interrupted sweep: its job insert committed, its progress update did not.
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lane,created_at_ms) VALUES(7000,?,?,'pending','incremental',?)",
  )
    .bind(PARSER, VERSION, Date.now())
    .run();
  expect(await workItem(7000)).toMatchObject({
    outcome: null,
    jobs_created: 0,
    cursor_artifact_id: 0,
  });

  const result = await sweep(env, { lane: "incremental" });
  // Nothing new was inserted on this sweep; the job is the item's all the same.
  expect(result.lanes.incremental).toMatchObject({ created: 0, workItems: 1, parsed: 1 });
  const item = await workItem(7000);
  expect(item).toMatchObject({
    outcome: "jobs_created",
    jobs_created: 1,
    cursor_artifact_id: 7000,
  });
  expect(await laneCursor("incremental")).toBe(item!.id);

  // A later sweep with no item left keeps the highest processed item.
  expect((await sweep(env, { lane: "incremental" })).lanes.incremental).toMatchObject({
    workItems: 0,
  });
  expect(await laneCursor("incremental")).toBe(item!.id);
}, 30000);

test("a run whose artifacts already had jobs from another lane is still no_new_jobs", async () => {
  await seedArtifact(
    env,
    7050,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lane,created_at_ms) VALUES(7050,?,?,'pending','repair',?)",
  )
    .bind(PARSER, VERSION, Date.now())
    .run();
  await sweep(env, { lane: "incremental", maxJobs: 1 });
  expect(await workItem(7050)).toMatchObject({ outcome: "no_new_jobs", jobs_created: 0 });
}, 30000);

test("a replay step whose jobs were inserted before an interrupted progress update still counts them once", async () => {
  for (const id of [7100, 7101, 7102])
    await seedArtifact(
      env,
      id,
      "smbc-bank",
      "balance-normalized",
      "balance.normalized.json",
      balance,
    );
  // Their work items were consumed elsewhere; only the plan creates jobs here.
  await env.DB.prepare(
    "UPDATE observation_work_items SET processed_at_ms=1,outcome='not_eligible' WHERE fetch_run_id IN (7100,7101,7102)",
  ).run();
  const planned = await post("/replay/plan", {
    source: "smbc-bank",
    dataset: "balance-normalized",
    parser: PARSER,
    version: VERSION,
    artifactIdFrom: 7099,
    reason: "synthetic interrupted step",
  });
  expect(planned.status).toBe(200);
  const plan = planned.json.plan as { id: number };
  const started = await post("/replay/start", { planId: plan.id });
  expect(started.json.plan).toMatchObject({ jobs_created: 3, creation_complete: 1 });
  // The interrupted step: its three jobs committed, its plan update did not.
  await env.DB.prepare(
    "UPDATE observation_replay_plans SET creation_cursor=0,creation_complete=0,jobs_created=0 WHERE id=?",
  )
    .bind(plan.id)
    .run();
  const repeated = await post("/replay/start", { planId: plan.id });
  expect(repeated.json.plan).toMatchObject({ jobs_created: 3, creation_complete: 1 });
  // A completed creation is never counted again.
  await sweep(env, { lane: "replay" });
  const inspected = await post("/replay/inspect", { planId: plan.id });
  expect(inspected.json.plan).toMatchObject({ status: "completed", jobs_created: 3 });
}, 30000);

test("both progress counts read jobs by key from the examined ids, without table statistics", () => {
  const db = fullCoreDatabase();
  try {
    for (const sql of [WORK_ITEM_PROGRESS_SQL, REPLAY_STEP_PROGRESS_SQL]) {
      const plan = db
        .prepare<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail);
      // The job lookup is a key search per examined id, never a lane or table scan.
      expect(plan).toContain(
        "SEARCH j USING INDEX sqlite_autoindex_observation_parse_jobs_1 (fetch_artifact_id=?)",
      );
      expect(
        plan.filter((detail) => /^SCAN /u.test(detail) && !/^SCAN (e|page)\b/u.test(detail)),
      ).toEqual([]);
      expect(plan.indexOf("SCAN e VIRTUAL TABLE INDEX 1:")).toBeLessThan(
        plan.findIndex((detail) => detail.startsWith("SEARCH j ")),
      );
    }
  } finally {
    db.close();
  }
}, 60000);

test("a progress update fenced on a cursor another sweep or step already moved changes nothing", async () => {
  for (const id of [7200, 7300, 7301])
    await seedArtifact(
      env,
      id,
      "smbc-bank",
      "balance-normalized",
      "balance.normalized.json",
      balance,
    );
  const now = Date.now();
  // Work item: two sweeps read cursor 0 and examined the same page.
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lane,created_at_ms) VALUES(7200,?,?,'pending','incremental',?)",
  )
    .bind(PARSER, VERSION, now)
    .run();
  const { id: itemId } = (await workItem(7200))!;
  const itemStep = (from: number, to: number, examined: number[], complete: boolean) =>
    env.DB.prepare(WORK_ITEM_PROGRESS_SQL)
      .bind(itemId, from, to, JSON.stringify(examined), complete ? 1 : 0, now)
      .run();
  expect((await itemStep(0, 7200, [7200], false)).meta.changes).toBe(1);
  expect((await itemStep(0, 7200, [7200], false)).meta.changes).toBe(0);
  expect(await workItem(7200)).toMatchObject({ outcome: null, jobs_created: 1 });
  // The last, empty page completes the item without counting anything again.
  expect((await itemStep(7200, 7200, [], true)).meta.changes).toBe(1);
  expect(await workItem(7200)).toMatchObject({ outcome: "jobs_created", jobs_created: 1 });

  // Replay plan: two steps read creation cursor 0 and the same range.
  const plan = await env.DB.prepare(
    `INSERT INTO observation_replay_plans(created_at_ms,updated_at_ms,source_id,parser_name,parser_version,artifact_id_from,artifact_id_high_water,status,reason)
     VALUES(?1,?1,'smbc-bank',?2,?3,7299,7301,'running','synthetic fence') RETURNING id`,
  )
    .bind(now, PARSER, VERSION)
    .first<number>("id");
  for (const id of [7300, 7301])
    await env.DB.prepare(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lane,created_at_ms,replay_plan_id) VALUES(?,?,?,'pending','replay',?,?)",
    )
      .bind(id, PARSER, VERSION, now, plan)
      .run();
  const planStep = (from: number, to: number, examined: number[], complete: boolean) =>
    env.DB.prepare(REPLAY_STEP_PROGRESS_SQL)
      .bind(to, complete ? 1 : 0, now, JSON.stringify(examined), plan, from)
      .run();
  const jobsCreated = () =>
    env.DB.prepare("SELECT jobs_created FROM observation_replay_plans WHERE id=?")
      .bind(plan)
      .first<number>("jobs_created");
  expect((await planStep(0, 7300, [7300], false)).meta.changes).toBe(1);
  expect((await planStep(0, 7300, [7300], false)).meta.changes).toBe(0);
  expect(await jobsCreated()).toBe(1);
  expect((await planStep(7300, 7301, [7301], true)).meta.changes).toBe(1);
  expect(await jobsCreated()).toBe(2);
}, 30000);
