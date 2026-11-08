import {
  scheduledResult,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";

export const FAILURE_CODES = [
  "human-required",
  "login-rejected",
  "bank-request-error",
  "network-error",
  "unexpected-page",
  "navigation-denied",
  "invalid-credentials",
  "invalid-snapshot",
  "container-failed",
  "collection-interrupted",
  "invalid-configuration",
  "invalid-request",
  "runtime-unavailable",
  "runtime-failed",
  "deadline-exceeded",
  "authentication-challenge",
  "http-denied",
  "unexpected-route",
  "login-layout-unknown",
  "session-expired",
  "navigation-failed",
  "snapshot-shape",
  "account-limit",
  "snapshot-limit",
  "download-blocked",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export function safeFailureCode(value: unknown): FailureCode {
  return FAILURE_CODES.includes(value as FailureCode) ? (value as FailureCode) : "container-failed";
}

/**
 * The closed code of an error the lease-held collection threw. A holder that
 * stopped itself (ADR 0085) keeps its reason instead of `container-failed`:
 * its deadline is `deadline-exceeded`, a lost lease is `collection-interrupted`.
 * Either is a failed run; neither blocks the next run (only a refused or
 * challenged login does).
 */
export function thrownFailureCode(error: unknown): FailureCode {
  const message = error instanceof Error ? error.message : null;
  if (message === "collection_deadline_exceeded") return "deadline-exceeded";
  if (message === "collection_lease_lost") return "collection-interrupted";
  return safeFailureCode(message);
}

/** The alarm must not collapse a durable block, R2 outage and provider refusal into one code. */
export function stGeorgeScheduledResult(value: unknown): ScheduledResult {
  const base = scheduledResult(value);
  if (base.status === "completed") return base;
  const result = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  let failureCode = "collection_failed";
  if (result.status === "busy") failureCode = "collection_busy";
  else if (result.reason === "persistence-incomplete")
    // The run stays pending under its id with no terminal; a later trigger
    // reports it once it is stored. It is not a persisted run of this alarm.
    return { ...base, runIds: [], failureCode: "terminal_persistence_failed" };
  else if (result.reason === "persistence-pending") failureCode = "terminal_persistence_pending";
  else if (result.reason === "state-unavailable") failureCode = "collector_state_unavailable";
  else if (FAILURE_CODES.includes(result.reason as FailureCode))
    // A run skipped during a login pause contacted nobody: its own code.
    failureCode = `st_george_${result.status === "paused" ? "paused_" : ""}${safeFailureCode(
      result.reason,
    ).replaceAll("-", "_")}`;
  // A skipped run wrote nothing: the run that caused the pause is not its run.
  if (result.status === "paused") return { ...base, runIds: [], failureCode };
  return { ...base, failureCode };
}

/** Fixed event/keys and closed codes only; never serializes the coordinator response. */
export function logStGeorgeResult(value: unknown): void {
  try {
    const result = stGeorgeScheduledResult(value);
    console.log(
      JSON.stringify({
        event: "st-george-collection-result",
        status: result.status,
        failureCode: result.failureCode,
        runCount: result.runIds.length,
      }),
    );
  } catch {
    /* A diagnostic must not change a stored result. */
  }
}
