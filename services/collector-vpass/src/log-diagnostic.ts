import type { ScheduledResult } from "../../../packages/collection/src/schedule-result";
/** Receives only already-redacted collector records. This is not a sanitizer. */
export function logVpassDiagnostic(record: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(record));
  } catch {
    /* Logging cannot change the result or cause another provider/storage attempt. */
  }
}
/**
 * The answer the Processor receives, in closed codes, so a busy or failed run
 * has a line of its own. Who held the lease on a busy run is logged by the
 * lease itself (`collection_lease_busy`).
 */
export function scheduledResultDiagnostic(
  result: ScheduledResult,
  scheduledTime: number,
  durationMs: number,
): Record<string, unknown> {
  const nominal = new Date(scheduledTime);
  return {
    event: "vpass-scheduled-result",
    nominalAt: Number.isNaN(nominal.getTime()) ? null : nominal.toISOString(),
    status: result.status,
    failureCode: result.failureCode,
    runCount: result.runIds.length,
    durationMs,
  };
}
