import { describe, expect, test } from "bun:test";
import {
  blockedScheduleResult,
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
  test("manual agreement stops unattended reauthentication and is an explicit reason", () => {
    expect(shouldReauthenticate(health)).toBe(false);
    expect(sessionFailureCode(health)).toBe("manual_agreement_required");
    expect(shouldReauthenticate({ ...health, lastReauthErrorCode: null })).toBe(true);
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
