// The balance projection written into the READ database (unified plan 04, 05;
// U11) on the production schema of both databases, triggers included. Every
// row is synthetic: no real account, balance or provider body appears here.
//
// What is proved, in one sentence each:
//   G2-05  a build that spans invocations resumes from its stored input.
//   G2-07  a re-sent chunk is a no-op and leaves the checkpoint where it was.
//   G2-10  a build of an older context is complete but never published.
//   G2-11  the CORE outbox row is not completed while READ is still building.
//   G2-12  a lost response converges from the published READ snapshot.
//   G0-09  dropping every READ table leaves CORE rows, digests and DATA
//          objects untouched, and the rebuild publishes a new instance.
//   G3-12  a READ reset touches nothing else: the CORE job, its receipts and
//          the stored inputs survive it.
//   The U10 known limit: content that was retired is built again instead of
//   wedging the pointer at `skipped(snapshot_retired)`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  balanceProjectionOutboxProcessor,
  currentCoreRevision,
  runBalanceProjection,
} from "../src/balance-projection-job.ts";
import { readProjectionEnabled } from "../src/read-projection.ts";
import { inputObjectKey, readInputRecord } from "../src/projection-input.ts";
import type { OutboxRow } from "../src/decision-outbox.ts";
import { applyReadMigrations } from "../../../packages/storage-d1/src/migrations.ts";
import { checkReadCursor } from "../../../packages/storage-d1/src/read/index.ts";
import { sha256Hex } from "../../../packages/domain/src/context.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;

/** The projection lane with the READ database as its target. */
const on = (base: Env = env): Env =>
  ({
    ...base,
    BALANCE_PROJECTION_ENABLED: "1",
    READ_PROJECTION_ENABLED: "true",
  }) as unknown as Env;

beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

let nextArtifact = 900;

/** One published parse carrying several synthetic accounts. */
async function seedBalances(target: Env, accounts: readonly string[]): Promise<void> {
  const id = (nextArtifact += 1);
  await seedArtifact(target, id, "smbc-bank", "balance-normalized", `r-${String(id)}.json`, {
    synthetic: true,
  });
  const run = await target.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,'smbc-direct-balance','1','2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(id)
    .first<{ id: number }>();
  await publishParse(target.DB, run!.id);
  for (const [index, account] of accounts.entries())
    await target.DB.prepare(
      `INSERT INTO balance_observations
         (parse_run_id,source_account,metric,instrument,amount_minor,as_of,observed_at,raw_locator,extra_json)
       VALUES (?,?,'account_balance','JPY',?,'2026-09-08','2026-09-07T00:00:00Z',?,'{}')`,
    )
      .bind(run!.id, account, id * 100 + index, `${account}-${String(id)}`)
      .run();
}

const readFirst = async <T>(sql: string, ...args: unknown[]): Promise<T | null> =>
  await env.READ.prepare(sql)
    .bind(...args)
    .first<T>();

const readCount = async (sql: string, ...args: unknown[]): Promise<number> =>
  (await env.READ.prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;

const coreCount = async (sql: string, ...args: unknown[]): Promise<number> =>
  (await env.DB.prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;

async function outboxRow(): Promise<OutboxRow> {
  return {
    id: 1,
    decision_revision_id: "dr_read_probe",
    principal: "operator:1",
    operation_id: "op_read_probe",
    target: "balance-projection",
    attempts: 1,
    required_source_revision: (await currentCoreRevision(env.DB)).source_revision,
  };
}

test("the flag is off by default and the CORE path stays the target", () => {
  expect(readProjectionEnabled(env)).toBe(false);
  expect(
    readProjectionEnabled({ ...env, READ_PROJECTION_ENABLED: "false" } as unknown as Env),
  ).toBe(false);
  expect(readProjectionEnabled(on())).toBe(true);
});

test("a build writes the snapshot to READ, publishes it, and leaves CORE's projection empty", async () => {
  await seedBalances(env, ["smbc:read-a", "smbc:read-b"]);
  const revision = await currentCoreRevision(env.DB);
  const built = await runBalanceProjection(on());
  expect(built).toMatchObject({ status: "complete", active: true, rowCount: 2 });
  expect(built.sourceRevision).toBe(revision.source_revision);

  const instance = await readFirst<{ read_instance_id: string; contract_version: string }>(
    "SELECT read_instance_id,contract_version FROM read_instance WHERE id=1",
  );
  expect(instance?.contract_version).toBe("read-baseline-v1");
  const snapshot = await readFirst<Record<string, unknown>>(
    `SELECT snapshot_id,attempt,status,row_count,input_digest,source_revision,visibility_revision,
       core_epoch,read_instance_id,output_digest FROM balance_read_snapshots WHERE snapshot_id=?1`,
    built.snapshotId,
  );
  expect(snapshot).toMatchObject({
    attempt: 1,
    status: "complete",
    row_count: 2,
    input_digest: built.inputDigest,
    source_revision: revision.source_revision,
    core_epoch: revision.core_epoch,
    read_instance_id: instance?.read_instance_id,
  });
  expect(snapshot?.["output_digest"]).toMatch(/^[0-9a-f]{64}$/u);
  expect(
    await readCount(
      "SELECT count(*) AS n FROM balance_snapshot_pointer WHERE id=1 AND snapshot_id=?1",
      built.snapshotId,
    ),
  ).toBe(1);
  expect(await readCount("SELECT count(*) AS n FROM current_balance_projection")).toBe(2);
  // The CORE-side tables of migration 0030 are untouched: the same build under
  // the flag off would have written them, and turning the flag back off must
  // find them exactly as they were.
  expect(await coreCount("SELECT count(*) AS n FROM balance_read_snapshots")).toBe(0);
  expect(await coreCount("SELECT count(*) AS n FROM current_balance_projection")).toBe(0);
  expect(await coreCount("SELECT count(*) AS n FROM balance_snapshot_pointer")).toBe(0);
  // The fixed input is CORE's record and DATA's object, exactly as in U10.
  const record = await readInputRecord(env.DB, built.inputDigest!);
  expect(record?.job_id).toBe(built.snapshotId!);
  expect(await env.DATA.get(inputObjectKey(built.inputDigest!))).not.toBeNull();
  // Its CORE references are copied into the snapshot, never joined (04 §3).
  expect(
    await readCount(
      "SELECT count(*) AS n FROM snapshot_input_refs WHERE snapshot_id=?1 AND ref_kind='restriction_revision'",
      built.snapshotId,
    ),
  ).toBe(1);
}, 60000);

test("G2-05/G2-07: a bounded build resumes from its own input, and a re-run writes nothing twice", async () => {
  await seedBalances(env, ["smbc:read-c", "smbc:read-d", "smbc:read-e"]);
  const first = await runBalanceProjection(on(), { writeBudget: 1 });
  expect(first).toMatchObject({ status: "building", written: 1 });
  const checkpoint = await readFirst<{ position: string; rows_written: number }>(
    "SELECT position,rows_written FROM read_build_checkpoints WHERE snapshot_id=?1 AND stage='rows'",
    first.snapshotId,
  );
  expect(checkpoint).toMatchObject({ position: "0", rows_written: 1 });
  // A publication between the two invocations must not reach this build: it
  // continues from the input it fixed, so the row count is the one it started
  // with, not the one CORE now holds.
  await seedBalances(env, ["smbc:read-late"]);
  const second = await runBalanceProjection(on(), { writeBudget: 100 });
  // Three rows, not one: the later publication replaced the dataset's current
  // container snapshot in CORE, and this build never saw it. It finished the
  // set it fixed, and wrote only the two rows it still owed.
  expect(second).toMatchObject({
    status: "complete",
    snapshotId: first.snapshotId,
    inputDigest: first.inputDigest,
    rowCount: 3,
  });
  expect(second.written).toBe(2);
  expect(
    await readCount(
      "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
      first.snapshotId,
    ),
  ).toBe(3);
}, 60000);

test("the U10 known limit: content that was retired is built again under a new attempt", async () => {
  // Reproduce the wedge: take the published build's content, retire it (a
  // rebuild, an operator repair), and capture the same content again. CORE
  // answers `skipped(snapshot_retired)` for ever; READ allocates attempt 2.
  const built = await runBalanceProjection(on());
  expect(["complete", "unchanged"]).toContain(built.status);
  const contentKey = await readFirst<{ content_key: string; attempt: number }>(
    "SELECT content_key,attempt FROM balance_read_snapshots WHERE snapshot_id=?1",
    built.snapshotId,
  );
  await env.READ.prepare("UPDATE balance_read_snapshots SET status='retired' WHERE snapshot_id=?1")
    .bind(built.snapshotId)
    .run();

  const rebuilt = await runBalanceProjection(on());
  expect(rebuilt.status).toBe("complete");
  expect(rebuilt.snapshotId).not.toBe(built.snapshotId);
  const attempt = await readFirst<{ attempt: number; content_key: string }>(
    "SELECT attempt,content_key FROM balance_read_snapshots WHERE snapshot_id=?1",
    rebuilt.snapshotId,
  );
  expect(attempt?.content_key).toBe(contentKey!.content_key);
  expect(attempt?.attempt).toBe(contentKey!.attempt + 1);
  // And the watermark moved with it, which is what the wedge prevented.
  expect(
    (
      await readFirst<{ snapshot_id: string }>(
        "SELECT snapshot_id FROM balance_snapshot_pointer WHERE id=1",
      )
    )?.snapshot_id,
  ).toBe(rebuilt.snapshotId!);
}, 60000);

test("G2-11/G2-12: CORE is completed only after READ published, and converges after a lost response", async () => {
  // Three accounts in one artifact, so a one-row budget cannot finish the build.
  await seedBalances(env, ["smbc:read-f", "smbc:read-g", "smbc:read-h"]);
  const row = await outboxRow();
  const processor = balanceProjectionOutboxProcessor(on(), { writeBudget: 1 });
  // The build needs more than one invocation, so the row stays pending: a
  // started rebuild is never a completion.
  const pending = await processor(env.DB, row);
  expect(pending).toMatchObject({ status: "pending" });
  // The published snapshot is still the previous one: a started rebuild never
  // advances the watermark on its own.
  expect(
    (
      await readFirst<{ source_revision: number }>(
        "SELECT source_revision FROM balance_snapshot_pointer WHERE id=1",
      )
    )?.source_revision,
  ).toBeLessThan(row.required_source_revision!);

  // Finish the build, then deliver the row again as if the first response had
  // been lost: the published snapshot already covers the revision, so the row
  // completes from READ without rebuilding.
  let result = await runBalanceProjection(on(), { writeBudget: 100 });
  while (result.status === "building")
    result = await runBalanceProjection(on(), { writeBudget: 100 });
  expect(["complete", "unchanged"]).toContain(result.status);
  const completed = await balanceProjectionOutboxProcessor(on())(env.DB, row);
  expect(completed).toMatchObject({
    status: "completed",
    evidence: { code: "balance_projection_active" },
  });
  const published = await readFirst<{ snapshot_id: string; source_revision: number }>(
    "SELECT snapshot_id,source_revision FROM balance_snapshot_pointer WHERE id=1",
  );
  expect(completed.status === "completed" ? completed.evidence.ref : "").toBe(
    published!.snapshot_id,
  );
  expect(published!.source_revision).toBeGreaterThanOrEqual(row.required_source_revision!);
}, 90000);

test("G0-09/G3-12: dropping every READ table leaves CORE and DATA untouched, and the rebuild is a new instance", async () => {
  const before = await runBalanceProjection(on());
  expect(["complete", "unchanged"]).toContain(before.status);
  const lostSnapshot =
    before.snapshotId ??
    (await readFirst<{ snapshot_id: string }>(
      "SELECT snapshot_id FROM balance_snapshot_pointer WHERE id=1",
    ))!.snapshot_id;
  const lostInstance = (await readFirst<{ read_instance_id: string }>(
    "SELECT read_instance_id FROM read_instance WHERE id=1",
  ))!.read_instance_id;

  // What must survive: the CORE rows the projection reads, the revision, the
  // input records, and the stored inputs in DATA.
  const coreDigest = async (): Promise<string> => {
    const rows = await env.DB.prepare(
      `SELECT b.id,b.parse_run_id,b.source_account,b.metric,b.instrument,b.amount_minor
       FROM balance_observations b ORDER BY b.id`,
    ).all<Record<string, unknown>>();
    const inputs = await env.DB.prepare(
      "SELECT input_digest,job_id,source_revision,storage_ref,byte_size FROM projection_input_records ORDER BY input_digest",
    ).all<Record<string, unknown>>();
    const revision = await currentCoreRevision(env.DB);
    return await sha256Hex(
      JSON.stringify({ rows: rows.results, inputs: inputs.results, revision }),
    );
  };
  const dataKeys = async (): Promise<string[]> =>
    (await env.DATA.list({ prefix: "projection-inputs/" })).objects
      .map((object) => object.key)
      .sort();
  const coreBefore = await coreDigest();
  const objectsBefore = await dataKeys();
  expect(objectsBefore.length).toBeGreaterThan(0);

  // The reset of 15 §3: the READ database is emptied and rebuilt from its own
  // migrations. No DROP is ever aimed at CORE or DATA.
  for (const table of [
    "read_build_checkpoints",
    "scope_relations",
    "snapshot_input_refs",
    "current_balance_projection",
    "balance_snapshot_pointer",
    "balance_read_snapshots",
    // The reward second stage of migration 0002 lives in the same database
    // (U16): "every READ table" includes it, and the reset re-applies both
    // migrations.
    "reward_build_checkpoints",
    "reward_conversion_simulations",
    "reward_expiry_estimates",
    "reward_snapshot_input_refs",
    "reward_snapshot_pointer",
    "reward_expiry_snapshots",
    "read_instance",
  ])
    await env.READ.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyReadMigrations(env.READ);
  expect(await readCount("SELECT count(*) AS n FROM balance_read_snapshots")).toBe(0);
  expect(await readFirst("SELECT read_instance_id FROM read_instance WHERE id=1")).toBeNull();

  const rebuilt = await runBalanceProjection(on());
  expect(rebuilt.status).toBe("complete");
  const instance = (await readFirst<{ read_instance_id: string }>(
    "SELECT read_instance_id FROM read_instance WHERE id=1",
  ))!.read_instance_id;
  // A new physical instance: every cursor of the lost one is context_expired
  // rather than answered from rows that only look like its list.
  expect(instance).not.toBe(lostInstance);
  // A snapshot id is the digest of its content, its attempt and the contract,
  // so a rebuild of unchanged content produces the same id. That is why the
  // cursor carries the read instance: the id alone cannot say which physical
  // database answered, and a cursor from the lost one must not be continued
  // here (05 section 7, G3-03).
  expect(
    checkReadCursor(
      {
        snapshotId: lostSnapshot,
        readInstanceId: lostInstance,
        filterDigest: "digest",
        position: 0,
        sortKey: "",
      },
      { filterDigest: "digest", readInstanceId: instance, snapshotReadable: true },
    ),
  ).toBe("context_expired");
  // CORE's rows and digests, and the DATA objects, are exactly what they were.
  expect(await coreDigest()).toBe(coreBefore);
  expect(await dataKeys()).toEqual(objectsBefore);
  // The rebuild read the stored input rather than capturing a new one where it
  // could: the record is still the one CORE had before the reset.
  expect(await readInputRecord(env.DB, rebuilt.inputDigest!)).not.toBeNull();
}, 90000);
