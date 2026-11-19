// The READ writer adapters: identity, leases, checkpoints, seal and pointer
// (unified plan 05 §4–§5).
//
// Acceptance: G2-07 (a re-sent chunk is a no-op only when identical), G2-08
// (the chunk and its checkpoint roll back together), G2-09 (a displaced writer
// writes nothing), G2-10 (the published snapshot never moves backwards), and
// the U10 known limit: content that was retired is built again under a new
// attempt instead of wedging the pointer.
import { describe, expect, test } from "bun:test";
import {
  abandonSnapshot,
  activePointer,
  activePointerStatement,
  currentRevisionSnapshot,
  beginSnapshot,
  claimWriterLease,
  ensureReadInstance,
  publishedSnapshotAt,
  readContentKey,
  readSnapshotId,
  retireOldSnapshots,
  rowCheckpoint,
  rowDigest,
  sealAndPublish,
  snapshotForContent,
  writeRowChunk,
  writeScopeRelations,
  writerFence,
  writtenRowsMatch,
  type SnapshotInputRef,
  type SnapshotPlan,
} from "../src/read/index.ts";
import type { ProjectionRow } from "../../read-model/src/index.ts";
import { CURRENT_REVISION_SNAPSHOT_SQL } from "../src/read/sql.ts";
import { createSqliteReadDatabase } from "./sqlite-read-database.ts";
import type { D1Like } from "../src/d1.ts";
import type { Database } from "bun:sqlite";
import { decisionRef, decisionRelation, DIGEST_A, DIGEST_B, projectionRow } from "./fixtures.ts";

const NOW = "2026-09-11T00:00:00.000Z";

async function plan(overrides: Partial<SnapshotPlan> = {}): Promise<SnapshotPlan> {
  return {
    contentKey: await readContentKey(DIGEST_A, DIGEST_B),
    inputDigest: DIGEST_A,
    buildDigest: DIGEST_B,
    contractVersion: "projection-input-v1",
    sourceRevision: 10,
    visibilityRevision: 3,
    coreEpoch: "core-epoch-1",
    inputManifestJson: JSON.stringify({ publishedHighWaterParseRunId: 7 }),
    projectionRelease: "balance-projection-v1",
    inputRefs: [await decisionRef("decision-1")],
    ...overrides,
  };
}

async function claimed(): Promise<{ db: D1Like; sqlite: Database; instanceId: string }> {
  const { d1: db, sqlite } = createSqliteReadDatabase();
  const instance = await ensureReadInstance(db, NOW, "instance-0000-1111");
  return { db, sqlite, instanceId: instance.read_instance_id };
}

async function buildRows(count: number) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const row = projectionRow(index);
    rows.push({ row, digest: await rowDigest(row) });
  }
  return rows;
}

describe("the read instance", () => {
  test("is claimed once and never changes", async () => {
    const { d1: db } = createSqliteReadDatabase();
    const first = await ensureReadInstance(db, NOW, "instance-aaaa-bbbb");
    const second = await ensureReadInstance(db, "2026-09-12T00:00:00.000Z", "instance-cccc-dddd");
    expect(second.read_instance_id).toBe(first.read_instance_id);
    expect(second.contract_version).toBe("read-baseline-v1");
  });
});

describe("snapshot identity", () => {
  test("the content key is CORE's snapshot id, and the row id carries the attempt", async () => {
    const contentKey = await readContentKey(DIGEST_A, DIGEST_B);
    const first = await readSnapshotId(contentKey, 1, "projection-input-v1");
    const second = await readSnapshotId(contentKey, 2, "projection-input-v1");
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).not.toBe(first);
  });

  test("a building or complete build of the same content is reused", async () => {
    const { db, instanceId } = await claimed();
    const started = (await beginSnapshot(db, instanceId, await plan(), NOW))!;
    expect(started.attempt).toBe(1);
    const found = await snapshotForContent(db, (await plan()).contentKey);
    expect(found?.snapshot_id).toBe(started.snapshotId);
    expect(found?.status).toBe("building");
  });

  test("retired content builds again under a new attempt (the U10 known limit)", async () => {
    const { db, instanceId } = await claimed();
    const first = (await beginSnapshot(db, instanceId, await plan(), NOW))!;
    await abandonSnapshot(db, first.snapshotId);
    // CORE would answer `skipped(snapshot_retired)` here and never advance the
    // watermark again for this content. READ starts attempt 2 instead.
    expect(await snapshotForContent(db, (await plan()).contentKey)).toBeNull();
    const second = (await beginSnapshot(db, instanceId, await plan(), NOW))!;
    expect(second.attempt).toBe(2);
    expect(second.snapshotId).not.toBe(first.snapshotId);
  });
});

describe("writing a build", () => {
  test("the chunk and its checkpoint commit together", async () => {
    const { db, instanceId } = await claimed();
    const { snapshotId } = (await beginSnapshot(db, instanceId, await plan(), NOW))!;
    expect(await claimWriterLease(db, snapshotId, "lease-1", 1_000, 60_000)).toBe(true);
    const fence = await writerFence(db, snapshotId, "lease-1");
    expect(fence).toBe(1);
    const rows = await buildRows(3);
    expect(
      await writeRowChunk(db, snapshotId, rows, {
        lease: "lease-1",
        fence: fence ?? 0,
        now: NOW,
        rowsWritten: 0,
      }),
    ).toBe("written");
    expect(await rowCheckpoint(db, snapshotId)).toBe(2);
  });

  test("a statement error rolls the checkpoint back with the rows (G2-08)", async () => {
    const { db, instanceId } = await claimed();
    const { snapshotId } = (await beginSnapshot(db, instanceId, await plan(), NOW))!;
    await claimWriterLease(db, snapshotId, "lease-1", 1_000, 60_000);
    const rows = await buildRows(2);
    await writeRowChunk(db, snapshotId, rows, {
      lease: "lease-1",
      fence: 1,
      now: NOW,
      rowsWritten: 0,
    });
    // The same positions with different content: the trigger aborts the batch,
    // so neither the rows nor the checkpoint move.
    const conflicting = rows.map((entry) => ({ row: entry.row, digest: "f".repeat(64) }));
    await expect(
      writeRowChunk(db, snapshotId, conflicting, {
        lease: "lease-1",
        fence: 1,
        now: NOW,
        rowsWritten: 2,
      }),
    ).rejects.toThrow(/projection chunk conflict/u);
    expect(await rowCheckpoint(db, snapshotId)).toBe(1);
    expect(
      await writtenRowsMatch(
        db,
        snapshotId,
        rows.map((entry) => entry.digest),
      ),
    ).toBe(true);
  });

  test("re-sending the same chunk is a no-op (G2-07)", async () => {
    const { db, instanceId } = await claimed();
    const { snapshotId } = (await beginSnapshot(db, instanceId, await plan(), NOW))!;
    await claimWriterLease(db, snapshotId, "lease-1", 1_000, 60_000);
    const rows = await buildRows(2);
    const context = { lease: "lease-1", fence: 1, now: NOW, rowsWritten: 0 };
    expect(await writeRowChunk(db, snapshotId, rows, context)).toBe("written");
    expect(await writeRowChunk(db, snapshotId, rows, context)).toBe("written");
    expect(
      await writtenRowsMatch(
        db,
        snapshotId,
        rows.map((entry) => entry.digest),
      ),
    ).toBe(true);
  });

  test("a writer whose lease was taken writes nothing and cannot seal (G2-09)", async () => {
    const { db, instanceId } = await claimed();
    const { snapshotId } = (await beginSnapshot(db, instanceId, await plan(), NOW))!;
    await claimWriterLease(db, snapshotId, "lease-1", 1_000, 60_000);
    // The lease expires and a second invocation takes the build over.
    expect(await claimWriterLease(db, snapshotId, "lease-2", 100_000, 60_000)).toBe(true);
    const rows = await buildRows(1);
    expect(
      await writeRowChunk(db, snapshotId, rows, {
        lease: "lease-1",
        fence: 1,
        now: NOW,
        rowsWritten: 0,
      }),
    ).toBe("lease_lost");
    expect(await writerFence(db, snapshotId, "lease-1")).toBeNull();
    const sealed = await sealAndPublish(
      db,
      {
        snapshotId,
        readInstanceId: instanceId,
        sourceRevision: 10,
        visibilityRevision: 3,
        coreEpoch: "core-epoch-1",
      },
      { rowCount: 1, relationCount: 0, rowDigests: rows.map((entry) => entry.digest) },
      { lease: "lease-1", now: NOW },
    );
    expect(sealed).toMatchObject({ sealed: false, published: false });
    expect(await activePointer(db)).toBeNull();

    // The writer that took the build over finishes it. When the displaced one
    // reaches its own seal afterwards, the snapshot is complete — but not by
    // its lease — so its batch switches nothing: the pointer keeps the
    // successor's switch, timestamp included.
    expect(
      await writeRowChunk(db, snapshotId, rows, {
        lease: "lease-2",
        fence: 2,
        now: NOW,
        rowsWritten: 0,
      }),
    ).toBe("written");
    const snapshot = {
      snapshotId,
      readInstanceId: instanceId,
      sourceRevision: 10,
      visibilityRevision: 3,
      coreEpoch: "core-epoch-1",
    };
    const build = { rowCount: 1, relationCount: 0, rowDigests: rows.map((entry) => entry.digest) };
    expect(await sealAndPublish(db, snapshot, build, { lease: "lease-2", now: NOW })).toMatchObject(
      { sealed: true, published: true },
    );
    const late = await sealAndPublish(db, snapshot, build, {
      lease: "lease-1",
      now: "2026-09-11T00:00:01.000Z",
    });
    expect(late).toMatchObject({ sealed: false, published: false });
    expect(await activePointer(db)).toMatchObject({ snapshot_id: snapshotId, switched_at: NOW });
  });

  test("a second start of the same content starts nothing", async () => {
    const { db, sqlite, instanceId } = await claimed();
    const first = await beginSnapshot(db, instanceId, await plan(), NOW);
    // Two invocations that both found no build of this content race to start
    // one: the loser's row is refused by the guard in the insert itself, its
    // batch rolls back, and it reports the build as in progress rather than
    // allocating a second attempt.
    expect(await beginSnapshot(db, instanceId, await plan(), NOW)).toBeNull();
    expect(await beginSnapshot(db, instanceId, await plan({ inputRefs: [] }), NOW)).toBeNull();
    expect((await snapshotForContent(db, (await plan()).contentKey))?.snapshot_id).toBe(
      first!.snapshotId,
    );
    expect(
      sqlite.query("SELECT count(*) AS n FROM balance_read_snapshots").get() as { n: number },
    ).toEqual({ n: 1 });
  });

  test("a decision relation needs the decision in the snapshot's input refs (04 §3)", async () => {
    const { db, instanceId } = await claimed();
    const { snapshotId } = (await beginSnapshot(db, instanceId, await plan(), NOW))!;
    await claimWriterLease(db, snapshotId, "lease-1", 1_000, 60_000);
    const context = { lease: "lease-1", fence: 1, now: NOW };
    expect(
      await writeScopeRelations(db, snapshotId, [decisionRelation("decision-1")], context),
    ).toBe("written");
    await expect(
      writeScopeRelations(db, snapshotId, [decisionRelation("decision-unknown")], context),
    ).rejects.toThrow(/input refs/u);
  });
});

// The writer skips only a re-sent primary key (`ON CONFLICT … DO NOTHING`).
// Under `INSERT OR IGNORE` SQLite also skipped a row that failed a CHECK, a
// NOT NULL or another UNIQUE index, with `changes=0`: the chunk's checkpoint
// moved past it and the build stopped later at `projection_rows_unverified`
// without naming the row, and a refused input ref was left out of the snapshot.
describe("only a re-sent key is skipped", () => {
  async function building() {
    const { db, sqlite, instanceId } = await claimed();
    const { snapshotId } = (await beginSnapshot(db, instanceId, await plan(), NOW))!;
    await claimWriterLease(db, snapshotId, "lease-1", 1_000, 60_000);
    return { db, sqlite, instanceId, snapshotId };
  }
  const context = { lease: "lease-1", fence: 1, now: NOW, rowsWritten: 0 };
  const stored = (sqlite: Database, snapshotId: string) =>
    (
      sqlite
        .query(
          "SELECT row_seq FROM current_balance_projection WHERE snapshot_id=? ORDER BY row_seq",
        )
        .all(snapshotId) as { row_seq: number }[]
    ).map((row) => row.row_seq);
  async function entry(row: ProjectionRow) {
    return { row, digest: await rowDigest(row) };
  }

  test("a row that fails a CHECK raises and the checkpoint stays where it was", async () => {
    const { db, sqlite, snapshotId } = await building();
    // `exact` without its coefficient: the projection's own CHECK refuses it.
    const chunk = [
      ...(await buildRows(2)),
      await entry(projectionRow(2, { quantityCoefficient: null })),
    ];
    await expect(writeRowChunk(db, snapshotId, chunk, context)).rejects.toThrow(
      /CHECK constraint failed/u,
    );
    expect(await rowCheckpoint(db, snapshotId)).toBe(-1);
    expect(stored(sqlite, snapshotId)).toEqual([]);
  });

  test("a row that fails a NOT NULL raises", async () => {
    const { db, sqlite, snapshotId } = await building();
    const refused = await entry(projectionRow(0, { unitRef: null as unknown as string }));
    await expect(writeRowChunk(db, snapshotId, [refused], context)).rejects.toThrow(
      /NOT NULL constraint failed/u,
    );
    expect(await rowCheckpoint(db, snapshotId)).toBe(-1);
    expect(stored(sqlite, snapshotId)).toEqual([]);
  });

  test("a new scope at a written row_seq raises on the order index", async () => {
    const { db, sqlite, snapshotId } = await building();
    const rows = await buildRows(2);
    expect(await writeRowChunk(db, snapshotId, rows, context)).toBe("written");
    // Not a re-send: another scope key at position 1, then position 2.
    const chunk = [
      await entry(projectionRow(1, { scopeKey: "balsyntheticsetparseracct-otherbalanceJPY" })),
      await entry(projectionRow(2)),
    ];
    await expect(
      writeRowChunk(db, snapshotId, chunk, { ...context, rowsWritten: 2 }),
    ).rejects.toThrow(
      /UNIQUE constraint failed: current_balance_projection.snapshot_id, current_balance_projection.row_seq/u,
    );
    expect(await rowCheckpoint(db, snapshotId)).toBe(1);
    expect(stored(sqlite, snapshotId)).toEqual([0, 1]);
    // The re-sent first chunk, which hits both keys, is still skipped (G2-07).
    expect(await writeRowChunk(db, snapshotId, rows, context)).toBe("written");
    expect(
      await writtenRowsMatch(
        db,
        snapshotId,
        rows.map((row) => row.digest),
      ),
    ).toBe(true);
  });

  test("an input ref that fails a CHECK or NOT NULL starts no build", async () => {
    const { db, sqlite, instanceId } = await claimed();
    for (const refused of [
      { kind: "decision_revision", id: "decision-2", digest: "not-a-digest" },
      { kind: "decision_revision", id: "decision-2", digest: null as unknown as string },
    ] as SnapshotInputRef[]) {
      const snapshotPlan = await plan({ inputRefs: [await decisionRef("decision-1"), refused] });
      await expect(beginSnapshot(db, instanceId, snapshotPlan, NOW)).rejects.toThrow(
        /constraint failed/u,
      );
      expect(await snapshotForContent(db, snapshotPlan.contentKey)).toBeNull();
    }
    expect(
      sqlite.query("SELECT count(*) AS n FROM snapshot_input_refs").get() as { n: number },
    ).toEqual({ n: 0 });
  });

  test("two starts that race to the same snapshot id record each ref once", async () => {
    const { db, sqlite, instanceId } = await claimed();
    const snapshotPlan = await plan({
      inputRefs: [await decisionRef("decision-1"), await decisionRef("decision-2")],
    });
    // Both read the same next attempt before either writes, so both name the
    // same snapshot: the second row insert matches nothing and its refs hit
    // the primary key. Which of them builds is the lease's to decide.
    const [first, second] = await Promise.all([
      beginSnapshot(db, instanceId, snapshotPlan, NOW),
      beginSnapshot(db, instanceId, snapshotPlan, NOW),
    ]);
    expect(first).toEqual({ snapshotId: first!.snapshotId, attempt: 1 });
    expect(second).toEqual(first);
    expect(
      sqlite
        .query("SELECT ref_id FROM snapshot_input_refs WHERE snapshot_id=? ORDER BY ref_id")
        .all(first!.snapshotId),
    ).toEqual([{ ref_id: "decision-1" }, { ref_id: "decision-2" }]);
    expect(
      sqlite.query("SELECT count(*) AS n FROM balance_read_snapshots").get() as { n: number },
    ).toEqual({ n: 1 });
  });
});

describe("sealing and publishing", () => {
  async function published(db: D1Like, instanceId: string, sourceRevision: number) {
    const inputDigest = String(sourceRevision).padStart(64, "0");
    const snapshotPlan = await plan({
      contentKey: await readContentKey(inputDigest, DIGEST_B),
      inputDigest,
      sourceRevision,
    });
    const { snapshotId } = (await beginSnapshot(db, instanceId, snapshotPlan, NOW))!;
    await claimWriterLease(db, snapshotId, `lease-${String(sourceRevision)}`, 1_000, 60_000);
    const rows = await buildRows(2);
    await writeRowChunk(db, snapshotId, rows, {
      lease: `lease-${String(sourceRevision)}`,
      fence: 1,
      now: NOW,
      rowsWritten: 0,
    });
    const outcome = await sealAndPublish(
      db,
      {
        snapshotId,
        readInstanceId: instanceId,
        sourceRevision,
        visibilityRevision: 3,
        coreEpoch: "core-epoch-1",
      },
      { rowCount: rows.length, relationCount: 0, rowDigests: rows.map((entry) => entry.digest) },
      { lease: `lease-${String(sourceRevision)}`, now: NOW },
    );
    return { snapshotId, outcome };
  }

  test("the seal and the switch are one batch, and the pointer only moves forward (G2-10)", async () => {
    const { db, instanceId } = await claimed();
    const newer = await published(db, instanceId, 20);
    expect(newer.outcome).toMatchObject({ sealed: true, published: true });
    expect((await activePointer(db))?.snapshot_id).toBe(newer.snapshotId);
    // A build of an older context finishes late: complete, not published.
    const older = await published(db, instanceId, 5);
    expect(older.outcome).toMatchObject({ sealed: true, published: false });
    const pointer = await activePointer(db);
    expect(pointer?.snapshot_id).toBe(newer.snapshotId);
    expect(pointer?.source_revision).toBe(20);
  });

  test("the published snapshot answers 'does it cover this revision?'", async () => {
    const { db, instanceId } = await claimed();
    const { snapshotId } = await published(db, instanceId, 20);
    expect((await publishedSnapshotAt(db, 20, "core-epoch-1"))?.snapshot_id).toBe(snapshotId);
    expect(await publishedSnapshotAt(db, 21, "core-epoch-1")).toBeNull();
    // A CORE restored from a backup is another context, whatever the counter says.
    expect(await publishedSnapshotAt(db, 20, "core-epoch-2")).toBeNull();
  });

  test("retiring a build never touches the published one", async () => {
    const { db, sqlite, instanceId } = await claimed();
    const first = await published(db, instanceId, 10);
    const second = await published(db, instanceId, 20);
    const third = await published(db, instanceId, 30);
    expect(await retireOldSnapshots(db, third.snapshotId, NOW, 1)).toBe(2);
    expect((await activePointer(db))?.snapshot_id).toBe(third.snapshotId);
    const statuses = sqlite
      .query("SELECT snapshot_id,status FROM balance_read_snapshots ORDER BY source_revision")
      .all() as { snapshot_id: string; status: string }[];
    expect(statuses).toEqual([
      { snapshot_id: first.snapshotId, status: "retired" },
      { snapshot_id: second.snapshotId, status: "retired" },
      { snapshot_id: third.snapshotId, status: "complete" },
    ]);
  });
});

test("the capture shortcut requires a published context, every release and the current instance", async () => {
  const { db, sqlite, instanceId } = await claimed();
  try {
    const context = {
      sourceRevision: 10,
      visibilityRevision: 3,
      coreEpoch: "core-epoch-1",
      readInstanceId: instanceId,
      buildDigest: DIGEST_B,
      contractVersion: "projection-input-v1",
      identityRelease: "identity-test-v1",
      decimalPolicyRelease: "decimal-test-v1",
    };
    const snapshotPlan = await plan({
      inputManifestJson: JSON.stringify({
        identityRelease: context.identityRelease,
        decimalPolicyRelease: context.decimalPolicyRelease,
      }),
    });
    expect(await currentRevisionSnapshot(db, context)).toBeNull();
    const { snapshotId } = (await beginSnapshot(db, instanceId, snapshotPlan, NOW))!;
    // A resumable build is never evidence that capture can be skipped.
    expect(await currentRevisionSnapshot(db, context)).toBeNull();
    await claimWriterLease(db, snapshotId, "shortcut-lease", 1000, 60000);
    const rows = await buildRows(1);
    await writeRowChunk(db, snapshotId, rows, {
      lease: "shortcut-lease",
      fence: 1,
      now: NOW,
      rowsWritten: 0,
    });
    const outcome = await sealAndPublish(
      db,
      {
        snapshotId,
        readInstanceId: instanceId,
        sourceRevision: 10,
        visibilityRevision: 3,
        coreEpoch: "core-epoch-1",
      },
      {
        rowCount: 1,
        relationCount: 0,
        rowDigests: rows.map((entry) => entry.digest),
      },
      { lease: "shortcut-lease", now: NOW },
    );
    expect(outcome).toMatchObject({ sealed: true, published: true });
    expect(await currentRevisionSnapshot(db, context)).toEqual({
      snapshot_id: snapshotId,
      input_digest: DIGEST_A,
      row_count: 1,
    });
    for (const mismatch of [
      { sourceRevision: 11 },
      { visibilityRevision: 4 },
      { coreEpoch: "restored-core" },
      { readInstanceId: "other-read" },
      { buildDigest: DIGEST_A },
      { contractVersion: "projection-input-v2" },
      { identityRelease: "identity-test-v2" },
      { decimalPolicyRelease: "decimal-test-v2" },
    ])
      expect(await currentRevisionSnapshot(db, { ...context, ...mismatch })).toBeNull();

    // After verified content-equivalent captures, the pointer carries the new
    // context. Immutable snapshot fields deliberately retain the original one.
    const pointer = (await activePointer(db))!;
    for (const changed of [
      { sourceRevision: 11 },
      { sourceRevision: 12, visibilityRevision: 4 },
      { sourceRevision: 1, visibilityRevision: 0, coreEpoch: "restored-core" },
    ]) {
      const refreshed = { ...context, ...changed };
      await activePointerStatement(
        db,
        {
          snapshotId,
          readInstanceId: instanceId,
          sourceRevision: refreshed.sourceRevision,
          visibilityRevision: refreshed.visibilityRevision,
          coreEpoch: refreshed.coreEpoch,
          outputDigest: pointer.output_digest,
        },
        NOW,
      ).run();
      expect(await currentRevisionSnapshot(db, context)).toBeNull();
      expect(await currentRevisionSnapshot(db, refreshed)).toMatchObject({
        snapshot_id: snapshotId,
      });
    }

    const details = sqlite
      .prepare<
        { detail: string },
        [number, number, string, string, string, string, string, string]
      >("EXPLAIN QUERY PLAN " + CURRENT_REVISION_SNAPSHOT_SQL)
      .all(
        11,
        3,
        context.coreEpoch,
        instanceId,
        DIGEST_B,
        context.contractVersion,
        context.identityRelease,
        context.decimalPolicyRelease,
      )
      .map((row) => row.detail);
    expect(details.some((detail) => /SEARCH p USING INTEGER PRIMARY KEY/u.test(detail))).toBe(true);
    expect(details.some((detail) => /SEARCH s USING INDEX .*[(]snapshot_id=/u.test(detail))).toBe(
      true,
    );
    expect(details.some((detail) => /SCAN /u.test(detail))).toBe(false);
  } finally {
    sqlite.close();
  }
});
