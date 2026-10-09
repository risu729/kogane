// The daily overflow aggregate of the common audit record (ADR 0064, "Daily
// caps"). Past a principal's daily `read` or `refused` cap the App only counts
// events in `audit_overflow_counters`; the first tick after that UTC day ends
// turns each counter row into one `overflow` record with the exact count and
// deletes the row in the same batch. A tick with no ended day writes nothing.
import { aggregateAuditOverflow, d1CommandStore } from "../../../packages/application/src/index.ts";

export interface AuditOverflowResult {
  /** Counter rows of ended days read this tick (at most `OVERFLOW_ROWS_PER_TICK`). */
  counters: number;
  /** Overflow records written; a counter that moved meanwhile waits for the next tick. */
  written: number;
}

export function auditOverflowStage(env: Env, now: Date = new Date()): Promise<AuditOverflowResult> {
  return aggregateAuditOverflow(d1CommandStore(env.DB), now);
}
