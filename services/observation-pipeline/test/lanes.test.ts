import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { runScheduled, sweep } from "../src/worker.ts";
import { identitySweep } from "../src/identity-store.ts";
import { resolveIdentity } from "../../../poc/observation-pipeline/src/identity/index.ts";
import { layerBMigrations, publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const balance = { amount: 1, currency: "JPY", observedAt: "2026-09-07T00:00:00.000Z" };
const transactions = {
  range: { start: "2026-09-01", end: "2026-09-07" },
  transactions: [],
  depositsTotal: 0,
  withdrawalsTotal: 0,
};
async function post(path: string, body?: unknown) {
  const response = await mf.dispatchFetch(`https://pipeline.internal${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
async function count(sql: string, ...bind: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql)
    .bind(...bind)
    .first<number>("n"))!;
}
const setCursor = (cursor: number) =>
  env.DB.prepare("UPDATE observation_scan_state SET cursor=? WHERE id=1").bind(cursor).run();
const job = (id: number) =>
  env.DB.prepare(
    "SELECT lane,status,replay_plan_id FROM observation_parse_jobs WHERE fetch_artifact_id=?",
  )
    .bind(id)
    .first<{ lane: string; status: string; replay_plan_id: number | null }>();

test("harness applies every Layer B migration in order through 0037", () => {
  const names = layerBMigrations();
  expect(names[0]).toBe("0017_observation_pipeline.sql");
  expect(names.at(-1)).toBe("0037_unit_scope_eligibility.sql");
  expect(names).toEqual([
    "0017_observation_pipeline.sql",
    "0018_identity.sql",
    "0019_identity_seal_provenance.sql",
    "0020_vpass_identity_binding.sql",
    "0021_vpass_binding_lookup_plan.sql",
    "0022_identity_current_run_plan.sql",
    "0023_account_connections.sql",
    "0024_observation_decimals.sql",
    "0025_parse_coverage.sql",
    "0026_publication_gate.sql",
    "0029_decision_log.sql",
    "0035_observation_job_lanes.sql",
    "0036_publication_event_guard.sql",
    "0037_unit_scope_eligibility.sql",
  ]);
  expect([...names].sort()).toEqual(names);
});

test("a newly sealed run gets its job on the next sweep without waiting for a cursor cycle", async () => {
  await seedArtifact(
    env,
    300,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  // The seal trigger enqueued the notification atomically with the seal.
  expect(
    await env.DB.prepare(
      "SELECT fetch_run_id,kind,processed_at_ms FROM observation_work_items WHERE fetch_run_id=300",
    ).first<{ fetch_run_id: number; kind: string; processed_at_ms: number | null }>(),
  ).toEqual({ fetch_run_id: 300, kind: "sealed_run", processed_at_ms: null });
  // Park the cyclic cursor past the artifact so only the work item can find it.
  await setCursor(300);
  const result = await sweep(env);
  expect(result.lanes.incremental).toMatchObject({ created: 1, parsed: 1, workItems: 1 });
  expect(result.lanes.repair).toMatchObject({ created: 0, parsed: 0 });
  expect(await job(300)).toEqual({ lane: "incremental", status: "done", replay_plan_id: null });
  expect(
    await env.DB.prepare(
      "SELECT outcome,jobs_created FROM observation_work_items WHERE fetch_run_id=300",
    ).first<{ outcome: string; jobs_created: number }>(),
  ).toEqual({ outcome: "jobs_created", jobs_created: 1 });
  expect(
    await count("SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id=300 AND status='ok'"),
  ).toBe(1);
  // A lane-scoped sweep never touches the repair cursor.
  await seedArtifact(
    env,
    301,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  await setCursor(301);
  const incremental = await sweep(env, { lane: "incremental" });
  expect(incremental.lanes.incremental?.parsed).toBe(1);
  expect(incremental.lanes.repair).toBeUndefined();
  expect(
    await env.DB.prepare("SELECT cursor FROM observation_scan_state WHERE id=1").first<number>(
      "cursor",
    ),
  ).toBe(301);
  const status = (await (await mf.dispatchFetch("https://pipeline.internal/status")).json()) as {
    lanes: Record<string, { done: number; oldestPendingAgeMs: number | null }>;
    workItems: { unprocessed: number };
    freshness: { latestSealedAtMs: number; latestParsedAt: string };
    laneState: { lane: string; last_executed: number }[];
  };
  expect(status.lanes.incremental?.done).toBe(2);
  expect(status.workItems.unprocessed).toBe(0);
  expect(status.freshness.latestSealedAtMs).toBeGreaterThan(0);
  expect(status.freshness.latestParsedAt).toMatch(/^\d{4}-/);
  expect(status.laneState.find((s) => s.lane === "incremental")?.last_executed).toBe(1);
}, 30000);

test("a replay of 200 artifacts does not block incremental jobs in the same sweep", async () => {
  for (let id = 1000; id < 1200; id++)
    await seedArtifact(
      env,
      id,
      "smbc-bank",
      "balance-normalized",
      "balance.normalized.json",
      balance,
    );
  // Runs sealed before the outbox existed have no notification.
  await env.DB.prepare(
    "DELETE FROM observation_work_items WHERE fetch_run_id BETWEEN 1000 AND 1199",
  ).run();
  const planned = await post("/replay/plan", {
    source: "smbc-bank",
    dataset: "balance-normalized",
    parser: "smbc-direct-balance",
    version: "1.0.0",
    artifactIdFrom: 999,
    reason: "synthetic backlog",
  });
  expect(planned.status).toBe(200);
  const plan = planned.json.plan as { id: number; status: string; estimated_artifacts: number };
  expect(plan).toMatchObject({ status: "planned", estimated_artifacts: 200 });
  expect(
    await count("SELECT count(*) AS n FROM observation_parse_jobs WHERE replay_plan_id=?", plan.id),
  ).toBe(0);
  const started = await post("/replay/start", { planId: plan.id });
  expect(started.status).toBe(200);
  expect(started.json.jobs).toEqual({ pending: 200, running: 0, done: 0, failed: 0 });
  await seedArtifact(
    env,
    1300,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  await setCursor(1300);
  const result = await sweep(env);
  expect(result.lanes.incremental).toMatchObject({ parsed: 1, error: 0 });
  expect(result.lanes.replay).toMatchObject({ parsed: 8, error: 0 });
  expect(await job(1300)).toEqual({ lane: "incremental", status: "done", replay_plan_id: null });
  expect(
    await count(
      "SELECT count(*) AS n FROM observation_parse_jobs WHERE lane='replay' AND status='pending' AND replay_plan_id=?",
      plan.id,
    ),
  ).toBe(192);
  // Leave the backlog paused: later lanes must not be fed by this plan.
  expect((await post("/replay/pause", { planId: plan.id })).json.plan).toMatchObject({
    status: "paused",
  });
  expect((await sweep(env, { lane: "replay" })).lanes.replay).toMatchObject({ parsed: 0 });
}, 120000);

test("a dropped notification is recovered by the repair lane", async () => {
  await seedArtifact(
    env,
    400,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  await env.DB.prepare("DELETE FROM observation_work_items WHERE fetch_run_id=400").run();
  await setCursor(399);
  const result = await sweep(env, { lane: "repair" });
  expect(result.lanes.repair).toMatchObject({ created: 1, parsed: 1 });
  expect(await job(400)).toEqual({ lane: "repair", status: "done", replay_plan_id: null });
}, 30000);

test("pause/resume is idempotent, leases are fenced, and nothing publishes twice", async () => {
  for (const id of [500, 501, 502])
    await seedArtifact(
      env,
      id,
      "smbc-bank",
      "transactions-normalized",
      "transactions/20260901-20260907.normalized.json",
      transactions,
    );
  await env.DB.prepare(
    "DELETE FROM observation_work_items WHERE fetch_run_id BETWEEN 500 AND 502",
  ).run();
  const plan = (
    await post("/replay/plan", {
      source: "smbc-bank",
      dataset: "transactions-normalized",
      parser: "smbc-direct-transactions",
      version: "1.0.0",
      reason: "synthetic pause test",
    })
  ).json.plan as { id: number };
  expect((await post("/replay/start", { planId: plan.id })).json.jobs).toMatchObject({
    pending: 3,
  });
  // Another writer holds a live lease on artifact 500.
  await env.DB.prepare(
    "UPDATE observation_parse_jobs SET status='running',attempts=1,lease_token='stale-writer',lease_until_ms=? WHERE fetch_artifact_id=500",
  )
    .bind(Date.now() + 60_000)
    .run();
  expect((await sweep(env, { lane: "replay", maxJobs: 1 })).lanes.replay).toMatchObject({
    parsed: 1,
  });
  expect((await job(501))?.status).toBe("done");
  expect((await post("/replay/pause", { planId: plan.id })).json.plan).toMatchObject({
    status: "paused",
  });
  expect((await post("/replay/pause", { planId: plan.id })).status).toBe(200);
  expect((await sweep(env, { lane: "replay" })).lanes.replay).toMatchObject({
    parsed: 0,
    skipped: 0,
  });
  expect((await job(502))?.status).toBe("pending");
  expect((await post("/replay/resume", { planId: plan.id })).json.plan).toMatchObject({
    status: "running",
  });
  expect((await post("/replay/resume", { planId: plan.id })).status).toBe(200);
  expect((await post("/replay/start", { planId: plan.id })).status).toBe(200);
  // The stale writer's lease expires; the reclaim replaces its token so its
  // fenced publish can no longer match.
  await env.DB.prepare(
    "UPDATE observation_parse_jobs SET lease_until_ms=0 WHERE fetch_artifact_id=500 AND lease_token='stale-writer'",
  ).run();
  expect((await sweep(env, { lane: "replay" })).lanes.replay).toMatchObject({
    parsed: 2,
    error: 0,
  });
  expect(
    await count(
      "SELECT count(*) AS n FROM observation_parse_jobs WHERE lease_token='stale-writer'",
    ),
  ).toBe(0);
  for (const id of [500, 501, 502]) {
    expect(
      await count(
        "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id=? AND status='ok'",
        id,
      ),
    ).toBe(1);
    await expect(
      env.DB.prepare(
        "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,'smbc-direct-transactions','1.0.0','2026-09-08T00:00:00.000Z','ok','[]')",
      )
        .bind(id)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  }
  const inspected = await post("/replay/inspect", { planId: plan.id });
  expect(inspected.json.plan).toMatchObject({ status: "completed", jobs_created: 3 });
  expect(inspected.json.jobs).toEqual({ pending: 0, running: 0, done: 3, failed: 0 });
  expect((await post("/replay/start", { planId: plan.id })).status).toBe(409);
  expect((await post("/replay/cancel", { planId: plan.id })).status).toBe(409);
}, 60000);

test("the replay high-water is fixed at plan time and later evidence never grows the plan", async () => {
  const before = (
    await post("/replay/plan", {
      source: "smbc-bank",
      dataset: "balance-normalized",
      parser: "smbc-direct-balance",
      version: "1.0.0",
      artifactIdFrom: 999,
      reason: "synthetic high-water",
    })
  ).json.plan as {
    id: number;
    artifact_id_high_water: number;
    estimated_artifacts: number;
    already_parsed: number;
  };
  const highWater = (await env.DB.prepare("SELECT max(id) AS n FROM fetch_artifacts").first<number>(
    "n",
  ))!;
  expect(before.artifact_id_high_water).toBe(highWater);
  expect(before.estimated_artifacts).toBe(201);
  expect(before.already_parsed).toBe(9);
  await seedArtifact(
    env,
    1400,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  for (let step = 0; step < 3; step++)
    expect((await post("/replay/start", { planId: before.id })).status).toBe(200);
  const after = (await post("/replay/inspect", { planId: before.id })).json.plan as {
    artifact_id_high_water: number;
    estimated_artifacts: number;
    creation_complete: number;
  };
  expect(after).toMatchObject({
    artifact_id_high_water: highWater,
    estimated_artifacts: 201,
    creation_complete: 1,
  });
  expect(
    await count(
      "SELECT count(*) AS n FROM observation_parse_jobs WHERE fetch_artifact_id=1400 AND replay_plan_id IS NOT NULL",
    ),
  ).toBe(0);
  expect(
    await count(
      "SELECT count(*) AS n FROM observation_parse_jobs WHERE replay_plan_id=? AND fetch_artifact_id>?",
      before.id,
      highWater,
    ),
  ).toBe(0);
  // Cancel stops unclaimed work only and leaves every published result alone.
  const published = await count("SELECT count(*) AS n FROM parse_runs WHERE status='ok'");
  expect((await post("/replay/cancel", { planId: before.id })).json.plan).toMatchObject({
    status: "cancelled",
  });
  expect(await count("SELECT count(*) AS n FROM parse_runs WHERE status='ok'")).toBe(published);
  expect((await sweep(env, { lane: "replay" })).lanes.replay).toMatchObject({ parsed: 0 });
}, 60000);

test("identity sweep still runs and is logged separately when the parse sweep fails", async () => {
  const lines: Record<string, unknown>[] = [];
  const log = (line: string) => lines.push(JSON.parse(line));
  await runScheduled(
    env,
    {
      parse: () => Promise.reject(new Error("synthetic D1 outage: amount=999999")),
      identity: (env) => identitySweep(env.DB, resolveIdentity),
    },
    log,
  );
  expect(lines).toEqual([
    { event: "observation_sweep_failed", code: "Error" },
    expect.objectContaining({ event: "identity_sweep", processedRuns: expect.any(Number) }),
  ]);
  expect(JSON.stringify(lines)).not.toContain("999999");
  lines.length = 0;
  await runScheduled(env, undefined, log);
  expect(lines.map((line) => line.event)).toEqual(["observation_sweep", "identity_sweep"]);
  expect(lines[0]).toHaveProperty("lanes");
}, 60000);

test("replay and sweep commands validate their input and stay off unknown routes", async () => {
  expect(
    (
      await post("/replay/plan", {
        source: "smbc-bank",
        parser: "smbc-direct-balance",
        version: "9.9.9",
        reason: "x",
      })
    ).json,
  ).toEqual({ error: "parser_not_deployed" });
  expect(
    (
      await post("/replay/plan", {
        source: "SMBC",
        parser: "smbc-direct-balance",
        version: "1.0.0",
        reason: "x",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post("/replay/plan", {
        source: "smbc-bank",
        parser: "smbc-direct-balance",
        version: "1.0.0",
        reason: "x",
        fetchedFrom: "yesterday",
      })
    ).json,
  ).toEqual({ error: "window_invalid" });
  expect((await post("/replay/start", { planId: "1" })).status).toBe(400);
  expect((await post("/replay/inspect", { planId: 987654 })).status).toBe(404);
  expect((await post("/replay/resume", { planId: 987654 })).status).toBe(404);
  expect((await post("/sweep?lane=bogus")).status).toBe(400);
  expect((await mf.dispatchFetch("https://pipeline.internal/replay/plan")).status).toBe(404);
});

test("operator signals count published parses, not unadopted successes", async () => {
  await seedArtifact(
    env,
    1500,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  const freshness = async () =>
    (
      (await (await mf.dispatchFetch("https://pipeline.internal/status")).json()) as {
        freshness: { latestParsedAt: string };
      }
    ).freshness.latestParsedAt;
  const plan = async () =>
    (
      await post("/replay/plan", {
        source: "smbc-bank",
        dataset: "balance-normalized",
        parser: "smbc-direct-balance",
        version: "1.0.0",
        artifactIdFrom: 1499,
        reason: "synthetic publication signal",
      })
    ).json.plan as { estimated_artifacts: number; already_parsed: number };
  const beforeParsedAt = await freshness();
  expect(await plan()).toMatchObject({ estimated_artifacts: 1, already_parsed: 0 });
  // What a candidate looks like: a successful run the gate never adopted. It
  // is an execution attempt, not work an operator may consider done.
  const unadopted = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(1500,'smbc-direct-balance','1.0.0','2099-01-01T00:00:00.000Z','ok','[]') RETURNING id",
  ).first<{ id: number }>();
  expect(await freshness()).toBe(beforeParsedAt);
  expect(await plan()).toMatchObject({ estimated_artifacts: 1, already_parsed: 0 });
  // Adopting it through the pointer flips both signals, and nothing else.
  await publishParse(env.DB, unadopted!.id, "2099-01-01T00:00:00.000Z");
  expect(await freshness()).toBe("2099-01-01T00:00:00.000Z");
  expect(await plan()).toMatchObject({ estimated_artifacts: 1, already_parsed: 1 });
}, 30000);
