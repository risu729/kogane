import { describe, expect, test } from "bun:test";
import { isResumable } from "../src/progress";
import type { BackfillProgress } from "../src/types";

const progress = (phase: BackfillProgress["phase"]): BackfillProgress => ({
  phase,
  createdAt: "2026-09-01T00:00:00.000Z",
  challengeExpiresAt: null,
  runId: "run-id",
  startedAt: "2026-09-01T00:00:00.000Z",
  completedAt: phase === "partial" ? "2026-09-01T00:10:00.000Z" : null,
  from: "2019-01-01",
  to: "2026-09-01",
  nextRange: null,
  completedChunks: 48,
  totalChunks: 93,
  transactionCount: 188,
  artifactCount: 98,
  retryCount: 3,
  lastErrorCode: "logout_failed",
  logoutSucceeded: false,
  manifestKey: "raw/smbc-direct/run/manifest.json",
});

describe("isResumable", () => {
  test("resumes a partial run and its waiting-for-new-approval state", () => {
    expect(isResumable(progress("partial"))).toBeTrue();
    expect(isResumable(progress("waiting_for_approval"))).toBeTrue();
  });

  test("does not resume a completed or identity-free run", () => {
    expect(isResumable({ ...progress("success"), completedChunks: 93 })).toBeFalse();
    expect(isResumable({ ...progress("partial"), runId: null })).toBeFalse();
  });
});
