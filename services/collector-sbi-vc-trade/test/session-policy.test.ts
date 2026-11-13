import { describe, expect, test } from "bun:test";
import {
  AGREEMENT_RETRY_COOLDOWN_MS,
  AGREEMENT_RETRY_WINDOW_MS,
  blockedScheduleResult,
  manualAgreementPendingSince,
  REAUTH_COOLDOWN_MS,
  reauthCooldownMs,
  sessionFailureCode,
  shouldReauthenticate,
} from "../src/session-policy";
import type { HealthState, SharedRunSummary } from "../src/types";

const health: HealthState = {
  initializedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastHttpStatus: 403,
  lastGatewayStatus: null,
  lastCookieUpdateCount: 0,
  consecutiveFailures: 1,
  lastErrorCode: "http_rejected",
  lastReauthAttemptAt: null,
  lastReauthSuccessAt: null,
  lastReauthErrorCode: "manual_agreement_required",
  manualAgreementPendingSince: null,
  sessionRefreshRequired: false,
};
const summary: SharedRunSummary = {
  runId: "00000000-0000-4000-8000-000000000000",
  target: "shared",
  outcome: "persisted",
  terminalKey: "synthetic-terminal",
  terminalDigest: "a".repeat(64),
  objectCount: 1,
  manifestObjectKey: "synthetic-manifest",
  waitingForHuman: true,
};

describe("SBI VC session refusal diagnostics", () => {
  test("a pending agreement keeps an explicit reason and no longer stops the login", () => {
    expect(shouldReauthenticate(health)).toBe(true);
    expect(sessionFailureCode(health)).toBe("manual_agreement_required");
    expect(shouldReauthenticate({ ...health, lastReauthErrorCode: null })).toBe(true);
    // A healthy keepalive keeps the old code; it is not a reason to log in.
    expect(shouldReauthenticate({ ...health, lastHttpStatus: 200, lastErrorCode: null })).toBe(
      false,
    );
  });
  test("the gateway's redirect of a stale session triggers a login only while an agreement is pending", () => {
    const redirected = { ...health, lastHttpStatus: 302, lastErrorCode: "http_rejected" };
    expect(shouldReauthenticate(redirected)).toBe(true);
    expect(shouldReauthenticate({ ...redirected, lastReauthErrorCode: null })).toBe(false);
    expect(shouldReauthenticate({ ...redirected, lastHttpStatus: 503 })).toBe(false);
    expect(shouldReauthenticate({ ...redirected, lastHttpStatus: null })).toBe(false);
    // A retry that failed for another reason keeps the wait open until a login succeeds.
    const interrupted = {
      ...redirected,
      lastReauthErrorCode: "passkey_http_503",
      manualAgreementPendingSince: "2026-11-07T04:30:00.000Z",
    };
    expect(shouldReauthenticate(interrupted)).toBe(true);
    expect(shouldReauthenticate({ ...interrupted, manualAgreementPendingSince: null })).toBe(false);
  });
  test("logins are hourly for 72 hours after the first agreement refusal, then six-hourly", () => {
    const now = Date.parse("2026-11-07T06:00:00.000Z");
    const since = (hours: number) => ({
      ...health,
      manualAgreementPendingSince: new Date(now - hours * 3_600_000).toISOString(),
    });
    expect(AGREEMENT_RETRY_COOLDOWN_MS).toBe(3_600_000);
    expect(AGREEMENT_RETRY_WINDOW_MS).toBe(72 * 3_600_000);
    expect(reauthCooldownMs(since(0), now)).toBe(AGREEMENT_RETRY_COOLDOWN_MS);
    expect(reauthCooldownMs(since(71.9), now)).toBe(AGREEMENT_RETRY_COOLDOWN_MS);
    expect(reauthCooldownMs(since(72), now)).toBe(REAUTH_COOLDOWN_MS);
    // A record from before the window was tracked: the next refusal opens it.
    expect(reauthCooldownMs(health, now)).toBe(AGREEMENT_RETRY_COOLDOWN_MS);
    expect(reauthCooldownMs({ ...since(1), lastReauthErrorCode: null }, now)).toBe(
      REAUTH_COOLDOWN_MS,
    );
    expect(
      reauthCooldownMs({ ...since(1), lastReauthErrorCode: "passkey_login_rejected" }, now),
    ).toBe(REAUTH_COOLDOWN_MS);
  });
  test("the window opens at the first refusal and only a successful login closes it", () => {
    const first = "2026-11-07T04:30:00.000Z";
    const later = "2026-11-07T05:30:00.000Z";
    const fresh = { ...health, lastReauthErrorCode: null };
    expect(manualAgreementPendingSince(fresh, "manual_agreement_required", first)).toBe(first);
    expect(manualAgreementPendingSince(fresh, "passkey_login_rejected", first)).toBeNull();
    const pending = { ...health, manualAgreementPendingSince: first };
    expect(manualAgreementPendingSince(pending, "manual_agreement_required", later)).toBe(first);
    // A record from before the window was tracked opens it at its next refusal.
    expect(manualAgreementPendingSince(health, "manual_agreement_required", later)).toBe(later);
    expect(
      manualAgreementPendingSince(
        { ...pending, manualAgreementPendingSince: "not-a-time" },
        "manual_agreement_required",
        later,
      ),
    ).toBe(later);
    // A different failure in between (maintenance, network) neither closes nor
    // reopens the window, so the hourly retries stay bounded by the first refusal.
    expect(manualAgreementPendingSince(pending, "passkey_http_503", later)).toBe(first);
    expect(
      manualAgreementPendingSince(
        { ...pending, lastReauthErrorCode: "passkey_http_503" },
        "manual_agreement_required",
        later,
      ),
    ).toBe(first);
  });
  test("a persisted blocked attempt remains linked to the scheduled occurrence", () => {
    expect(blockedScheduleResult(health, summary)).toEqual({
      status: "failed",
      runIds: [summary.runId],
      failureCode: "manual_agreement_required",
    });
    expect(
      blockedScheduleResult(health, { ...summary, outcome: "already_persisted" }).runIds,
    ).toEqual([summary.runId]);
  });
  test("incomplete and conflicting storage cannot look like a persisted refusal", () => {
    for (const outcome of ["incomplete", "conflict"] as const)
      expect(blockedScheduleResult(health, { ...summary, outcome })).toEqual({
        status: "failed",
        runIds: [],
        failureCode: "terminal_persistence_failed",
      });
  });
  test("unknown exception text never becomes a reason code; healthy keepalive has no failure", () => {
    expect(
      sessionFailureCode({ ...health, lastReauthErrorCode: "synthetic_secret_material" }),
    ).toBe("human_required_reauth");
    expect(sessionFailureCode({ ...health, lastReauthErrorCode: null })).toBe(
      "session_unavailable",
    );
    expect(sessionFailureCode({ ...health, lastErrorCode: null })).toBeNull();
  });
});
