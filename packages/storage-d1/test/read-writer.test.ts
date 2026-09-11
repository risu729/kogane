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
  type SnapshotPlan,
} from "../src/read/index.ts";
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
