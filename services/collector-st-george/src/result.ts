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

/** The alarm must not collapse a durable block, R2 outage and provider refusal into one code. */
export function stGeorgeScheduledResult(value: unknown): ScheduledResult {
  const base = scheduledResult(value);
  if (base.status === "completed") return base;
  const result = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  let failureCode = "collection_failed";
  if (result.status === "busy") failureCode = "collection_busy";
  else if (result.reason === "persistence-incomplete") failureCode = "terminal_persistence_failed";
  else if (result.reason === "persistence-pending") failureCode = "terminal_persistence_pending";
  else if (result.reason === "state-unavailable") failureCode = "collector_state_unavailable";
  else if (FAILURE_CODES.includes(result.reason as FailureCode))
    failureCode = `st_george_${safeFailureCode(result.reason).replaceAll("-", "_")}`;
  return { ...base, failureCode };
}

/** Fixed event/keys and closed codes only; never serializes the coordinator response. */
export function logStGeorgeResult(value: unknown): void {
  try {
    if (value && typeof value === "object" && "status" in value && value.status === "ready") {
      console.log(
        JSON.stringify({
          event: "st-george-collection-result",
          status: "ready",
          failureCode: null,
          runCount: 0,
        }),
      );
      return;
    }
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
