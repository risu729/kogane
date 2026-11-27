// Cursor sweeps that wait for a change (ADR 0129, slice 3; migration 0109).
//
// A sweep that pages through its whole input and starts over at the end read
// all of it again on every tick, whether or not anything had changed. Here a
// pass that starts from the first row records the CORE revision and the
// sweep's policy it starts at, and a pass that reaches the end with all its
// work done marks that start clean. While the CORE revision and the policy
// still equal the clean ones, the sweep reads nothing more: everything it
// reads is on the CORE dependency ledger, written only by the sweep itself, or
// folded into the policy (a version, an off-ledger high-water mark), so the
// pass that started there saw what a new one would see. A pass whose own
// writes moved the revision is followed by one more, which writes nothing and
// closes the gate.
//
// A sweep that reads its whole candidate set in one statement (the identity
// sweep, the reward claim promotion; migration 0110) is a pass of one page: its
// cursor is always 0 (`ONE_PAGE_CURSOR_SQL`), and it ends its pass clean only
// when its one read returned no candidate.

import { type CoreRevisionRow } from "../../../packages/read-model/src/source-revision.ts";

export type SweepName =
  | "card_settlement"
  | "card_purchase_recognition"
  | "identity_sweep"
  | "reward_claims";

/** The cursor of a sweep whose every tick reads from the first row. */
export const ONE_PAGE_CURSOR_SQL = "SELECT 0";

/**
 * The first 16 hex digits of the SHA-256 of `text`: a one-page sweep's policy
 * carries its candidate statement this way, so a change to the statement's
 * text reads again.
 */
export async function shortDigest(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...bytes.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * One statement, so the cursor and the recorded pass are read together: a
 * tick never continues a pass other than the one whose cursor it read. One
 * row always, even before the CORE revision row exists.
 */
const gateSql = (cursorSql: string) => `SELECT coalesce((${cursorSql}),0) AS cursor,
  revision.source_revision, revision.visibility_revision, revision.core_epoch, pass.pass_token,
  coalesce(pass.clean_source_revision = revision.source_revision
    AND pass.clean_visibility_revision = revision.visibility_revision
    AND pass.clean_core_epoch = revision.core_epoch
    AND pass.clean_policy = ?2, 0) AS clean
FROM (SELECT 1) one
LEFT JOIN core_source_revision revision ON revision.id = 1
LEFT JOIN processor_sweep_passes pass ON pass.sweep = ?1`;

/**
 * Where a tick stands: `skip` when the gate holds (the tick reads nothing
 * more), else the cursor it read and the token of the pass it belongs to,
 * which the pass's end or abandonment must name. A null token (no pass
 * recorded: one under way when the gate was deployed, one dropped, or one
 * whose start another tick replaced) marks nothing, so the next pass runs
 * from the first row.
 */
export type SweepTick = { skip: true } | { skip: false; cursor: number; token: string | null };

/**
 * Opens a tick of `sweep` with one read of its cursor (`cursorSql`, a
 * one-value statement) and its gate. A tick at the first row skips while the
 * gate holds and otherwise records a new pass; a later tick continues the
 * recorded one.
 */
export async function openSweepTick(
  db: D1Database,
  sweep: SweepName,
  policy: string,
  cursorSql: string,
): Promise<SweepTick> {
  const row = await db.prepare(gateSql(cursorSql)).bind(sweep, policy).first<
    { cursor: number; pass_token: string | null; clean: number } & {
      [K in keyof CoreRevisionRow]: CoreRevisionRow[K] | null;
    }
  >();
  const cursor = row?.cursor ?? 0;
  if (row === null || row.source_revision === null) return { skip: false, cursor, token: null };
  if (cursor !== 0) return { skip: false, cursor, token: row.pass_token };
  if (row.clean === 1) return { skip: true };
  const token = crypto.randomUUID();
  // Replaces any pass recorded before: that pass's own end no longer names
  // the recorded token, so it marks nothing.
  await db
    .prepare(
      `UPDATE processor_sweep_passes SET pass_source_revision=?2, pass_visibility_revision=?3,
        pass_core_epoch=?4, pass_policy=?5, pass_token=?6 WHERE sweep=?1`,
    )
    .bind(sweep, row.source_revision, row.visibility_revision, row.core_epoch, policy, token)
    .run();
  return { skip: false, cursor, token };
}

/** Marks the start of the pass `token` names clean, if it is still the recorded pass. */
export async function finishSweepPass(
  db: D1Database,
  sweep: SweepName,
  token: string | null,
): Promise<void> {
  if (token === null) return;
  await db
    .prepare(
      `UPDATE processor_sweep_passes SET clean_source_revision=pass_source_revision,
        clean_visibility_revision=pass_visibility_revision, clean_core_epoch=pass_core_epoch,
        clean_policy=pass_policy, pass_source_revision=NULL, pass_visibility_revision=NULL,
        pass_core_epoch=NULL, pass_policy=NULL, pass_token=NULL
       WHERE sweep=?1 AND pass_token=?2`,
    )
    .bind(sweep, token)
    .run();
}

/**
 * Drops the pass `token` names, so it marks nothing clean when it reaches
 * the end and the next pass runs from the first row: for a tick that left
 * part of its page's work for later (a write budget, a failure), which a
 * later page of the same pass would not come back to.
 */
export async function abandonSweepPass(
  db: D1Database,
  sweep: SweepName,
  token: string | null,
): Promise<void> {
  if (token === null) return;
  await db
    .prepare(
      `UPDATE processor_sweep_passes SET pass_source_revision=NULL, pass_visibility_revision=NULL,
        pass_core_epoch=NULL, pass_policy=NULL, pass_token=NULL WHERE sweep=?1 AND pass_token=?2`,
    )
    .bind(sweep, token)
    .run();
}
