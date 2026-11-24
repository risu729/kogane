// Cursor sweeps that wait for a change (ADR 0129, slice 3; migration 0109).
//
// A sweep that pages through its whole input and starts over at the end read
// all of it again on every tick, whether or not anything had changed. Here a
// pass that starts from the first row records the CORE revision it starts at,
// and a pass that reaches the end marks that revision clean. While the CORE
// revision still equals the clean one (under the same policy), the sweep reads
// nothing more: everything it pages through is on the CORE dependency ledger,
// so the pass that started there saw what a new one would see. A pass whose
// own writes moved the revision is followed by one more, which writes nothing
// and closes the gate.

import { type CoreRevisionRow } from "../../../packages/read-model/src/source-revision.ts";

export type SweepName = "card_settlement" | "card_purchase_recognition";

/** The current CORE revision, and whether the sweep's last complete pass started there. */
export interface SweepGate {
  clean: boolean;
  revision: CoreRevisionRow;
}

const GATE_SQL = `SELECT revision.source_revision, revision.visibility_revision, revision.core_epoch,
  coalesce(pass.clean_source_revision = revision.source_revision
    AND pass.clean_visibility_revision = revision.visibility_revision
    AND pass.clean_core_epoch = revision.core_epoch
    AND pass.clean_policy = ?2, 0) AS clean
FROM core_source_revision revision
LEFT JOIN processor_sweep_passes pass ON pass.sweep = ?1
WHERE revision.id = 1`;

/** One read: the revision, and whether a pass may be skipped. */
export async function sweepGate(
  db: D1Database,
  sweep: SweepName,
  policy: string,
): Promise<SweepGate | null> {
  const row = await db
    .prepare(GATE_SQL)
    .bind(sweep, policy)
    .first<CoreRevisionRow & { clean: number }>();
  if (row === null) return null;
  const { clean, ...revision } = row;
  return { clean: clean === 1, revision };
}

/** Records the revision a pass from the first row starts at. */
export async function startSweepPass(
  db: D1Database,
  sweep: SweepName,
  revision: CoreRevisionRow,
): Promise<void> {
  await db
    .prepare(
      `UPDATE processor_sweep_passes SET pass_source_revision=?2, pass_visibility_revision=?3,
        pass_core_epoch=?4 WHERE sweep=?1`,
    )
    .bind(sweep, revision.source_revision, revision.visibility_revision, revision.core_epoch)
    .run();
}

/**
 * Marks the revision the finished pass started at clean. A pass whose start
 * was not recorded (one under way when this was deployed) marks nothing, so
 * the next pass runs from the first row.
 */
export async function finishSweepPass(
  db: D1Database,
  sweep: SweepName,
  policy: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE processor_sweep_passes SET clean_source_revision=pass_source_revision,
        clean_visibility_revision=pass_visibility_revision, clean_core_epoch=pass_core_epoch,
        clean_policy=?2, pass_source_revision=NULL, pass_visibility_revision=NULL,
        pass_core_epoch=NULL
       WHERE sweep=?1 AND pass_source_revision IS NOT NULL`,
    )
    .bind(sweep, policy)
    .run();
}

/**
 * Drops the current pass's recorded start, so the pass marks nothing clean
 * when it reaches the end and the next one runs from the first row: for a
 * tick that left part of its page's work for later (a write budget), which a
 * later page of the same pass would not come back to.
 */
export async function abandonSweepPass(db: D1Database, sweep: SweepName): Promise<void> {
  await db
    .prepare(
      `UPDATE processor_sweep_passes SET pass_source_revision=NULL, pass_visibility_revision=NULL,
        pass_core_epoch=NULL WHERE sweep=?1 AND pass_source_revision IS NOT NULL`,
    )
    .bind(sweep)
    .run();
}
