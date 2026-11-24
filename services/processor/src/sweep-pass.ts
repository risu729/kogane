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

import { type CoreRevisionRow } from "../../../packages/read-model/src/source-revision.ts";

export type SweepName = "card_settlement" | "card_purchase_recognition";

const GATE_SQL = `SELECT revision.source_revision, revision.visibility_revision, revision.core_epoch,
  pass.pass_token,
  coalesce(pass.clean_source_revision = revision.source_revision
    AND pass.clean_visibility_revision = revision.visibility_revision
    AND pass.clean_core_epoch = revision.core_epoch
    AND pass.clean_policy = ?2, 0) AS clean
FROM core_source_revision revision
LEFT JOIN processor_sweep_passes pass ON pass.sweep = ?1
WHERE revision.id = 1`;

/**
 * Where a tick stands: `skip` when the gate holds (the tick reads nothing
 * more), else the token of the pass the tick belongs to, which the pass's end
 * or abandonment must name. A null token (no pass recorded: one under way
 * when the gate was deployed, or one whose start another tick replaced) marks
 * nothing, so the next pass runs from the first row.
 */
export type SweepTick = { skip: true } | { skip: false; token: string | null };

/**
 * Opens a tick of `sweep` with one read. A tick at the first row (`atStart`)
 * skips while the gate holds and otherwise records a new pass; a later tick
 * continues the recorded one.
 */
export async function openSweepTick(
  db: D1Database,
  sweep: SweepName,
  policy: string,
  atStart: boolean,
): Promise<SweepTick> {
  const row = await db
    .prepare(GATE_SQL)
    .bind(sweep, policy)
    .first<CoreRevisionRow & { pass_token: string | null; clean: number }>();
  if (row === null) return { skip: false, token: null };
  if (!atStart) return { skip: false, token: row.pass_token };
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
  return { skip: false, token };
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
