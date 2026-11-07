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

const MANUAL_AGREEMENT = "manual_agreement_required";
/** The usual spacing of unattended passkey logins. */
export const REAUTH_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** While the owner's terms agreement is pending, a login is retried this often... */
export const AGREEMENT_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
/** ...for this long after the first refused login, then at the usual spacing (owner, 2026-11-07 06:28 UTC). */
export const AGREEMENT_RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * Whether the keepalive's result calls for a passkey login. A pending terms
 * agreement no longer stops it: the next login after the owner agrees at
 * simple.sbivc.co.jp succeeds and collection resumes on its own. While the
 * agreement is pending the gateway answers the stale session with a redirect
 * (`http_rejected`, 3xx), which then also counts as a refused session.
 */
export function shouldReauthenticate(health: HealthState): boolean {
  if (
    health.lastReauthErrorCode === MANUAL_AGREEMENT &&
    health.lastErrorCode === "http_rejected" &&
    health.lastHttpStatus !== null &&
    health.lastHttpStatus >= 300 &&
    health.lastHttpStatus < 400
  )
    return true;
  return (
    health.lastHttpStatus === 401 ||
    health.lastHttpStatus === 403 ||
    health.lastErrorCode === "gateway_rejected" ||
    health.lastErrorCode === "load_session_missing_session_seed"
  );
}

/** How long an unforced login waits after the previous attempt. */
export function reauthCooldownMs(health: HealthState, now: number): number {
  if (health.lastReauthErrorCode !== MANUAL_AGREEMENT) return REAUTH_COOLDOWN_MS;
  const since = Date.parse(health.manualAgreementPendingSince ?? "");
  // A record written before the window was tracked opens it at the next refusal.
  if (!Number.isFinite(since)) return AGREEMENT_RETRY_COOLDOWN_MS;
  return now - since < AGREEMENT_RETRY_WINDOW_MS ? AGREEMENT_RETRY_COOLDOWN_MS : REAUTH_COOLDOWN_MS;
}

/** When the current run of agreement refusals began; null once a login ends otherwise. */
export function manualAgreementPendingSince(
  previous: HealthState,
  errorCode: string | null,
  attemptAt: string,
): string | null {
  if (errorCode !== MANUAL_AGREEMENT) return null;
  const since = previous.manualAgreementPendingSince;
  return previous.lastReauthErrorCode === MANUAL_AGREEMENT &&
    since !== null &&
    Number.isFinite(Date.parse(since))
    ? since
    : attemptAt;
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
