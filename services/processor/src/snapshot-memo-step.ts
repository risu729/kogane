// The Processor's snapshot memo (ADR 0129, slice 2; migration 0108).
//
// A scheduled lane that reads the latest state (the balance and reward
// captures, the report's position cut) used to recompute which capture of
// every container is current inside each statement. Here the lane stores that
// set once per snapshot-input revision and its statements join the stored
// members (`SnapshotSource` "memo"). A statement that finds no members for
// this build at the current revision fails instead of reading an empty set
// (packages/read-model/src/snapshot-memo.ts), so a lane never reads members
// of an older revision: it stores the memo again and repeats the read, and
// after `MEMO_ATTEMPTS` it reads the shipped selection inline, which is the
// same set at the cost the memo saves.

import {
  SNAPSHOT_MEMO_KEY_SQL,
  SNAPSHOT_MEMO_STALE_ERROR,
  STORE_SNAPSHOT_MEMO_SQL,
  type SnapshotSource,
} from "../../../packages/read-model/src/index";
import { type D1Like } from "../../../packages/storage-d1/src/d1.ts";

/** Memo-backed attempts of one read before it falls back to the inline selection. */
export const MEMO_ATTEMPTS = 2;

/** Whether this build's memo exists for the current snapshot-input revision. */
export async function snapshotMemoCurrent(db: D1Like): Promise<boolean> {
  const row = await db.prepare(SNAPSHOT_MEMO_KEY_SQL).first<{ key_id: number | null }>();
  return row !== null && row.key_id !== null;
}

/**
 * Stores this build's memo for the current revision unless it is already
 * there: one read when it is, one batch (one transaction) when it is not.
 */
export async function ensureSnapshotMemo(db: D1Like, nowMs: number): Promise<"current" | "stored"> {
  if (await snapshotMemoCurrent(db)) return "current";
  await db.batch([
    db.prepare(STORE_SNAPSHOT_MEMO_SQL.dropStaleMembers),
    db.prepare(STORE_SNAPSHOT_MEMO_SQL.dropStaleKeys),
    db.prepare(STORE_SNAPSHOT_MEMO_SQL.insertKey).bind(nowMs),
    db.prepare(STORE_SNAPSHOT_MEMO_SQL.insertMembers),
  ]);
  return "stored";
}

/** The failure of a memo-backed statement that found no current memo. */
export function isSnapshotMemoStale(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(SNAPSHOT_MEMO_STALE_ERROR);
}

/**
 * Runs `read` against the memo, storing it first when it is not current. When
 * a write moves the revision during the read, the memo is stored again and the
 * read repeated; after `MEMO_ATTEMPTS` the read takes the inline selection.
 * `read` must be repeatable: it is called again from the start, never resumed.
 * A failure to store the memo is not a stale read and fails the lane, so that
 * it shows up instead of hiding behind the inline selection's cost.
 */
export async function withSnapshotSelection<T>(
  db: D1Like,
  read: (source: SnapshotSource) => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  for (let attempt = 1; attempt <= MEMO_ATTEMPTS; attempt += 1) {
    await ensureSnapshotMemo(db, now());
    try {
      return await read("memo");
    } catch (error) {
      if (!isSnapshotMemoStale(error)) throw error;
    }
  }
  return await read("inline");
}
