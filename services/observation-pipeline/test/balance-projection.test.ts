// The bounded, resumable balance projection job (review D10/D11, addendum
// A07) on the production schema, including migration 0030 and every
// append-only trigger. Synthetic evidence only: no real account, balance or
// provider body appears here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { runBalanceProjection } from "../src/balance-projection-job.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
/** The job reads the flag from the environment; the harness binds none. */
const on = (): Env => ({ ...env, BALANCE_PROJECTION_ENABLED: "1" }) as Env;
const off = (): Env => ({ ...env, BALANCE_PROJECTION_ENABLED: "0" }) as Env;

beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

async function parse(artifactId: number, parser: string, version = "1"): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,?,?,'2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(artifactId, parser, version)
    .first<{ id: number }>();
  await publishParse(env.DB, row!.id);
  return row!.id;
}

async function balance(
  parseRunId: number,
  account: string,
  metric: string,
  amountMinor: number,
  asOf: string,
  locator = account + metric,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO balance_observations
       (parse_run_id,source_account,metric,instrument,amount_minor,as_of,observed_at,raw_locator,extra_json)
     VALUES (?,?,?,'JPY',?,?, '2026-09-07T00:00:00Z',?,'{}') RETURNING id`,
  )
    .bind(parseRunId, account, metric, amountMinor, asOf, locator)
    .first<{ id: number }>();
  return row!.id;
}

const count = async (sql: string, ...args: unknown[]): Promise<number> =>
  (await env.DB.prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;

test("the flag is off by default and the job writes nothing", async () => {
  const result = await runBalanceProjection(off());
  expect(result).toMatchObject({ enabled: false, status: "skipped", reasonCode: "flag_off" });
  expect(await count("SELECT count(*) AS n FROM balance_read_snapshots")).toBe(0);
  expect(await count("SELECT count(*) AS n FROM current_balance_projection")).toBe(0);
}, 30000);

test("a build seals one snapshot and records every candidate with its state", async () => {
  await seedArtifact(env, 101, "smbc-bank", "balance-normalized", "balances.json", {
    synthetic: true,
  });
  const run = await parse(101, "smbc-direct-balance");
  await balance(run, "smbc:ordinary", "account_balance", 60000, "2026-09-08");
  await balance(run, "smbc:savings", "account_balance", 100000, "2026-09-07");

  const result = await runBalanceProjection(on());
  expect(result).toMatchObject({ enabled: true, status: "complete", rowCount: 2 });
  expect(result.snapshotId).toMatch(/^[0-9a-f]{64}$/u);
  const rows = await env.DB.prepare(
    `SELECT scope_key,state,reason_code,metric_id,quantity_coefficient,unit_ref,row_seq,
            evidence_count,as_of_kind,freshness,latest_in_group
     FROM current_balance_projection WHERE snapshot_id=?1 ORDER BY row_seq`,
  )
    .bind(result.snapshotId)
    .all<Record<string, unknown>>();
  // Two distinct accounts of one bank: the provider listed them apart, so
  // both are adopted and neither is a possible duplicate of the other.
  expect(rows.results.map((row) => row.state)).toEqual(["adopted", "adopted"]);
  expect(rows.results.map((row) => row.metric_id)).toEqual(["deposit.balance", "deposit.balance"]);
  // Ordered by effective time descending, position dense from zero.
  expect(rows.results.map((row) => row.quantity_coefficient)).toEqual(["60000", "100000"]);
  expect(rows.results.map((row) => row.row_seq)).toEqual([0, 1]);
  expect(rows.results.every((row) => row.evidence_count === 1)).toBe(true);
  expect(rows.results.every((row) => row.as_of_kind === "local-date")).toBe(true);
  expect(rows.results.every((row) => row.freshness === "current")).toBe(true);
  expect(rows.results.every((row) => row.latest_in_group === 1)).toBe(true);
  // Sealed exactly once, and readable only as a complete snapshot.
  expect(
    await count("SELECT count(*) AS n FROM balance_read_snapshots WHERE status='complete'"),
  ).toBe(1);
}, 60000);

test("the same inputs rebuild to the same snapshot id and do no work twice", async () => {
  const first = await runBalanceProjection(on());
  expect(first.status).toBe("unchanged");
  expect(first.written).toBe(0);
  const second = await runBalanceProjection(on());
  expect(second.snapshotId).toBe(first.snapshotId);
  expect(await count("SELECT count(*) AS n FROM balance_read_snapshots")).toBe(1);
}, 30000);

test("a sealed snapshot is immutable and its rows cannot be edited or deleted", async () => {
  const snapshot = await env.DB.prepare(
    "SELECT snapshot_id FROM balance_read_snapshots WHERE status='complete' LIMIT 1",
  ).first<{ snapshot_id: string }>();
  await expect(
    env.DB.prepare("UPDATE current_balance_projection SET state='adopted' WHERE snapshot_id=?1")
      .bind(snapshot!.snapshot_id)
      .run(),
  ).rejects.toThrow(/sealed balance snapshot is immutable/u);
  await expect(
    env.DB.prepare("DELETE FROM current_balance_projection WHERE snapshot_id=?1")
      .bind(snapshot!.snapshot_id)
      .run(),
  ).rejects.toThrow(/retire the snapshot/u);
  // A complete snapshot never goes back to building.
  await expect(
    env.DB.prepare("UPDATE balance_read_snapshots SET status='building' WHERE snapshot_id=?1")
      .bind(snapshot!.snapshot_id)
      .run(),
  ).rejects.toThrow(/invalid balance snapshot transition/u);
}, 30000);

test("a new publication makes a new snapshot and retires the oldest builds", async () => {
  await seedArtifact(env, 102, "sony-bank", "gross-balance", "balances-2.json", {
    synthetic: true,
  });
  const run = await parse(102, "sony-bank-gross-balance");
  await balance(run, "sony:gross", "gross_asset_balance", 5000, "2026-09-09");
  const second = await runBalanceProjection(on());
  expect(second.status).toBe("complete");
  expect(second.rowCount).toBe(3);

  await seedArtifact(env, 103, "smbc-bank", "balance-normalized", "balances-3.json", {
    synthetic: true,
  });
  const third = await parse(103, "smbc-direct-balance");
  await balance(third, "smbc:third", "account_balance", 1, "2026-09-10");
  const latest = await runBalanceProjection(on());
  expect(latest.status).toBe("complete");
  expect(latest.snapshotId).not.toBe(second.snapshotId);
  // The retained window keeps one previous build so an open cursor survives;
  // anything older is retired first and only then loses its rows.
  expect(
    await count("SELECT count(*) AS n FROM balance_read_snapshots WHERE status='complete'"),
  ).toBeLessThanOrEqual(2);
  const retired = await env.DB.prepare(
    "SELECT snapshot_id FROM balance_read_snapshots WHERE status='retired'",
  ).all<{ snapshot_id: string }>();
  for (const row of retired.results)
    expect(
      await count(
        "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
        row.snapshot_id,
      ),
    ).toBe(0);
}, 60000);

test("a build is bounded per invocation and resumes from its cursor", async () => {
  await seedArtifact(env, 104, "smbc-bank", "balance-normalized", "balances-4.json", {
    synthetic: true,
  });
  const run = await parse(104, "smbc-direct-balance");
  for (let index = 0; index < 6; index += 1)
    await balance(run, `smbc:bounded-${String(index)}`, "account_balance", index + 1, "2026-09-11");

  const first = await runBalanceProjection(on(), { writeBudget: 2 });
  expect(first.status).toBe("building");
  expect(first.written).toBe(2);
  // A building snapshot is never a read target: it has no sealed_at.
  expect(
    await count(
      "SELECT count(*) AS n FROM balance_read_snapshots WHERE snapshot_id=?1 AND status='building' AND sealed_at IS NULL",
      first.snapshotId!,
    ),
  ).toBe(1);
  let result = first;
  for (let step = 0; step < 10 && result.status === "building"; step += 1)
    result = await runBalanceProjection(on(), { writeBudget: 2 });
  expect(result.status).toBe("complete");
  expect(result.snapshotId).toBe(first.snapshotId);
  expect(
    await count(
      "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
      result.snapshotId!,
    ),
  ).toBe(result.rowCount);
}, 60000);
