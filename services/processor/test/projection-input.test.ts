// The fixed projection input and the completion contract (unified plan 05,
// migration 0038; acceptance G2-02, G2-05 .. G2-14) on the production schema,
// triggers included. Every row is synthetic: no real account, balance or
// provider body appears here.
//
// What is proved, in one sentence each:
//   G2-02  a write during the capture discards the mixed input, bounded.
//   G2-05  a build that spans invocations resumes from its stored input.
//   G2-06  a budget overflow refuses the build instead of truncating it.
//   G2-07  a re-sent chunk is a no-op, and different content is a conflict.
//   G2-08  a failing chunk rolls back its checkpoint with it.
//   G2-09  a writer that lost the lease cannot seal or publish.
//   G2-10  the active pointer never moves back to an older revision.
//   G2-11  the CORE side is not completed before the read model is.
//   G2-12  a lost response converges without rebuilding or re-consuming.
//   G2-13  building, a flag that is off and a missing processor never complete.
//   G2-14  a guard that matches no row leaves nothing half-written.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  balanceProjectionOutboxProcessor,
  currentCoreRevision,
  runBalanceProjection,
} from "../src/balance-projection-job.ts";
import { dispatchDecisionOutbox, type OutboxRow } from "../src/decision-outbox.ts";
import { inputObjectKey, readInputRecord } from "../src/projection-input.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
const on = (base: Env = env): Env =>
  ({ ...base, BALANCE_PROJECTION_ENABLED: "1" }) as unknown as Env;
const off = (base: Env = env): Env =>
  ({ ...base, BALANCE_PROJECTION_ENABLED: "0" }) as unknown as Env;

/**
 * A second store, for the two cases that must not be mixed with the shared
 * one: a chunk conflict leaves a build tampered with, and a relation set over
 * its budget cannot be removed again (entity relations are append-only). One
 * instance is shared by both, in declaration order, so the suite runs two
 * Workers rather than three.
 */
let extra: { mf: Miniflare; env: Env } | null = null;
const extraPipeline = async (): Promise<Env> => {
  extra ??= await startPipeline();
  return extra.env;
};

beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
  await extra?.mf.dispose();
});

let nextArtifact = 500;
let nextDecision = 0;

/**
 * One published parse carrying several accounts.
 *
 * All of them go through one artifact on purpose: the dataset's newest
 * successful run is its current container snapshot, so a second artifact of
 * the same dataset replaces the earlier one's candidates rather than adding to
 * them. Amounts are distinct on purpose too: two witnesses reporting identical
 * minor units and identical raw text are one measurement, and would bundle
 * into a single projection row.
 */
async function seedBalances(target: Env, accounts: readonly string[]): Promise<void> {
  const id = (nextArtifact += 1);
  await seedArtifact(target, id, "smbc-bank", "balance-normalized", `b-${String(id)}.json`, {
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

/** An accepted judgement, the way a committed command records one. */
async function seedDecision(target: Env = env): Promise<string> {
  const id = `dr_input_${String((nextDecision += 1))}`;
  await target.DB.prepare(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,
      actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?1,'relation',?1,1,'accept','manual','operator:1',NULL,
      'Synthetic: the two routes report one account.','[]',NULL,NULL,'2026-09-12T00:00:00Z')`,
  )
    .bind(id)
    .run();
  return id;
}

const count = async (sql: string, ...args: unknown[]): Promise<number> =>
  (await (
    /\b(balance_read_snapshots|current_balance_projection|scope_relations|balance_snapshot_pointer)\b/u.test(
      sql,
    )
      ? env.READ
      : env.DB
  )
    .prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;

const pointer = async (target: Env = env) =>
  await target.READ.prepare(
    "SELECT snapshot_id,source_revision FROM balance_snapshot_pointer WHERE id=1",
  ).first<{ snapshot_id: string; source_revision: number }>();

async function outboxRow(target: Env = env): Promise<OutboxRow> {
  return {
    id: 1,
    decision_revision_id: "dr_probe",
    principal: "operator:1",
    operation_id: "op_probe",
    target: "balance-projection",
    attempts: 1,
    required_source_revision: (await currentCoreRevision(target.DB)).source_revision,
  };
}

test("D1 counts the revision bump in meta.changes: one ledger row is two changes, a checkpoint row is one", async () => {
  // Why this is pinned down here: workerd's `meta.changes` is the number of
  // rows the statement wrote *including* rows written by triggers, and since
  // migration 0038 every write to a dependency-ledger table also writes the
  // revision row. A guard that expects exactly one change on a ledger table
  // would therefore never match again, and a business count derived from
  // `meta.changes` on one would be doubled. Nothing in services/** or
  // packages/** does either (the three counting sites use RETURNING), and
  // this test is what a reader should find when wondering why.
  const before = await currentCoreRevision(env.DB);
  const ledger = await env.DB.prepare(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,
      actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES('dr_changes_probe','relation','dr_changes_probe',1,'accept','manual','operator:1',NULL,
      'Synthetic: counting probe.','[]',NULL,NULL,'2026-09-12T00:00:00Z')`,
  ).run();
  const after = await currentCoreRevision(env.DB);
  expect(after.source_revision).toBe(before.source_revision + 1);
  expect(ledger.meta.changes).toBe(2);
  expect(
    await count("SELECT count(*) AS n FROM decision_revisions WHERE id='dr_changes_probe'"),
  ).toBe(1);
  // A table outside the ledger writes one row and reports one change; its
  // triggers only guard, they never write.
  const checkpoint = await env.DB.prepare(
    "UPDATE observation_scan_state SET cursor=cursor WHERE id=1",
  ).run();
  expect(checkpoint.meta.changes).toBe(1);
  expect((await currentCoreRevision(env.DB)).source_revision).toBe(after.source_revision);
}, 60000);

test("G2-03: sealing a Layer A run moves the revision, and the first build records its input", async () => {
  const before = await currentCoreRevision(env.DB);
  await seedBalances(env, ["smbc:input-a"]);
  const after = await currentCoreRevision(env.DB);
  // Sealing the run, publishing the parse and writing the observation are all
  // in the dependency ledger of migration 0038.
  expect(after.source_revision).toBeGreaterThan(before.source_revision);

  const built = await runBalanceProjection(on());
  expect(built).toMatchObject({ status: "complete", active: true, rowCount: 1 });
  expect(built.sourceRevision).toBe(after.source_revision);
  expect(built.inputDigest).toMatch(/^[0-9a-f]{64}$/u);
  // The snapshot carries its identity, and the pointer publishes it.
  const snapshot = await env.READ.prepare(
    "SELECT input_digest,source_revision,core_epoch,read_instance_id FROM balance_read_snapshots WHERE snapshot_id=?1",
  )
    .bind(built.snapshotId)
    .first<Record<string, unknown>>();
  expect(snapshot).toMatchObject({
    input_digest: built.inputDigest,
    source_revision: after.source_revision,
    core_epoch: after.core_epoch,
    read_instance_id: expect.any(String),
  });
  expect((await pointer())?.snapshot_id).toBe(built.snapshotId!);
}, 60000);

test("G2-02: a write during the capture discards the mixed input and retries, bounded", async () => {
  let landed = 0;
  // A decision lands between the two revision reads of the first attempt. That
  // input mixes two contexts, so it is discarded; the second attempt reads a
  // store that holds still and is accepted.
  const result = await runBalanceProjection(on(), {
    duringCapture: async (attempt) => {
      if (attempt === 1) {
        landed += 1;
        await seedDecision();
      }
    },
  });
  expect(landed).toBe(1);
  expect(result.status).toBe("complete");
  const revision = await currentCoreRevision(env.DB);
  // The accepted input is the one taken after the write, never a mixture.
  expect(result.sourceRevision).toBe(revision.source_revision);

  // A store that never holds still is not retried for ever: the job yields
  // `pending` with a progress code and seals nothing.
  const snapshots = await count("SELECT count(*) AS n FROM balance_read_snapshots");
  const unstable = await runBalanceProjection(on(), {
    duringCapture: async () => {
      await seedDecision();
    },
  });
  expect(unstable).toMatchObject({ status: "pending", reasonCode: "input_capture_unstable" });
  expect(await count("SELECT count(*) AS n FROM balance_read_snapshots")).toBe(snapshots);
  // Its outbox result is pending, never completed.
  expect(
    await balanceProjectionOutboxProcessor(on(), {
      duringCapture: async () => {
        await seedDecision();
      },
    })(env.DB, await outboxRow()),
  ).toEqual({ status: "pending", progress: "input_capture_unstable" });
}, 60000);

test("G2-05: a build that spans invocations resumes from its stored input, not from CORE", async () => {
  await seedBalances(env, ["smbc:span-1", "smbc:span-2", "smbc:span-3", "smbc:span-4"]);
  const first = await runBalanceProjection(on(), { writeBudget: 2 });
  expect(first.status).toBe("building");
  expect(first.written).toBe(2);

  // The input exists, is recorded, and hashes to what the record names.
  const record = await readInputRecord(env.DB, first.inputDigest!);
  expect(record).toMatchObject({
    input_digest: first.inputDigest!,
    job_id: first.snapshotId!,
    storage_ref: `projection-inputs/${first.inputDigest!}`,
    source_revision: first.sourceRevision!,
  });
  const stored = await env.DATA.get(inputObjectKey(first.inputDigest!));
  expect(stored).not.toBeNull();
  const input = JSON.parse(await stored!.text()) as {
    sourceRevision: number;
    content: { candidates: unknown[] };
  };
  expect(input.sourceRevision).toBe(first.sourceRevision!);
  const capturedCandidates = input.content.candidates.length;

  // CORE moves while the build is unfinished: new evidence is published.
  await seedBalances(env, ["smbc:span-late"]);
  expect((await currentCoreRevision(env.DB)).source_revision).toBeGreaterThan(
    first.sourceRevision!,
  );

  let result = first;
  for (let step = 0; step < 10 && result.status === "building"; step += 1)
    result = await runBalanceProjection(on(), { writeBudget: 2 });
  // The same snapshot, the same input, the same revision: the resumed
  // invocations never re-read CORE's current state.
  expect(result.status).toBe("complete");
  expect(result.snapshotId).toBe(first.snapshotId);
  expect(result.inputDigest).toBe(first.inputDigest);
  expect(result.sourceRevision).toBe(first.sourceRevision);
  expect(result.rowCount).toBe(capturedCandidates);
  expect(
    await count(
      "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1 AND source_account='smbc:span-late'",
      result.snapshotId!,
    ),
  ).toBe(0);
  // The evidence that landed mid-build is picked up by the next build, which
  // captures its own input.
  const next = await runBalanceProjection(on());
  expect(next.status).toBe("complete");
  expect(next.snapshotId).not.toBe(result.snapshotId);
  expect(
    await count(
      "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1 AND source_account='smbc:span-late'",
      next.snapshotId!,
    ),
  ).toBe(1);
}, 120000);

test("G2-05: the same input under a new build digest builds a new snapshot from the shared record", async () => {
  // A deploy that changes what the code makes of an input changes the build
  // digest and therefore the snapshot id, while the input digest is the same.
  // The input record is per input, so the second build shares it rather than
  // colliding with it, and resumes through its own snapshot's input digest.
  await seedBalances(env, ["smbc:redeploy-1", "smbc:redeploy-2", "smbc:redeploy-3"]);
  const current = await runBalanceProjection(on());
  expect(current).toMatchObject({ status: "complete", rowCount: 3 });
  const records = await count("SELECT count(*) AS n FROM projection_input_records");
  const redeployed = await runBalanceProjection(on(), {
    buildDigest: "f".repeat(64),
    writeBudget: 1,
  });
  expect(redeployed.status).toBe("building");
  expect(redeployed.snapshotId).not.toBe(current.snapshotId);
  expect(redeployed.inputDigest).toBe(current.inputDigest);
  expect(await count("SELECT count(*) AS n FROM projection_input_records")).toBe(records);
  let result = redeployed;
  for (let step = 0; step < 20 && result.status === "building"; step += 1)
    result = await runBalanceProjection(on(), { buildDigest: "f".repeat(64), writeBudget: 1 });
  expect(result).toMatchObject({
    status: "complete",
    snapshotId: redeployed.snapshotId,
    inputDigest: current.inputDigest,
  });
  expect(
    await env.READ.prepare("SELECT input_digest FROM balance_read_snapshots WHERE snapshot_id=?1")
      .bind(redeployed.snapshotId)
      .first<{ input_digest: string }>(),
  ).toEqual({ input_digest: current.inputDigest! });

  // The stored object is gone but the record stands: a third build of the same
  // input writes the bytes back under the record's pin, and proves them again.
  await env.DATA.delete(inputObjectKey(current.inputDigest!));
  const restored = await runBalanceProjection(on(), { buildDigest: "e".repeat(64) });
  expect(restored).toMatchObject({ status: "complete", inputDigest: current.inputDigest });
  const record = await readInputRecord(env.DB, current.inputDigest!);
  const object = await env.DATA.get(inputObjectKey(current.inputDigest!));
  expect(JSON.parse(await object!.text()) as Record<string, unknown>).toMatchObject({
    sourceRevision: record!.source_revision,
    coreEpoch: record!.core_epoch,
  });
}, 120000);

test("G2-09/G2-14: a writer that lost the lease seals nothing and leaves nothing half-written", async () => {
  await seedBalances(env, ["smbc:fence-1", "smbc:fence-2", "smbc:fence-3"]);
  const partial = await runBalanceProjection(on(), { writeBudget: 1, writerToken: "writer-a" });
  expect(partial.status).toBe("building");
  const before = await pointer();
  const rows = await count(
    "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
    partial.snapshotId!,
  );

  // Another writer takes the build over with a live lease.
  await env.READ.prepare(
    `UPDATE balance_read_snapshots SET writer_lease='writer-b',writer_lease_until_ms=?2,
      writer_fence=writer_fence+1 WHERE snapshot_id=?1`,
  )
    .bind(partial.snapshotId, Date.now() + 60_000)
    .run();

  // The displaced writer comes back. Its claim matches no row, so it writes
  // nothing at all: no row, no checkpoint, no seal, no pointer switch.
  const fenced = await runBalanceProjection(on(), { writeBudget: 100, writerToken: "writer-a" });
  expect(fenced).toMatchObject({ status: "retryable", reasonCode: "writer_lease_unavailable" });
  expect(
    await count(
      "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
      partial.snapshotId!,
    ),
  ).toBe(rows);
  expect(
    await count(
      "SELECT count(*) AS n FROM balance_read_snapshots WHERE snapshot_id=?1 AND status='building'",
      partial.snapshotId!,
    ),
  ).toBe(1);
  expect(await pointer()).toEqual(before);
  // Its outbox result is retryable, never completed.
  expect(
    await balanceProjectionOutboxProcessor(on(), {
      writeBudget: 100,
      writerToken: "writer-a",
    })(env.DB, await outboxRow()),
  ).toMatchObject({ status: "retryable" });

  // The holder finishes the build, and only then is the snapshot published.
  const finished = await runBalanceProjection(on(), { writerToken: "writer-b" });
  expect(finished).toMatchObject({ status: "complete", active: true });
  expect((await pointer())?.snapshot_id).toBe(finished.snapshotId!);
}, 120000);

// READ pointer fencing is covered by read-projection.test.ts and storage-d1/read tests.

test("G2-07/G2-08: a re-sent chunk is a no-op or a conflict, and a failing chunk rolls back its checkpoint", async () => {
  const local = { env: await extraPipeline() };
  {
    await seedBalances(local.env, ["smbc:chunk-a", "smbc:chunk-b", "smbc:chunk-c", "smbc:chunk-d"]);
    const first = await runBalanceProjection(on(local.env), { writeBudget: 2 });
    expect(first.status).toBe("building");
    const written = await local.env.READ.prepare(
      "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
    )
      .bind(first.snapshotId)
      .first<{ n: number }>();

    // Re-send the same chunk: the checkpoint is rewound, so the next
    // invocation writes exactly the rows that are already there. Same content,
    // so nothing changes and the build carries on.
    const rewind = local.env.READ.prepare(
      "DELETE FROM read_build_checkpoints WHERE snapshot_id=?1 AND stage='rows'",
    ).bind(first.snapshotId);
    await rewind.run();
    const resent = await runBalanceProjection(on(local.env), { writeBudget: 2 });
    expect(resent.status).toBe("building");
    expect(
      await local.env.READ.prepare(
        "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
      )
        .bind(first.snapshotId)
        .first<{ n: number }>(),
    ).toEqual(written!);

    // Different content for a row that already exists is a conflict, not a row
    // quietly kept out by INSERT OR IGNORE.
    await local.env.READ.prepare(
      "UPDATE current_balance_projection SET row_digest='0000000000000000000000000000000000000000000000000000000000000000' WHERE snapshot_id=?1 AND row_seq=0",
    )
      .bind(first.snapshotId)
      .run();
    await rewind.run();
    const cursorBefore = await local.env.READ.prepare(
      "SELECT position FROM read_build_checkpoints WHERE snapshot_id=?1 AND stage='rows'",
    )
      .bind(first.snapshotId)
      .first<{ position: string | null }>();
    await expect(runBalanceProjection(on(local.env), { writeBudget: 2 })).rejects.toThrow(
      /projection chunk conflict/u,
    );
    // G2-08: the chunk and its checkpoint are one batch, so the failure rolled
    // both back — the cursor did not move and no row of the chunk was written.
    expect(
      await local.env.READ.prepare(
        "SELECT position FROM read_build_checkpoints WHERE snapshot_id=?1 AND stage='rows'",
      )
        .bind(first.snapshotId)
        .first<{ position: string | null }>(),
    ).toEqual(cursorBefore!);
    expect(
      await local.env.READ.prepare(
        "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
      )
        .bind(first.snapshotId)
        .first<{ n: number }>(),
    ).toEqual(written!);

    // Leave the store usable for the next case: the tampered build is retired
    // the way a rebuild retires a superseded one.
    await local.env.READ.prepare(
      `UPDATE balance_read_snapshots SET status='retired',completed_at='2026-09-12T00:00:00Z'
       WHERE snapshot_id=?1`,
    )
      .bind(first.snapshotId)
      .run();
    await local.env.READ.prepare("DELETE FROM current_balance_projection WHERE snapshot_id=?1")
      .bind(first.snapshotId)
      .run();
  }
}, 120000);

test("G2-06: a declared budget that overflows refuses the build instead of truncating it", async () => {
  // Runs last on the shared second store: entity relations are append-only, so
  // a set over the budget cannot be taken back.
  const local = { env: await extraPipeline() };
  {
    await seedBalances(local.env, ["smbc:budget"]);
    // One relation over the declared bound. The projection reads the whole
    // declared set or none of it: a truncated set must never be sealed as if
    // it were complete.
    // Every relation needs the decision that recorded it (migration 0029).
    await local.env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5001)
       INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,
         actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       SELECT 'dr-bulk-'||i,'relation','rel-bulk-'||i,1,'accept','manual','operator:1',NULL,
         'Synthetic bulk relation.','[]',NULL,NULL,'2026-09-12T00:00:00Z' FROM n`,
    ).run();
    await local.env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5001)
       INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,
         decision_revision_id,evidence_refs_json,created_at)
       SELECT 'rel-bulk-'||i,'same_account','source_account:a'||i,'source_account:b'||i,
         NULL,NULL,'accepted','dr-bulk-'||i,'[]','2026-09-12T00:00:00Z' FROM n`,
    ).run();
    const refused = await runBalanceProjection(on(local.env));
    expect(refused).toMatchObject({
      status: "refused",
      reasonCode: "relation_budget_exceeded",
      snapshotId: null,
    });
    expect(
      await local.env.READ.prepare(
        "SELECT count(*) AS n FROM balance_read_snapshots WHERE status='complete'",
      ).first<{ n: number }>(),
    ).toEqual({ n: 0 });
    // The outbox sees a blocked row: nothing an automatic retry can fix.
    expect(
      await balanceProjectionOutboxProcessor(on(local.env))(
        local.env.DB,
        await outboxRow(local.env),
      ),
    ).toEqual({ status: "blocked", code: "relation_budget_exceeded" });
  }
}, 120000);

/** The FK chain a committed operation leaves behind, written directly. */
async function seedOperation(operationId: string, decisionId: string): Promise<void> {
  const planId = operationId
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/gu, "a");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,
        simulation_json,created_by,created_at,expires_at,status)
       VALUES(?1,'relation.accept','{}','identity-current-v1','{}','{}','operator:1',
        '2026-09-12T01:00:00Z','2026-09-12T02:00:00Z','committed')`,
    ).bind(planId),
    env.DB.prepare(
      `INSERT INTO operation_receipts(operation_id,principal,operation_kind,payload_digest,plan_id,
        status,result_json,created_at,published_at)
       VALUES(?1,'operator:1','relation.accept',?3,?2,'accepted','{}','2026-09-12T01:00:00Z',NULL)`,
    ).bind(operationId, planId, "c".repeat(64)),
    env.DB.prepare(
      `INSERT INTO decision_outbox(decision_revision_id,principal,operation_id,target,
        enqueued_at,available_at_ms)
       VALUES(?1,'operator:1',?2,'balance-projection','2026-09-12T01:00:00Z',0)`,
    ).bind(decisionId, operationId),
  ]);
}

const receiptStatus = async (operationId: string): Promise<string> =>
  (await env.DB.prepare("SELECT status FROM operation_receipts WHERE operation_id=?1")
    .bind(operationId)
    .first<{ status: string }>())!.status;

const outboxState = async (operationId: string) =>
  await env.DB.prepare(
    `SELECT processed_at,outcome,progress_code,pending_polls,blocked_code,evidence_ref,
      applied_source_revision,required_source_revision FROM decision_outbox WHERE operation_id=?1`,
  )
    .bind(operationId)
    .first<Record<string, unknown>>();

test("G2-11/G2-12/G2-13: the CORE side completes only after the read model, and converges once", async () => {
  const decision = await seedDecision();
  await seedBalances(env, ["smbc:outbox-1", "smbc:outbox-2", "smbc:outbox-3"]);
  await seedOperation("op_pending_1", decision);

  // The flag is off: nothing was updated, so nothing is completed and the
  // receipt stays accepted (G2-13).
  const flagOff = await dispatchDecisionOutbox(env.DB, {
    processors: { "balance-projection": balanceProjectionOutboxProcessor(off()) },
  });
  expect(flagOff.processed).toBe(0);
  expect(flagOff.waiting).toBe(1);
  expect(flagOff.outcomes).toEqual({ "pending:projection_flag_off": 1 });
  expect(await receiptStatus("op_pending_1")).toBe("accepted");
  expect(await outboxState("op_pending_1")).toMatchObject({
    processed_at: null,
    progress_code: "projection_flag_off",
    pending_polls: 1,
  });

  // The build cannot finish inside this tick: still pending, and the CORE side
  // is not completed before the read model is (G2-11).
  const building = await dispatchDecisionOutbox(env.DB, {
    now: Date.now() + 60_000,
    processors: {
      "balance-projection": balanceProjectionOutboxProcessor(on(), { writeBudget: 1 }),
    },
  });
  expect(building.processed).toBe(0);
  expect(building.waiting).toBe(1);
  expect(building.outcomes).toEqual({ "pending:projection_building": 1 });
  expect(await receiptStatus("op_pending_1")).toBe("accepted");
  const polled = await outboxState("op_pending_1");
  expect(polled).toMatchObject({ processed_at: null, progress_code: "projection_building" });
  // Polls of work that is running do not burn the failure budget.
  expect(polled!.pending_polls).toBe(2);

  // The read model finishes out of band — the response to the tick above was
  // lost. The next delivery finds the published snapshot already covering the
  // decision, so it completes without rebuilding (G2-12).
  let finished = await runBalanceProjection(on(), { writeBudget: 1 });
  for (let step = 0; step < 20 && finished.status === "building"; step += 1)
    finished = await runBalanceProjection(on(), { writeBudget: 1 });
  expect(finished.status).toBe("complete");
  const snapshots = await count("SELECT count(*) AS n FROM balance_read_snapshots");

  const converged = await dispatchDecisionOutbox(env.DB, {
    now: Date.now() + 120_000,
    processors: { "balance-projection": balanceProjectionOutboxProcessor(on()) },
  });
  expect(converged.processed).toBe(1);
  expect(converged.published).toBe(1);
  expect(converged.outcomes).toEqual({ balance_projection_active: 1 });
  // No second build, and the completion carries the snapshot that proves it.
  expect(await count("SELECT count(*) AS n FROM balance_read_snapshots")).toBe(snapshots);
  expect(await receiptStatus("op_pending_1")).toBe("published");
  const done = await outboxState("op_pending_1");
  expect(done).toMatchObject({
    outcome: "balance_projection_active",
    evidence_ref: finished.snapshotId!,
    blocked_code: null,
  });
  expect(done!.processed_at).not.toBeNull();
  expect(done!.applied_source_revision).toBe(done!.required_source_revision);

  // A redelivery changes nothing: the row is processed, not reopened.
  const again = await dispatchDecisionOutbox(env.DB, {
    now: Date.now() + 180_000,
    processors: { "balance-projection": balanceProjectionOutboxProcessor(on()) },
  });
  expect(again.claimed).toBe(0);
  expect(again.published).toBe(0);
  expect(await outboxState("op_pending_1")).toEqual(done!);
}, 180000);

test("G2-13: an unregistered processor blocks the row and never publishes the receipt", async () => {
  const decision = await seedDecision();
  await seedOperation("op_blocked_1", decision);
  const result = await dispatchDecisionOutbox(env.DB, { now: Date.now() + 240_000 });
  expect(result.processed).toBe(0);
  expect(result.blocked).toBe(1);
  expect(result.outcomes).toEqual({ "blocked:no_processor": 1 });
  expect(await receiptStatus("op_blocked_1")).toBe("accepted");
  expect(await outboxState("op_blocked_1")).toMatchObject({
    processed_at: null,
    blocked_code: "no_processor",
  });
  // A blocked row is not claimed again until an operator clears it.
  const retry = await dispatchDecisionOutbox(env.DB, { now: Date.now() + 300_000 });
  expect(retry.claimed).toBe(0);
}, 60000);
