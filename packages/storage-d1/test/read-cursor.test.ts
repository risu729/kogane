// The READ cursor and the reader that only ever serves a published snapshot
// (unified plan 05 §7).
//
// Acceptance: G3-01 (no active snapshot is `unavailable`, never an empty list),
// G3-03 (a cursor from another snapshot or another READ instance is
// `context_expired`).
import { describe, expect, test } from "bun:test";
import { d1Executor } from "../../read-model/src/d1.ts";
import {
  beginSnapshot,
  checkReadCursor,
  claimWriterLease,
  createReadProjectionReader,
  decodeReadCursor,
  encodeReadCursor,
  ensureReadInstance,
  readContentKey,
  rowDigest,
  sealAndPublish,
  writeRowChunk,
} from "../src/read/index.ts";
import { createSqliteReadDatabase } from "./sqlite-read-database.ts";
import { decisionRef, DIGEST_A, DIGEST_B, projectionRow } from "./fixtures.ts";

const NOW = "2026-09-11T00:00:00.000Z";

const cursor = {
  snapshotId: "a".repeat(64),
  readInstanceId: "instance-1",
  filterDigest: "digest-1",
  position: 12,
  sortKey: "2026-09-01T00:00:00.000Z",
};

describe("the read cursor", () => {
  test("carries the snapshot, the read instance, the filter digest and the position", () => {
    const decoded = decodeReadCursor(encodeReadCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  test("a CORE page's cursor names no read instance and stays readable", () => {
    const core = { ...cursor, readInstanceId: null };
    expect(decodeReadCursor(encodeReadCursor(core))).toEqual(core);
  });

  test("carries no account, metric or amount", () => {
    expect(encodeReadCursor(cursor)).not.toContain("acct");
    const raw = atob(encodeReadCursor(cursor).replaceAll("-", "+").replaceAll("_", "/"));
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(["f", "k", "r", "s", "t", "v"]);
  });

  test("another read instance is context_expired, not a mismatch (G3-03)", () => {
    expect(
      checkReadCursor(cursor, {
        filterDigest: "digest-1",
        readInstanceId: "instance-2",
        snapshotReadable: true,
      }),
    ).toBe("context_expired");
    // The same cursor arriving at a CORE-backed deployment expires too: its
    // snapshot ids belong to another database.
    expect(
      checkReadCursor(cursor, {
        filterDigest: "digest-1",
        readInstanceId: null,
        snapshotReadable: true,
      }),
    ).toBe("context_expired");
  });

  test("a retired or deleted snapshot is context_expired; another query is a mismatch", () => {
    expect(
      checkReadCursor(cursor, {
        filterDigest: "digest-1",
        readInstanceId: "instance-1",
        snapshotReadable: false,
      }),
    ).toBe("context_expired");
    expect(
      checkReadCursor(cursor, {
        filterDigest: "other",
        readInstanceId: "instance-1",
        snapshotReadable: true,
      }),
    ).toBe("cursor_mismatch");
    expect(
      checkReadCursor(cursor, {
        filterDigest: "digest-1",
        readInstanceId: "instance-1",
        snapshotReadable: true,
      }),
    ).toBeNull();
  });
});

describe("the read reader", () => {
  test("publishes nothing until the pointer switches (G3-01)", async () => {
    const { d1: db } = createSqliteReadDatabase();
    const { d1: core } = createSqliteReadDatabase();
    const instance = await ensureReadInstance(db, NOW, "instance-0000-2222");
    const reader = createReadProjectionReader(d1Executor(core), d1Executor(db));
    expect(await reader.readInstance()).toMatchObject({
      read_instance_id: instance.read_instance_id,
    });
    expect(await reader.currentSnapshot()).toBeNull();

    const contentKey = await readContentKey(DIGEST_A, DIGEST_B);
    const { snapshotId } = (await beginSnapshot(
      db,
      instance.read_instance_id,
      {
        contentKey,
        inputDigest: DIGEST_A,
        buildDigest: DIGEST_B,
        contractVersion: "projection-input-v1",
        sourceRevision: 4,
        visibilityRevision: 2,
        coreEpoch: "core-epoch-1",
        inputManifestJson: JSON.stringify({ publishedHighWaterParseRunId: 7 }),
        projectionRelease: "balance-projection-v1",
        inputRefs: [await decisionRef("decision-1")],
      },
      NOW,
    ))!;
    await claimWriterLease(db, snapshotId, "lease-1", 1_000, 60_000);
    const row = projectionRow(0);
    const digest = await rowDigest(row);
    await writeRowChunk(db, snapshotId, [{ row, digest }], {
      lease: "lease-1",
      fence: 1,
      now: NOW,
      rowsWritten: 0,
    });
    // A build in progress is invisible: no page, no snapshot, no pointer.
    expect(await reader.currentSnapshot()).toBeNull();
    expect(await reader.snapshot(snapshotId)).toBeNull();

    await sealAndPublish(
      db,
      {
        snapshotId,
        readInstanceId: instance.read_instance_id,
        sourceRevision: 4,
        visibilityRevision: 2,
        coreEpoch: "core-epoch-1",
      },
      { rowCount: 1, relationCount: 0, rowDigests: [digest] },
      { lease: "lease-1", now: NOW },
    );
    const snapshot = await reader.currentSnapshot();
    expect(snapshot).toMatchObject({
      snapshot_id: snapshotId,
      source_revision: 4,
      visibility_revision: 2,
      core_epoch: "core-epoch-1",
      read_instance_id: instance.read_instance_id,
      row_count: 1,
    });
    const page = await reader.latestPage(snapshotId, {}, 10, -1);
    expect(page.map((entry) => entry.row_seq)).toEqual([0]);
  });
});
