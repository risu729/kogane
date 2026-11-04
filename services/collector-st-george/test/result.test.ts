import { expect, test, spyOn } from "bun:test";
import { FAILURE_CODES, logStGeorgeResult, stGeorgeScheduledResult } from "../src/result";

test("the alarm keeps each known refusal distinct, without passing arbitrary text", () => {
  for (const reason of FAILURE_CODES) {
    const result = stGeorgeScheduledResult({ status: "blocked", reason, runId: "synthetic-run" });
    expect(result).toEqual({
      status: "failed",
      runIds: ["synthetic-run"],
      failureCode: `st_george_${reason.replaceAll("-", "_")}`,
    });
  }
  expect(
    stGeorgeScheduledResult({ status: "blocked", reason: "synthetic_secret" }).failureCode,
  ).toBe("collection_failed");
  expect(stGeorgeScheduledResult({ status: "busy" }).failureCode).toBe("collection_busy");
  expect(
    stGeorgeScheduledResult({ status: "failed", reason: "persistence-incomplete" }).failureCode,
  ).toBe("terminal_persistence_failed");
  expect(
    stGeorgeScheduledResult({ status: "failed", reason: "state-unavailable" }).failureCode,
  ).toBe("collector_state_unavailable");
  expect(stGeorgeScheduledResult({ status: "stored", runId: "synthetic-run" })).toEqual({
    status: "completed",
    runIds: ["synthetic-run"],
    failureCode: null,
  });
});

test("result logging contains no provider response, labels or exception text", () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    logStGeorgeResult({
      status: "blocked",
      reason: "synthetic_secret",
      password: "secret",
      snapshot: { amount: "99999" },
      runId: "synthetic_secret",
    });
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      event: "st-george-collection-result",
      status: "failed",
      failureCode: "collection_failed",
      runCount: 1,
    });
    logStGeorgeResult({ status: "ready" });
    expect(JSON.parse(log.mock.calls[1]![0] as string)).toEqual({
      event: "st-george-collection-result",
      status: "ready",
      failureCode: null,
      runCount: 0,
    });
    log.mockImplementation(() => {
      throw new Error("synthetic_log_failure");
    });
    expect(() => logStGeorgeResult({ status: "blocked", reason: "human-required" })).not.toThrow();
  } finally {
    log.mockRestore();
  }
});
