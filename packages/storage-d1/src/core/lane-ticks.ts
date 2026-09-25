// The last ticks of the Processor's scheduled lanes (migration 0049).
//
// Operational bookkeeping, not evidence: one row says that one lane ran,
// was skipped because its flag is off, or failed with a safe code, when, and
// with which counts. The table is bounded — every insert deletes that lane's
// rows beyond the retention in the same batch — and a row is never updated.
// The Processor writes it (`services/processor/src/lane-ticks.ts`); the
// internal health and `/status` routes read the latest row per lane.
import { all, runBatch, statement, type D1Like } from "../d1.ts";

/** Rows kept per lane: one day of the Processor's five-minute cron. */
export const LANE_TICK_RETENTION = 288;

export type LaneTickOutcome = "ran" | "skipped-by-flag" | "failed";

/**
 * Counts, flags and closed reason codes only. The 0049 trigger refuses any
 * other shape, so no text value — no amount text, label or provider wording —
 * can be stored.
 */
export type LaneTickCounts = Record<string, number | boolean | Record<string, number>>;

export interface LaneTick {
  lane: string;
  startedAtMs: number;
  finishedAtMs: number;
  outcome: LaneTickOutcome;
  /** A safe code for `failed`, never an exception message; null otherwise. */
  errorCode: string | null;
  /** Empty unless the lane ran. */
  counts: LaneTickCounts;
}

/**
 * Records one tick and prunes the lane to `retention` rows, atomically. The
 * delete is keyed on the lane's own ids, so it never touches another lane, and
 * an id is never reused because the newest row is never the one deleted.
 */
export async function recordLaneTick(
  db: D1Like,
  tick: LaneTick,
  retention: number = LANE_TICK_RETENTION,
): Promise<void> {
  if (!Number.isSafeInteger(retention) || retention < 1)
    throw new Error("lane_tick_retention_invalid");
  await runBatch(db, [
    statement(
      db,
      `INSERT INTO processor_lane_ticks(lane,started_at_ms,finished_at_ms,outcome,error_code,counts_json)
       VALUES(?1,?2,?3,?4,?5,?6)`,
      [
        tick.lane,
        tick.startedAtMs,
        tick.finishedAtMs,
        tick.outcome,
        tick.errorCode,
        JSON.stringify(tick.counts),
      ],
    ),
    statement(
      db,
      `DELETE FROM processor_lane_ticks WHERE lane=?1 AND id<=(SELECT id FROM processor_lane_ticks
        WHERE lane=?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)`,
      [tick.lane, retention],
    ),
  ]);
}

interface LaneTickRow {
  lane: string;
  started_at_ms: number;
  finished_at_ms: number;
  outcome: LaneTickOutcome;
  error_code: string | null;
  counts_json: string;
}

/** The newest tick of every lane that has one, ordered by lane. */
export async function latestLaneTicks(db: D1Like): Promise<LaneTick[]> {
  const rows = await all<LaneTickRow>(
    db,
    `SELECT t.lane,t.started_at_ms,t.finished_at_ms,t.outcome,t.error_code,t.counts_json
       FROM processor_lane_ticks t
       JOIN (SELECT lane,max(id) AS id FROM processor_lane_ticks GROUP BY lane) latest ON latest.id=t.id
      ORDER BY t.lane`,
  );
  return rows.map((row) => ({
    lane: row.lane,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    outcome: row.outcome,
    errorCode: row.error_code,
    counts: JSON.parse(row.counts_json) as LaneTickCounts,
  }));
}
