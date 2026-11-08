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

test("a failed run with a written terminal reports its run id and its own code", () => {
  expect(
    stGeorgeScheduledResult({
      status: "failed",
      reason: "runtime-failed",
      runId: "00000000-0000-4000-8000-000000000000",
      terminalKey: "runs/st-george/synthetic.json",
    }),
  ).toEqual({
    status: "failed",
    runIds: ["00000000-0000-4000-8000-000000000000"],
    failureCode: "st_george_runtime_failed",
  });
});

test("a run the coordinator could not persist is not reported as a persisted run", () => {
  // The coordinator's own answer when the terminal write failed: the run is
  // kept pending under its id and has no terminal yet.
  expect(
    stGeorgeScheduledResult({
      status: "failed",
      reason: "persistence-incomplete",
      runId: "00000000-0000-4000-8000-000000000000",
    }),
  ).toEqual({ status: "failed", runIds: [], failureCode: "terminal_persistence_failed" });
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
    logStGeorgeResult({ status: "paused", reason: "login-rejected", runId: "synthetic-run" });
    expect(JSON.parse(log.mock.calls[1]![0] as string)).toEqual({
      event: "st-george-collection-result",
      status: "failed",
      failureCode: "st_george_paused_login_rejected",
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

test("a run skipped during a login pause has its own code; the refused attempt keeps its reason", () => {
  expect(
    stGeorgeScheduledResult({
      status: "paused",
      reason: "authentication-challenge",
      runId: "synthetic-run",
    }),
  ).toEqual({
    status: "failed",
    runIds: [],
    failureCode: "st_george_paused_authentication_challenge",
  });
  expect(
    stGeorgeScheduledResult({ status: "blocked", reason: "login-rejected", runId: "synthetic-run" })
      .failureCode,
  ).toBe("st_george_login_rejected");
});
