import { describe, expect, test } from "bun:test";
import { isResumable } from "../src/progress";
import { classifyError } from "../src/session";
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

describe("collector failure codes", () => {
  test("keeps only fixed collection codes and bounded HTTP patterns", () => {
    expect(classifyError(new Error("transactions_http_503"))).toBe("transactions_http_503");
    expect(classifyError(new Error("transaction_direction_invalid")))
      .toBe("transaction_direction_invalid");
    expect(classifyError(new Error("arbitrary_safe_code"))).toBe("unexpected_error");
    expect(classifyError(new Error("transactions_http_999"))).toBe("unexpected_error");
    expect(classifyError(new TypeError("arbitrary_safe_code"))).toBe("type_error");
    expect(classifyError(new SyntaxError("arbitrary_safe_code"))).toBe("json_parse_failed");
  });
});
