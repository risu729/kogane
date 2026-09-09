// Unit-scoped partial-run eligibility in the production Worker (design review
// D13, PR-14, policy `unit-independent-v1`). Migration 0037 applies on top of
// 0017-0035; the seeded state is unchanged run-scope behaviour; a policy row on
// the `unit` scope lets a proven fetch unit of a partial run be parsed and
// adopted while its failed sibling keeps its previous evidence; a gap inside
// one unit still blocks adoption; and setting the row back to `run` restores
// the strict rule exactly.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { publicationStatements } from "../src/publication-gate.ts";
import { sweep } from "../src/worker.ts";
import { seedUnitRun, setUnitScope, startPipeline } from "./harness.ts";
import { snapshotCtes } from "../../../poc/observation-pipeline/src/snapshot-query.ts";

// The reader's relations on the production schema (packages/read-model concepts).
const RELATIONS = {
  fetchArtifacts: "observation_fetch_artifacts",
  fetchRuns: "observation_fetch_runs",
  parseRuns: "parse_runs",
  publishedParseRuns: "published_parse_runs",
};
const SOURCE = "smbc-bank";
const DATASET = "balance-normalized";
const PARSER = "smbc-direct-balance";
const KEY = "balance.normalized.json";
const balance = (amount: number) => ({
  amount,
  currency: "JPY",
  observedAt: "2026-09-07T00:00:00.000Z",
});

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const all = <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...args)
    .all<T>()
    .then((result) => result.results);
const first = <T>(sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...args)
    .first<T>();

const parsedArtifacts = (ids: readonly number[]) =>
  all<{ fetch_artifact_id: number; status: string }>(
    `SELECT fetch_artifact_id,status FROM parse_runs WHERE fetch_artifact_id IN (${ids.join(",")}) ORDER BY fetch_artifact_id`,
  );
const currentSnapshot = (unit: string) =>
  first<{ artifact_id: number }>(
    `WITH ${snapshotCtes(RELATIONS)} SELECT artifact_id FROM current_snapshots
     WHERE parser_name=? AND fetch_unit_key=?`,
    PARSER,
    unit,
  ).then((row) => row?.artifact_id ?? null);
const rescan = async () => {
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
};

test("0037 applies on the production chain and changes nothing while every row is run-scoped", async () => {
  expect(
    await first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='view' AND name='observation_fetch_artifact_units'",
    ),
  ).toEqual({ name: "observation_fetch_artifact_units" });
  const policies = await all<{ unit_scope: string; snapshot_selection: number }>(
    "SELECT unit_scope,snapshot_selection FROM dataset_snapshot_policies",
  );
  expect(policies.length).toBeGreaterThan(0);
  expect(policies.every((row) => row.unit_scope === "run")).toBe(true);
  expect(policies.every((row) => row.snapshot_selection === 1)).toBe(true);

  // A partial run under the seeded policy: no job, no parse, for either unit.
  await seedUnitRun(env, {
    id: 400,
    source: SOURCE,
    dataset: DATASET,
    runOutcome: "partial",
    fetchedAtMs: Date.parse("2026-09-05T00:00:00.000Z"),
    units: [
      {
        id: 4001,
        key: "card-a",
        outcome: "success",
        artifacts: [{ id: 401, key: KEY, payload: balance(1000) }],
      },
      {
        id: 4002,
        key: "card-b",
        outcome: "failed",
        failureCode: "collector-failed",
        artifacts: [{ id: 402, key: KEY, payload: balance(2000) }],
      },
    ],
  });
  expect(
    await first<{ status: string; failure_count: number }>(
      "SELECT status,failure_count FROM observation_fetch_runs WHERE id=400",
    ),
  ).toEqual({ status: "partial", failure_count: 1 });
  await rescan();
  expect(await parsedArtifacts([401, 402])).toEqual([]);
  expect(
    await all(
      "SELECT fetch_artifact_id FROM observation_parse_jobs WHERE fetch_artifact_id IN (401,402)",
    ),
  ).toEqual([]);
}, 30000);

test("card A succeeds and card B fails: only A is parsed, and only A adopts", async () => {
  // A clean earlier run gives both cards a previous snapshot to keep or lose.
  await seedUnitRun(env, {
    id: 410,
    source: SOURCE,
    dataset: DATASET,
    runOutcome: "success",
    fetchedAtMs: Date.parse("2026-09-01T00:00:00.000Z"),
    units: [
      {
        id: 4101,
        key: "card-a",
        outcome: "success",
        artifacts: [{ id: 411, key: KEY, payload: balance(11) }],
      },
      {
        id: 4102,
        key: "card-b",
        outcome: "success",
        artifacts: [{ id: 412, key: KEY, payload: balance(12) }],
      },
    ],
  });
  await rescan();
  expect((await parsedArtifacts([411, 412])).map((row) => row.status)).toEqual(["ok", "ok"]);
  expect(await currentSnapshot("card-a")).toBe(411);
  expect(await currentSnapshot("card-b")).toBe(412);

  // The operator step: one dataset, one policy row.
  await setUnitScope(env, {
    sourceId: SOURCE,
    dataset: DATASET,
    parserName: PARSER,
    scope: "unit",
  });
  await rescan();

  // Card A of the partial run 400 is now parseable; card B is not.
  expect(await parsedArtifacts([401, 402])).toEqual([{ fetch_artifact_id: 401, status: "ok" }]);
  expect(await currentSnapshot("card-a")).toBe(401);
  expect(await currentSnapshot("card-b")).toBe(412);

  // The rescued claim records the partial parent and the unit's own outcome.
  expect(
    await first<Record<string, unknown>>(
      `SELECT c.unit_scope,c.unit_report_outcome,c.parent_run_status,c.parent_run_failure_count
       FROM parse_coverage_claims c JOIN parse_runs p ON p.id=c.parse_run_id
       WHERE p.fetch_artifact_id=401`,
    ),
  ).toEqual({
    unit_scope: "unit",
    unit_report_outcome: "success",
    parent_run_status: "partial",
    parent_run_failure_count: 1,
  });
  // The clean run's claims still say `run`.
  expect(
    await first<{ unit_scope: string; unit_report_outcome: string }>(
      `SELECT c.unit_scope,c.unit_report_outcome FROM parse_coverage_claims c
       JOIN parse_runs p ON p.id=c.parse_run_id WHERE p.fetch_artifact_id=411`,
    ),
  ).toEqual({ unit_scope: "run", unit_report_outcome: "success" });
}, 30000);

test("one page of a two-page unit is not a complete container", async () => {
  await seedUnitRun(env, {
    id: 420,
    source: SOURCE,
    dataset: DATASET,
    runOutcome: "partial",
    fetchedAtMs: Date.parse("2026-09-09T00:00:00.000Z"),
    units: [
      {
        id: 4201,
        key: "card-c",
        outcome: "success",
        artifacts: [
          { id: 421, key: "balance.normalized.json", payload: balance(31) },
          // A second page the parser cannot read: it stays without a parse.
          { id: 422, key: "balance.page2.json", payload: { unreadable: true } },
        ],
      },
    ],
  });
  await rescan();
  // Page 1 parsed; page 2 has no successful parse at all, so membership inside
  // the unit is incomplete and the unit adopts nothing. This is the half of
  // D13 that must NOT be relaxed: unit independence is not page independence.
  expect(await parsedArtifacts([421, 422])).toEqual([{ fetch_artifact_id: 421, status: "ok" }]);
  expect(await currentSnapshot("card-c")).toBeNull();

  // Completing the unit's second artifact is what makes the container current.
  const second = await first<{ id: number }>(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(422,?,'1.0.0','2026-09-09T00:00:00.000Z','ok','[]') RETURNING id`,
    PARSER,
  );
  await env.DB.batch(publicationStatements(env.DB, second!.id, "2026-09-09T00:00:00.000Z"));
  expect(await currentSnapshot("card-c")).toBe(422);
}, 30000);

test("the comparison route reports the eligibility scope of every policy row", async () => {
  const body = (await mf
    .dispatchFetch("https://pipeline.internal/snapshot-policy/compare")
    .then((r) => r.json())) as {
    policies: { parser_name: string; unit_scope: string; snapshot_selection: number }[];
  };
  expect(body.policies.find((row) => row.parser_name === PARSER)).toMatchObject({
    unit_scope: "unit",
    snapshot_selection: 1,
  });
  expect(body.policies.filter((row) => row.unit_scope === "unit")).toHaveLength(1);
}, 30000);

test("setting the policy row back to `run` restores the strict rule", async () => {
  await setUnitScope(env, {
    sourceId: SOURCE,
    dataset: DATASET,
    parserName: PARSER,
    scope: "run",
  });
  // Card A's rescued parse stays as history, but the strict rule no longer
  // admits the partial run's artifact, so the clean run's snapshot is current.
  expect(await currentSnapshot("card-a")).toBe(411);
  expect(await currentSnapshot("card-b")).toBe(412);
  expect(await parsedArtifacts([401])).toEqual([{ fetch_artifact_id: 401, status: "ok" }]);
  // A new partial run creates no jobs again.
  await seedUnitRun(env, {
    id: 430,
    source: SOURCE,
    dataset: DATASET,
    runOutcome: "partial",
    fetchedAtMs: Date.parse("2026-09-10T00:00:00.000Z"),
    units: [
      {
        id: 4301,
        key: "card-a",
        outcome: "success",
        artifacts: [{ id: 431, key: KEY, payload: balance(99) }],
      },
    ],
  });
  await rescan();
  expect(await parsedArtifacts([431])).toEqual([]);
}, 30000);
