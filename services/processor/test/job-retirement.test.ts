import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { retireReplacedJobs } from "../src/worker.ts";

let mf: Miniflare;
let db: D1Database;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('local')}}",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
    }),
  );
  const binding: unknown = await mf.getD1Database("DB");
  if (!binding || typeof binding !== "object" || !("prepare" in binding))
    throw new Error("missing DB");
  db = binding as D1Database;
  await db.exec(`CREATE TABLE observation_parse_jobs(fetch_artifact_id INTEGER,parser_name TEXT,parser_version TEXT,status TEXT,last_error_code TEXT,lease_token TEXT,lease_until_ms INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(fetch_artifact_id,parser_name,parser_version));
CREATE TABLE parse_runs(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER,parser_name TEXT,parser_version TEXT,status TEXT,error TEXT);`);
});
afterAll(async () => {
  await mf?.dispose();
});
async function job(id: number, version: string, status: string, name = "fixture") {
  await db
    .prepare(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,last_error_code) VALUES(?,?,?,?,?)",
    )
    .bind(id, name, version, status, status === "failed" ? "parser_rejected" : null)
    .run();
}
async function terminal(id: number, version: string, status: string) {
  await db
    .prepare(
      "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,status,error) VALUES(?,'fixture',?,?,?)",
    )
    .bind(id, version, status, status === "error" ? "parser_rejected" : null)
    .run();
}
async function state(id: number, version: string) {
  return db
    .prepare(
      "SELECT status,last_error_code FROM observation_parse_jobs WHERE fetch_artifact_id=? AND parser_name='fixture' AND parser_version=?",
    )
    .bind(id, version)
    .first();
}
const registry = [{ name: "fixture", version: "2.0.2" }];

test("old failures remain until replacement is terminal, including retryable errors", async () => {
  await job(1, "2.0.1", "failed");
  await terminal(1, "2.0.1", "error");
  await job(1, "2.0.2", "pending");
  await terminal(1, "2.0.2", "error");
  const before = await db.prepare("SELECT * FROM parse_runs ORDER BY id").all();
  await retireReplacedJobs(db, registry);
  expect(await state(1, "2.0.1")).toEqual({ status: "failed", last_error_code: "parser_rejected" });
  await db
    .prepare(
      "UPDATE observation_parse_jobs SET status='failed' WHERE fetch_artifact_id=1 AND parser_version='2.0.2'",
    )
    .run();
  await retireReplacedJobs(db, registry);
  expect(await state(1, "2.0.1")).toEqual({
    status: "failed",
    last_error_code: "parser_version_retired",
  });
  expect(await state(1, "2.0.2")).toEqual({ status: "failed", last_error_code: null });
  expect((await db.prepare("SELECT * FROM parse_runs ORDER BY id").all()).results).toEqual(
    before.results,
  );
});

test("new success retires old failed/pending/expired jobs but preserves done and active leases", async () => {
  for (const [version, status] of [
    ["1.0.0", "pending"],
    ["1.1.0", "failed"],
    ["1.2.0", "done"],
    ["1.3.0", "running"],
    ["1.4.0", "running"],
    ["2.0.2", "done"],
  ])
    await job(2, version!, status!);
  await db
    .prepare(
      "UPDATE observation_parse_jobs SET lease_until_ms=? WHERE fetch_artifact_id=2 AND parser_version='1.3.0'",
    )
    .bind(Date.now() + 600_000)
    .run();
  await retireReplacedJobs(db, registry); // job status alone is insufficient
  expect(await state(2, "1.0.0")).toMatchObject({ status: "pending" });
  await terminal(2, "2.0.2", "ok");
  await retireReplacedJobs(db, registry);
  for (const version of ["1.0.0", "1.1.0", "1.4.0"])
    expect(await state(2, version)).toMatchObject({ last_error_code: "parser_version_retired" });
  expect(await state(2, "1.2.0")).toMatchObject({ status: "done", last_error_code: null });
  expect(await state(2, "1.3.0")).toMatchObject({ status: "running", last_error_code: null });
});

test("numeric semver guards downgrade, malformed versions and unrelated identities", async () => {
  await job(3, "2.0.2", "done");
  await terminal(3, "2.0.2", "ok");
  for (const version of [
    "2.0.10",
    "3.0.0",
    "2.0.2-beta",
    "2.0.01",
    "bogus",
    "9007199254740992.0.0",
  ])
    await job(3, version, "failed");
  await job(4, "1.0.0", "failed");
  await job(3, "1.0.0", "failed", "other");
  await retireReplacedJobs(db, registry);
  const rows = (
    await db
      .prepare(
        "SELECT last_error_code FROM observation_parse_jobs WHERE fetch_artifact_id IN (3,4) AND status='failed'",
      )
      .all()
  ).results;
  expect(rows).toHaveLength(8);
  expect(rows.every((row) => row.last_error_code === "parser_rejected")).toBe(true);
  await retireReplacedJobs(db, [{ name: "fixture", version: "2.0.10" }]); // failed job without terminal parse is not replacement evidence
  expect(await state(3, "2.0.2")).toMatchObject({ status: "done" });
});
