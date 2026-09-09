// Publication compatibility gate (D03, PR-05 steps 1-3): the projection the
// writer maintains, the legacy predicate old readers still use, the
// consistency check between them, the bounded repair for old-writer gaps,
// lease fencing, replayed publish batches (0036), late older versions, and
// the 0026 upgrade on existing rows.
// Every fixture is synthetic; the smbc-direct balance parser is used only
// because its input is a three-field JSON document.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Miniflare } from "miniflare";
import { parseJob, publishBatch } from "../src/worker.ts";
import {
  applyMigration,
  layerBMigrations,
  migrationDir,
  publishParse,
  seedArtifact,
  splitSql,
  startPipeline,
} from "./harness.ts";
import { smbcDirectBalance } from "../../../poc/observation-pipeline/src/parsers/smbc-direct.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const PARSER = "smbc-direct-balance";
const balance = { amount: 1, currency: "JPY", observedAt: "2026-09-07T00:00:00.000Z" };

const artifact = (id: number) =>
  seedArtifact(env, id, "smbc-bank", "balance-normalized", "balance.normalized.json", balance);
async function ids(sql: string, ...bind: unknown[]): Promise<number[]> {
  const rows = await env.DB.prepare(sql)
    .bind(...bind)
    .all<{ id: number }>();
  return rows.results.map((row) => row.id);
}
/** What a reader that predates the gate treats as current for one artifact. */
const legacySet = (artifactId: number) =>
  ids(
    "SELECT id FROM parse_runs WHERE fetch_artifact_id=? AND status='ok' AND superseded_by_parse_run_id IS NULL ORDER BY id",
    artifactId,
  );
/** What every gated reader treats as current for one artifact. */
const projectionSet = (artifactId: number) =>
  ids(
    "SELECT parse_run_id AS id FROM published_parse_runs WHERE fetch_artifact_id=? ORDER BY parse_run_id",
    artifactId,
  );
const mismatches = (artifactId: number) =>
  env.DB.prepare(
    "SELECT parse_run_id,mismatch FROM publication_gate_mismatches WHERE fetch_artifact_id=? ORDER BY parse_run_id",
  )
    .bind(artifactId)
    .all<{ parse_run_id: number; mismatch: string }>()
    .then((r) => r.results);
const events = (artifactId: number) =>
  env.DB.prepare(
    "SELECT previous_parse_run_id AS previous,new_parse_run_id AS next,kind,actor FROM publication_events WHERE fetch_artifact_id=? ORDER BY id",
  )
    .bind(artifactId)
    .all<{ previous: number | null; next: number; kind: string; actor: string }>()
    .then((r) => r.results);
async function run(artifactId: number, version: string) {
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,'pending')",
  )
    .bind(artifactId, PARSER, version)
    .run();
  return parseJob(
    env,
    { fetch_artifact_id: artifactId, parser_name: PARSER, parser_version: version, attempts: 0 },
    { ...smbcDirectBalance, version },
  );
}
async function request(path: string, body?: unknown) {
  const response = await mf.dispatchFetch(`https://pipeline.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
/** The publish transaction of the Worker that predates the gate, verbatim,
 * so a mixed deployment can be reproduced: supersession without projection. */
async function oldWriterPublish(artifactId: number, version: string, token: string) {
  const inserted = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'2026-09-07T00:00:00.000Z','pending','[]') RETURNING id",
  )
    .bind(artifactId, PARSER, version)
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lease_token,lease_until_ms) VALUES(?,?,?,'running',?,?)",
  )
    .bind(artifactId, PARSER, version, token, Date.now() + 60_000)
    .run();
  const parts = version.split(".").map(Number);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE parse_runs SET status='ok',superseded_by_parse_run_id=(
        SELECT newer.id FROM parse_runs newer
        WHERE newer.fetch_artifact_id=parse_runs.fetch_artifact_id
          AND newer.parser_name=parse_runs.parser_name AND newer.status='ok'
          AND newer.superseded_by_parse_run_id IS NULL
          AND (
            json_extract('['||replace(newer.parser_version,'.',',')||']','$[0]'),
            json_extract('['||replace(newer.parser_version,'.',',')||']','$[1]'),
            json_extract('['||replace(newer.parser_version,'.',',')||']','$[2]')
          ) > (?,?,?)
        ORDER BY
          json_extract('['||replace(newer.parser_version,'.',',')||']','$[0]') DESC,
          json_extract('['||replace(newer.parser_version,'.',',')||']','$[1]') DESC,
          json_extract('['||replace(newer.parser_version,'.',',')||']','$[2]') DESC LIMIT 1
      ) WHERE id=? AND EXISTS(SELECT 1 FROM observation_parse_jobs WHERE lease_token=? AND status='running' AND lease_until_ms>?)`,
    ).bind(parts[0]!, parts[1]!, parts[2]!, inserted!.id, token, Date.now()),
    env.DB.prepare(
      `UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE fetch_artifact_id=? AND parser_name=? AND id<>? AND status='ok' AND superseded_by_parse_run_id IS NULL AND EXISTS(SELECT 1 FROM parse_runs p WHERE p.id=? AND p.status='ok' AND p.superseded_by_parse_run_id IS NULL)`,
    ).bind(inserted!.id, artifactId, PARSER, inserted!.id, inserted!.id),
    env.DB.prepare(
      `UPDATE observation_parse_jobs SET status='done',last_error_code=NULL WHERE lease_token=? AND EXISTS(SELECT 1 FROM parse_runs WHERE id=? AND status='ok')`,
    ).bind(token, inserted!.id),
  ]);
  return inserted!.id;
}

test("the new writer keeps the legacy predicate equal to the projection after every publish", async () => {
  await artifact(900);
  expect(await run(900, "1.0.0")).toBe("parsed");
  const [first] = await legacySet(900);
  expect(await projectionSet(900)).toEqual([first!]);
  expect(await events(900)).toEqual([
    { previous: null, next: first!, kind: "normal", actor: "pipeline" },
  ]);
  expect(await run(900, "1.1.0")).toBe("parsed");
  const [second] = await legacySet(900);
  expect(second).not.toBe(first);
  expect(await projectionSet(900)).toEqual([second!]);
  expect(await events(900)).toEqual([
    { previous: null, next: first!, kind: "normal", actor: "pipeline" },
    { previous: first!, next: second!, kind: "normal", actor: "pipeline" },
  ]);
  expect(await mismatches(900)).toEqual([]);
  const view = await env.DB.prepare(
    "SELECT id,parser_version,publication_kind,release_id FROM published_observation_parses WHERE fetch_artifact_id=900",
  ).all();
  expect(view.results).toEqual([
    { id: second!, parser_version: "1.1.0", publication_kind: "normal", release_id: null },
  ]);
}, 30000);

test("a late-completing older version publishes its rows but never moves the projection", async () => {
  await artifact(901);
  expect(await run(901, "1.5.0")).toBe("parsed");
  const [newest] = await projectionSet(901);
  expect(await run(901, "1.2.0")).toBe("parsed");
  expect(await projectionSet(901)).toEqual([newest!]);
  expect(await legacySet(901)).toEqual([newest!]);
  expect((await events(901)).map((e) => e.next)).toEqual([newest!]);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM parse_runs WHERE fetch_artifact_id=901 AND status='ok' AND superseded_by_parse_run_id=?",
    )
      .bind(newest)
      .first<number>("n"),
  ).toBe(1);
  expect(await mismatches(901)).toEqual([]);
}, 30000);

test("a writer whose lease expired changes nothing: no status, no projection, no event", async () => {
  await artifact(902);
  const pending = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(902,?,'1.0.0','2026-09-07T00:00:00.000Z','pending','[]') RETURNING id",
  )
    .bind(PARSER)
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lease_token,lease_until_ms) VALUES(902,?,'1.0.0','running','expired-writer',?)",
  )
    .bind(PARSER, Date.now() - 1)
    .run();
  const input = {
    parseId: pending!.id,
    token: "expired-writer",
    version: [1, 0, 0],
    artifactId: 902,
    parserName: PARSER,
    publishedAt: "2026-09-07T00:00:00.000Z",
    now: Date.now(),
  };
  const expired = await env.DB.batch(publishBatch(env, input));
  expect(expired[0]?.meta.changes).toBe(0);
  expect(
    await env.DB.prepare("SELECT status FROM parse_runs WHERE id=?")
      .bind(pending!.id)
      .first<string>("status"),
  ).toBe("pending");
  expect(await projectionSet(902)).toEqual([]);
  expect(await events(902)).toEqual([]);
  expect(await mismatches(902)).toEqual([]);
  // The same batch with a live lease publishes, as a control.
  await env.DB.prepare(
    "UPDATE observation_parse_jobs SET lease_until_ms=? WHERE lease_token='expired-writer'",
  )
    .bind(Date.now() + 60_000)
    .run();
  const live = await env.DB.batch(publishBatch(env, { ...input, now: Date.now() }));
  expect(live[0]?.meta.changes).toBe(1);
  expect(await projectionSet(902)).toEqual([pending!.id]);
  expect(await legacySet(902)).toEqual([pending!.id]);
}, 30000);

test("re-executing the publish batch for an already published run changes nothing", async () => {
  await artifact(906);
  const parse = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(906,?,'1.0.0','2026-09-07T00:00:00.000Z','pending','[]') RETURNING id",
  )
    .bind(PARSER)
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lease_token,lease_until_ms) VALUES(906,?,'1.0.0','running','replayed-writer',?)",
  )
    .bind(PARSER, Date.now() + 60_000)
    .run();
  const input = {
    parseId: parse!.id,
    token: "replayed-writer",
    version: [1, 0, 0],
    artifactId: 906,
    parserName: PARSER,
    publishedAt: "2026-09-07T00:00:00.000Z",
    now: Date.now(),
  };
  const published = await env.DB.batch(publishBatch(env, input));
  // ok, no older run to supersede, event, pointer, job closed.
  expect(published.map((result) => result.meta.changes)).toEqual([1, 0, 1, 1, 1]);
  const before = await events(906);
  expect(before).toEqual([{ previous: null, next: parse!.id, kind: "normal", actor: "pipeline" }]);
  const publishedAt = () =>
    env.DB.prepare(
      "SELECT published_at FROM published_parse_runs WHERE fetch_artifact_id=906",
    ).first<string>("published_at");
  expect(await publishedAt()).toBe("2026-09-07T00:00:00.000Z");
  // The whole batch again, as a redelivered queue message or a retried sweep
  // would run it. Nothing may change: the second event would be a pointer
  // move from the run to itself, and the pointer would gain a new timestamp.
  const replay = await env.DB.batch(
    publishBatch(env, { ...input, publishedAt: "2026-09-09T00:00:00.000Z", now: Date.now() }),
  );
  expect(replay.map((result) => result.meta.changes)).toEqual([0, 0, 0, 0, 0]);
  expect(await events(906)).toEqual(before);
  expect(await publishedAt()).toBe("2026-09-07T00:00:00.000Z");
  expect(await projectionSet(906)).toEqual([parse!.id]);
  // Same batch while the lease is still live (a retry inside the lease): the
  // lease fence cannot help there, the "already the pointer" guard must.
  await env.DB.prepare(
    "UPDATE observation_parse_jobs SET status='running',lease_until_ms=? WHERE lease_token='replayed-writer'",
  )
    .bind(Date.now() + 60_000)
    .run();
  const leased = await env.DB.batch(
    publishBatch(env, { ...input, publishedAt: "2026-09-10T00:00:00.000Z", now: Date.now() }),
  );
  expect(leased.slice(0, 4).map((result) => result.meta.changes)).toEqual([1, 0, 0, 0]);
  expect(await events(906)).toEqual(before);
  expect(await publishedAt()).toBe("2026-09-07T00:00:00.000Z");
  expect(await mismatches(906)).toEqual([]);
  // Migration 0036 makes the corrupt row impossible for any future writer.
  await expect(
    env.DB.prepare(
      `INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
      VALUES(906,?,?,?,'normal','pipeline','self reference','2026-09-11T00:00:00.000Z')`,
    )
      .bind(PARSER, parse!.id, parse!.id)
      .run(),
  ).rejects.toThrow(/replacing itself/);
  // The repair route on a consistent key adds nothing either.
  const repair = await request("/publication/repair", {
    actor: "operator-replay",
    reason: "no gap expected",
  });
  expect(repair.status).toBe(200);
  expect(await events(906)).toEqual(before);
}, 30000);

test("an old writer leaves gaps the consistency route reports and the bounded repair route fills", async () => {
  await artifact(903);
  await artifact(904);
  expect(await run(903, "1.0.0")).toBe("parsed");
  const [published903] = await projectionSet(903);
  // Mixed deployment: a Worker without the gate publishes a newer version on
  // 903 (superseding the published run) and a first version on 904.
  const replaced903 = await oldWriterPublish(903, "1.1.0", "old-writer-903");
  const first904 = await oldWriterPublish(904, "1.0.0", "old-writer-904");
  expect(await legacySet(903)).toEqual([replaced903]);
  expect(await projectionSet(903)).toEqual([published903!]);
  expect(await mismatches(903)).toEqual([
    { parse_run_id: published903!, mismatch: "projection_only" },
    { parse_run_id: replaced903, mismatch: "legacy_only" },
  ]);
  expect(await mismatches(904)).toEqual([{ parse_run_id: first904, mismatch: "legacy_only" }]);
  const consistency = await request("/publication/consistency");
  expect(consistency.status).toBe(200);
  expect(consistency.json).toMatchObject({ legacyOnly: 2, projectionOnly: 1, mismatches: 3 });
  expect(consistency.json.sample).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ parse_run_id: replaced903, mismatch: "legacy_only" }),
      expect.objectContaining({ parse_run_id: first904, mismatch: "legacy_only" }),
      expect.objectContaining({ parse_run_id: published903, mismatch: "projection_only" }),
    ]),
  );
  // Invalid commands change nothing.
  for (const body of [
    { actor: "pipeline", reason: "reserved actor" },
    { actor: "Operator One", reason: "bad actor pattern" },
    { actor: "operator-1" },
    { actor: "operator-1", reason: "" },
    { actor: "operator-1", reason: "too many", limit: 0 },
    { actor: "operator-1", reason: "too many", limit: 1001 },
    { actor: "operator-1", reason: "not a number", limit: "5" },
  ])
    expect((await request("/publication/repair", body)).status, JSON.stringify(body)).toBe(400);
  expect(consistency.json.mismatches).toBe(
    (await request("/publication/consistency")).json.mismatches,
  );
  // Bounded: one key per call when asked, and every call idempotent.
  const bounded = await request("/publication/repair", {
    actor: "operator-1",
    reason: "old writer gap",
    limit: 1,
  });
  expect(bounded.status).toBe(200);
  expect(bounded.json).toEqual({ repaired: 1, remaining: 1 });
  const rest = await request("/publication/repair", {
    actor: "operator-1",
    reason: "old writer gap",
  });
  expect(rest.json).toEqual({ repaired: 1, remaining: 0 });
  const again = await request("/publication/repair", {
    actor: "operator-1",
    reason: "old writer gap",
  });
  expect(again.json).toEqual({ repaired: 0, remaining: 0 });
  expect(await projectionSet(903)).toEqual([replaced903]);
  expect(await projectionSet(904)).toEqual([first904]);
  expect(await mismatches(903)).toEqual([]);
  expect(await mismatches(904)).toEqual([]);
  expect(await events(903)).toEqual([
    { previous: null, next: published903!, kind: "normal", actor: "pipeline" },
    { previous: published903!, next: replaced903, kind: "repair", actor: "operator-1" },
  ]);
  expect(await events(904)).toEqual([
    { previous: null, next: first904, kind: "repair", actor: "operator-1" },
  ]);
  expect((await request("/publication/consistency")).json).toMatchObject({ mismatches: 0 });
}, 30000);

test("a successful run outside the projection stays invisible to readers and visible to the audit path", async () => {
  await artifact(905);
  expect(await run(905, "1.0.0")).toBe("parsed");
  const [published] = await projectionSet(905);
  // A future candidate: recorded as ok, superseding nothing, not published.
  const candidate = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(905,?,'2.0.0','2026-09-08T00:00:00.000Z','ok','[]') RETURNING id",
  )
    .bind(PARSER)
    .first<{ id: number }>();
  expect(await projectionSet(905)).toEqual([published!]);
  expect(
    await env.DB.prepare(
      "SELECT id FROM published_observation_parses WHERE fetch_artifact_id=905",
    ).first<number>("id"),
  ).toBe(published!);
  // The legacy rule would have shown the candidate: exactly the trap the
  // gate closes. The audit path lists it; readers of the projection do not.
  expect(await legacySet(905)).toEqual([published!, candidate!.id]);
  expect(await mismatches(905)).toEqual([{ parse_run_id: candidate!.id, mismatch: "legacy_only" }]);
  // The projection cannot be pointed at a run that is not ok, and never deleted.
  await expect(
    env.DB.prepare("DELETE FROM published_parse_runs WHERE fetch_artifact_id=905").run(),
  ).rejects.toThrow(/cannot be deleted/);
  const failed = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,error,warnings_json) VALUES(905,?,'3.0.0','2026-09-08T00:00:00.000Z','error','synthetic','[]') RETURNING id",
  )
    .bind(PARSER)
    .first<{ id: number }>();
  await expect(publishParse(env.DB, failed!.id)).rejects.toThrow(/successful/);
  await expect(
    env.DB.prepare("UPDATE published_parse_runs SET parse_run_id=? WHERE fetch_artifact_id=905")
      .bind(failed!.id)
      .run(),
  ).rejects.toThrow(/successful/);
  expect(await projectionSet(905)).toEqual([published!]);
}, 30000);

test("migrations 0026 and 0036 apply on the earlier schema with existing rows and backfill exactly the legacy set", async () => {
  const upgrade = await startPipeline(
    layerBMigrations().filter((name) => !name.startsWith("0026_") && !name.startsWith("0036_")),
  );
  try {
    const db = upgrade.env.DB;
    for (const id of [1, 2, 3])
      await seedArtifact(
        upgrade.env,
        id,
        "smbc-bank",
        "balance-normalized",
        "balance.normalized.json",
        balance,
      );
    const insert = async (
      artifactId: number,
      parser: string,
      version: string,
      status: "ok" | "error" | "pending",
    ) =>
      (await db
        .prepare(
          "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,error,warnings_json) VALUES(?,?,?,'2026-09-01T00:00:00.000Z',?,?,'[]') RETURNING id",
        )
        .bind(artifactId, parser, version, status, status === "error" ? "synthetic" : null)
        .first<{ id: number }>())!.id;
    const a = await insert(1, PARSER, "1.0.0", "ok");
    const b = await insert(1, PARSER, "1.1.0", "ok");
    await db
      .prepare("UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE id=?")
      .bind(b, a)
      .run();
    await insert(1, PARSER, "1.2.0", "error");
    await insert(1, PARSER, "1.3.0", "pending");
    const e = await insert(1, "other-parser", "1.0.0", "ok");
    const f = await insert(2, PARSER, "1.0.0", "ok");
    // Two live successes on one key cannot come from the writer; the backfill
    // must still terminate deterministically and report the loser.
    const g = await insert(3, PARSER, "1.0.0", "ok");
    const h = await insert(3, PARSER, "1.1.0", "ok");
    const legacy = (
      await db
        .prepare(
          "SELECT id FROM parse_runs WHERE status='ok' AND superseded_by_parse_run_id IS NULL ORDER BY id",
        )
        .all<{ id: number }>()
    ).results.map((r) => r.id);
    expect(legacy).toEqual([b, e, f, g, h]);
    await applyMigration(db, "0026_publication_gate.sql");
    // 0036 guards the event history; it must apply on top of a backfilled 0026.
    await applyMigration(db, "0036_publication_event_guard.sql");
    const projection = (
      await db
        .prepare("SELECT parse_run_id FROM published_parse_runs ORDER BY parse_run_id")
        .all<{ parse_run_id: number }>()
    ).results.map((r) => r.parse_run_id);
    expect(projection).toEqual([b, e, f, h]);
    expect(
      (
        await db
          .prepare("SELECT parse_run_id,mismatch FROM publication_gate_mismatches")
          .all<{ parse_run_id: number; mismatch: string }>()
      ).results,
    ).toEqual([{ parse_run_id: g, mismatch: "legacy_only" }]);
    expect(
      (
        await db
          .prepare(
            "SELECT new_parse_run_id AS id,kind,actor,previous_parse_run_id AS previous FROM publication_events ORDER BY new_parse_run_id",
          )
          .all<{ id: number; kind: string; actor: string; previous: number | null }>()
      ).results,
    ).toEqual(
      [b, e, f, h].map((id) => ({ id, kind: "backfill", actor: "migration:0026", previous: null })),
    );
    // Idempotent: the backfill statements add nothing the second time.
    const backfill = splitSql(
      readFileSync(new URL("0026_publication_gate.sql", migrationDir), "utf8"),
    ).filter((sql) => /^\s*INSERT INTO/.test(sql));
    expect(backfill).toHaveLength(2);
    for (const sql of backfill) expect((await db.prepare(sql).run()).meta.changes).toBe(0);
    // The previous Worker's job insert and the gated identity view both work.
    await db
      .prepare(
        "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(2,'legacy-writer','1.0.0','pending')",
      )
      .run();
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM current_identity_observations")
        .first<number>("n"),
    ).toBe(0);
  } finally {
    await upgrade.mf.dispose();
  }
}, 60000);
