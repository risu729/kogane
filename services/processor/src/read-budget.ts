// The Processor's daily D1 read budget (ADR 0129, migration 0107, issue #1491).
//
// Every metered invocation adds the rows D1 reported reading to its hour's row
// in `processor_read_budget_hours`. Before its lanes run, the scheduled tick
// sums the last 24 rows and counts itself in its hour (even when the sum could
// not be read; a failed count is an error line). Above the budget it
// logs one error line per hour, which Workers Issues reports, and runs the
// derived lanes only on the first scheduled tick of each hour, so a read
// regression costs cents and is reported the same day instead of running
// unnoticed for weeks. Collection, parsing and operation dispatch keep their
// cadence: they take in evidence, and the derived lanes catch up from it.
//
// The tick counts itself before its lanes, not when it ends: a lane that
// leaves D1 unable to take writes (as the identity sweep's Vpass binding
// insert did on 2026-11-25, when every later statement of the tick failed as
// overloaded) must not leave the hour looking unclaimed, or every later tick
// of the hour runs as its first.
//
// What it counts is what D1 reports: `rows_read` of every `all()`, `run()`
// and batch result. A `first()` returns no metadata, so a statement read that
// way is not counted (the `invocation_budget` line shows those as `missing`).

/** Rows read per rolling 24 hours above which the derived lanes slow down. */
export const D1_ROWS_READ_DAILY_BUDGET = 300_000_000;

const HOUR_MS = 3_600_000;
/** Hours of rows kept: the 24 the budget sums, and a day more to read back. */
const RETENTION_HOURS = 48;

/**
 * The lanes that recompute from what is already stored. While the budget is
 * exceeded they run on the first scheduled tick of each hour only.
 */
export const READ_BUDGET_THROTTLED_LANES: ReadonlySet<string> = new Set([
  "identity_sweep",
  "instrument_auto_adoption",
  "balance_projection",
  "reconciliation_sweep",
  "card_debit_account_sweep",
  "card_settlement_sweep",
  "purchase_recognition",
  "reward_claims_sweep",
  "reward_read_projection",
  "price_promotion",
  "report_job",
  "decision_outbox",
]);

/** How recent the identity sweep's latest tick record must be to keep it draining. */
const DRAIN_RECORD_MAX_AGE_MS = 15 * 60_000;

/**
 * Whether the identity sweep is draining a backlog: its latest tick record is
 * from the last 15 minutes, ran, made progress (sealed a run or identified an
 * observation) and took a full page (`pageRuns` parse runs, or its
 * observation cap, which can stop inside one large parse before it seals). While it is, the sweep
 * runs on every tick even above the budget, so a parse backlog is identified
 * in hours rather than days: every identity run moves the CORE revision, and
 * the card sweeps then read their whole input again on each hourly tick until
 * identity catches up.
 *
 * Anything else ends it: a short page; a failed sweep; a page that made no
 * progress (runs that are selected again on every tick but never sealed at
 * their required policy would otherwise keep a full page for ever); and a
 * sweep whose own record was lost (the latest record is then older than the
 * draining cadence), so a sweep that keeps failing, or keeps D1 from recording
 * it, goes back to once an hour. A failed read answers false.
 */
export async function identityBacklogDraining(
  db: D1Database,
  nowMs: number,
  pageRuns: number,
  pageObservations: number,
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT outcome,started_at_ms,json_extract(counts_json,'$.processedRuns') AS runs,
           json_extract(counts_json,'$.identifiedRuns') AS identified,
           json_extract(counts_json,'$.identifiedObservations') AS observations
         FROM processor_lane_ticks WHERE lane='identity_sweep'
         ORDER BY id DESC LIMIT 1`,
      )
      .all<{
        outcome: string;
        started_at_ms: number;
        runs: number | null;
        identified: number | null;
        observations: number | null;
      }>();
    const latest = row.results[0];
    if (latest?.outcome !== "ran") return false;
    if (nowMs - Number(latest.started_at_ms) > DRAIN_RECORD_MAX_AGE_MS) return false;
    // Progress: a sealed run, or observations of a parse the cap cut short.
    if (Number(latest.identified ?? 0) < 1 && Number(latest.observations ?? 0) < 1) return false;
    return (
      Number(latest.runs ?? 0) >= pageRuns || Number(latest.observations ?? 0) >= pageObservations
    );
  } catch {
    return false;
  }
}

export interface ReadBudgetState {
  /** Rows read in the current hour and the 23 before it. */
  rowsRead24h: number;
  over: boolean;
  /** Over the budget, and a scheduled tick already ran this hour. */
  throttled: boolean;
}

export function hourStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** The budget as of `nowMs`; null when it cannot be read, and then nothing is throttled. */
export async function readBudgetState(
  db: D1Database,
  nowMs: number,
  budget: number = D1_ROWS_READ_DAILY_BUDGET,
): Promise<ReadBudgetState | null> {
  const hour = hourStart(nowMs);
  try {
    const row = await db
      .prepare(
        `SELECT coalesce(sum(rows_read),0) AS rows_read,
          coalesce(sum(CASE WHEN hour_start_ms=?2 THEN scheduled_ticks ELSE 0 END),0) AS ticks
         FROM processor_read_budget_hours WHERE hour_start_ms>?1`,
      )
      .bind(hour - 24 * HOUR_MS, hour)
      .first<{ rows_read: number; ticks: number }>();
    const rowsRead24h = Number(row?.rows_read ?? 0);
    const over = rowsRead24h > budget;
    return { rowsRead24h, over, throttled: over && Number(row?.ticks ?? 0) > 0 };
  } catch {
    return null;
  }
}

/**
 * Counts one scheduled tick in the hour of `nowMs`, before its lanes run, and
 * answers how many scheduled ticks that hour has counted with it. A tick that
 * gets more than 1 is not the hour's first, even when its budget read saw no
 * tick (two ticks that overlap at the start of an hour).
 */
export async function claimScheduledTick(db: D1Database, nowMs: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO processor_read_budget_hours(hour_start_ms,rows_read,scheduled_ticks,queue_invocations)
       VALUES(?1,0,1,0)
       ON CONFLICT(hour_start_ms) DO UPDATE SET scheduled_ticks=scheduled_ticks+1
       RETURNING scheduled_ticks`,
    )
    .bind(hourStart(nowMs))
    .all<{ scheduled_ticks: number }>();
  return Number(row.results[0]?.scheduled_ticks ?? 0);
}

/**
 * Adds one invocation's rows read to the hour it started in, and drops the
 * rows older than the retention, in one batch. A queue batch also counts
 * itself here; a scheduled tick counted itself when it started
 * (`claimScheduledTick`).
 */
export async function recordRowsRead(
  db: D1Database,
  startedAtMs: number,
  rowsRead: number,
  trigger: "scheduled" | "queue",
): Promise<void> {
  const hour = hourStart(startedAtMs);
  const rows = Number.isSafeInteger(rowsRead) && rowsRead > 0 ? rowsRead : 0;
  await db.batch([
    db
      .prepare(
        `INSERT INTO processor_read_budget_hours(hour_start_ms,rows_read,scheduled_ticks,queue_invocations)
         VALUES(?1,?2,?3,?4)
         ON CONFLICT(hour_start_ms) DO UPDATE SET rows_read=rows_read+excluded.rows_read,
          scheduled_ticks=scheduled_ticks+excluded.scheduled_ticks,
          queue_invocations=queue_invocations+excluded.queue_invocations`,
      )
      .bind(hour, rows, 0, trigger === "queue" ? 1 : 0),
    db
      .prepare("DELETE FROM processor_read_budget_hours WHERE hour_start_ms<?1")
      .bind(hour - RETENTION_HOURS * HOUR_MS),
  ]);
}
