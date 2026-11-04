import type { ScheduledResult } from "../../../packages/collection/src/schedule-result";
import type { HealthState, SharedRunSummary } from "./types";

/** A closed operational reason, never the provider's response or exception text. */
export function sessionFailureCode(health: HealthState): string | null {
  if (health.lastErrorCode === null) return null;
  if (health.lastReauthErrorCode === "manual_agreement_required")
    return "manual_agreement_required";
  if (health.lastReauthErrorCode !== null) return "human_required_reauth";
  return "session_unavailable";
}

/** A required agreement is not cleared by repeating the same unattended login. */
export function shouldReauthenticate(health: HealthState): boolean {
  if (health.lastReauthErrorCode === "manual_agreement_required") return false;
  return (
    health.lastHttpStatus === 401 ||
    health.lastHttpStatus === 403 ||
    health.lastErrorCode === "gateway_rejected" ||
    health.lastErrorCode === "load_session_missing_session_seed"
  );
}

/** Keep the persisted refusal linked to its alarm; an R2 failure is a separate failure. */
export function blockedScheduleResult(
  health: HealthState,
  summary: SharedRunSummary,
): ScheduledResult {
  const persisted = summary.outcome === "persisted" || summary.outcome === "already_persisted";
  return {
    status: "failed",
    runIds: persisted ? [summary.runId] : [],
    failureCode: persisted
      ? (sessionFailureCode(health) ?? "session_unavailable")
      : "terminal_persistence_failed",
  };
}
