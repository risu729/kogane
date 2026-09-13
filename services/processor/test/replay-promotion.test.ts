import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { seedArtifact, startPipeline } from "./harness.ts";
let mf: Miniflare, env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline(undefined, { RELEASE_CANDIDATES_ENABLED: "true" }));
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});
async function post(action: string, input: Record<string, unknown>) {
  const response = await mf.dispatchFetch(`https://pipeline.internal/replay/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    plan: { id: number; status: string; jobs_created: number };
    jobs: { pending: number; running: number; done: number; failed: number };
    scopeJobs: {
      lane: string;
      status: string;
      attached: number;
      same_target: number;
      attempted: number;
      jobs: number;
    }[];
  };
}
async function seed(id: number) {
  await seedArtifact(env, id, "smbc-bank", "balance-normalized", "balance.normalized.json", {
    amount: 1234,
    currency: "JPY",
    observedAt: "2026-09-13T00:00:00.000Z",
  });
}
async function job(id: number) {
  return await env.DB.prepare("SELECT * FROM observation_parse_jobs WHERE fetch_artifact_id=?")
    .bind(id)
    .first<Record<string, unknown>>();
}
test("explicit replay attaches only untouched same-target repair work and cancellation preserves facts", async () => {
  for (let id = 101; id <= 109; id++) await seed(id);
  const cases = [
    [101, "repair", "pending", 0, null, 0, null, null],
    [102, "repair", "failed", 5, null, 0, null, null],
    [103, "repair", "running", 1, "held-lease", Date.now() + 600_000, null, null],
    [104, "repair", "pending", 1, null, 0, null, null],
    [105, "incremental", "pending", 0, null, 0, null, null],
    [106, "repair", "pending", 0, null, 0, "other-release", null],
    [107, "replay", "pending", 0, null, 0, null, 999],
    [108, "repair", "pending", 0, null, 0, null, null],
  ];
  for (const [
    id,
    lane,
    status,
    attempts,
    leaseToken,
    leaseUntil,
    targetRelease,
    replayPlanId,
  ] of cases) {
    await env.DB.prepare(`INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,
      lane,status,attempts,lease_token,lease_until_ms,target_release,replay_plan_id,available_at_ms,priority,created_at_ms)
      VALUES(?,'smbc-direct-balance','1.0.0',?,?,?,?,?,?,?,7777777777777,7,123)`)
      .bind(id, lane, status, attempts, leaseToken, leaseUntil, targetRelease, replayPlanId)
      .run();
  }
  await env.DB.prepare(`INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES(108,'smbc-direct-balance','1.0.0','2026-09-13','ok','[]')`).run();
  const originals = await Promise.all(cases.map(([id]) => job(id as number)));
  const facts = async () => ({
    raw: (await env.DB.prepare("SELECT * FROM fetch_artifacts ORDER BY id").all()).results,
    parses: (await env.DB.prepare("SELECT * FROM parse_runs ORDER BY id").all()).results,
  });
  const beforeFacts = await facts();
  const plan = await post("plan", {
    source: "smbc-bank",
    dataset: "balance-normalized",
    parser: "smbc-direct-balance",
    version: "1.0.0",
    reason: "synthetic bounded priority review",
    artifactIdFrom: 100,
  });
  const started = await post("start", { planId: plan.plan.id });
  expect(started.plan.jobs_created).toBe(2);
  expect(await job(101)).toEqual({ ...originals[0], lane: "replay", replay_plan_id: plan.plan.id });
  expect(await job(109)).toMatchObject({
    lane: "replay",
    status: "pending",
    replay_plan_id: plan.plan.id,
    target_release: null,
  });
  for (let i = 1; i < cases.length; i++)
    expect(await job(cases[i]![0] as number)).toEqual(originals[i]!);
  const inspected = await post("inspect", { planId: plan.plan.id });
  expect(inspected.jobs.pending).toBe(2);
  expect(inspected.scopeJobs).toContainEqual({
    lane: "repair",
    status: "failed",
    attached: 0,
    same_target: 1,
    attempted: 1,
    jobs: 1,
  });
  expect(inspected.scopeJobs).toContainEqual({
    lane: "repair",
    status: "pending",
    attached: 0,
    same_target: 0,
    attempted: 0,
    jobs: 1,
  });
  expect((await post("start", { planId: plan.plan.id })).plan.jobs_created).toBe(2);
  await post("cancel", { planId: plan.plan.id });
  expect(await job(101)).toMatchObject({
    lane: "replay",
    status: "failed",
    last_error_code: "replay_cancelled",
    attempts: 0,
  });
  for (let i = 1; i < cases.length; i++)
    expect(await job(cases[i]![0] as number)).toEqual(originals[i]!);
  expect(await facts()).toEqual(beforeFacts);
}, 60_000);

test("a candidate replay never retargets untouched normal repair work", async () => {
  await seed(201);
  await env.DB.prepare(`INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,lane,status)
    VALUES(201,'smbc-direct-balance','1.0.0','repair','pending')`).run();
  const before = await job(201);
  const plan = await post("plan", {
    source: "smbc-bank",
    dataset: "balance-normalized",
    parser: "smbc-direct-balance",
    version: "1.0.0",
    reason: "candidate target isolation",
    artifactIdFrom: 200,
    targetRelease: "registered-candidate-placeholder",
  });
  const started = await post("start", { planId: plan.plan.id });
  expect(started.plan.jobs_created).toBe(0);
  expect(await job(201)).toEqual(before);
  expect(started.scopeJobs).toContainEqual({
    lane: "repair",
    status: "pending",
    attached: 0,
    same_target: 0,
    attempted: 0,
    jobs: 1,
  });
}, 60_000);

test("normal replay publishes attached repair work even with candidate mode enabled", async () => {
  await seed(301);
  await env.DB.prepare(`INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,lane,status)
    VALUES(301,'smbc-direct-balance','1.0.0','repair','pending')`).run();
  const plan = await post("plan", {
    source: "smbc-bank",
    dataset: "balance-normalized",
    parser: "smbc-direct-balance",
    version: "1.0.0",
    reason: "ordinary deployed parser backfill",
    artifactIdFrom: 300,
  });
  expect((await post("start", { planId: plan.plan.id })).plan.jobs_created).toBe(1);
  const response = await mf.dispatchFetch("https://pipeline.internal/sweep?lane=replay&maxJobs=1", {
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ parsed: 1, error: 0 });
  expect(await job(301)).toMatchObject({
    status: "done",
    attempts: 1,
    target_release: null,
    replay_plan_id: plan.plan.id,
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM published_parse_runs WHERE fetch_artifact_id=301 AND parser_name='smbc-direct-balance'",
    ).first<{ n: number }>(),
  ).toEqual({ n: 1 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_run_candidates c JOIN parse_runs p ON p.id=c.parse_run_id WHERE p.fetch_artifact_id=301",
    ).first<{ n: number }>(),
  ).toEqual({ n: 0 });
}, 60_000);
