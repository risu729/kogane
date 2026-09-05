import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createDiagnostics, safeErrorDetails } from "../src/index";

const runId = "00000000-0000-4000-8000-000000000001";
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
const restores: Array<() => void> = [];
function capture() {
  const records: Array<Record<string, unknown>> = [];
  for (const method of ["log", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation((value) => records.push(JSON.parse(String(value))));
    restores.push(() => spy.mockRestore());
  }
  return records;
}

describe("safe collector diagnostics", () => {
  test("keeps only bounded operational metadata from a sensitive exception", async () => {
    const records = capture();
    const error = Object.assign(new Error("https://provider.invalid/account?token=secret-body user@example.test 123456789"), {
      name: "private-user-id", code: "private-secret", httpStatus: 503, cause: { cookie: "secret" },
    });
    const diagnostic = createDiagnostics("vpass", runId);
    await expect(diagnostic.step("statement-collection", () => { throw error; })).rejects.toBe(error);
    diagnostic.finish("partial");
    expect(records.map(record => record.outcome)).toEqual(["started", "failed", "partial"]);
    expect(records[1]).toMatchObject({ runId, source: "vpass", stage: "statement-collection", category: "http", httpStatus: 503, errorType: "UnknownError" });
    expect(JSON.stringify(records)).not.toMatch(/secret|provider|user@|123456789|private|stack|cause/u);
  });

  test("classifies only known codes and numeric statuses", () => {
    expect(safeErrorDetails(new Error("collector_http_429"))).toMatchObject({ category: "http", httpStatus: 429 });
    expect(safeErrorDetails(new Error("payment 500 for user@example.test"))).toEqual({ category: "unknown", errorType: "Error" });
    expect(safeErrorDetails(Object.assign(new Error("x"), { httpStatus: 900 }))).not.toHaveProperty("httpStatus");
    expect(safeErrorDetails(new Error("Missing Worker secret: JRE_ID_CREDENTIAL_JSON"))).toMatchObject({ category: "configuration" });
    expect(safeErrorDetails(new Error("history_session_expired"))).toMatchObject({ category: "authentication", code: "history_session_expired" });
    expect(safeErrorDetails(Object.assign(new Error("html with secrets"), { name: "StopConditionError", code: "collect-credit-export" }))).toMatchObject({ category: "response", code: "collect-credit-export" });
  });

  test("rejects unrecognized source, stage and correlation values", () => {
    const records = capture();
    createDiagnostics("secret-source", "user@example.test").failure("secret-stage", "private-body");
    expect(records[0]).toMatchObject({ source: "unknown", stage: "unknown", runId: "unknown" });
    expect(JSON.stringify(records)).not.toMatch(/secret|example|private/u);
  });

  test("exception accessors and proxies cannot replace the original failure", async () => {
    capture();
    for (const key of ["name", "message", "httpStatus", "status", "code"]) {
      const error = Object.defineProperty(new Error("private-body"), key, { get() { throw new Error("accessor-secret"); } });
      expect(safeErrorDetails(error)).toEqual({ category: "unknown", errorType: "UnknownError" });
      await expect(createDiagnostics("vpass", runId).step("session-open", () => { throw error; })).rejects.toBe(error);
    }
    const error = new Proxy(new Error("body"), { getPrototypeOf() { throw new Error("proxy-secret"); } });
    expect(safeErrorDetails(error)).toEqual({ category: "unknown", errorType: "UnknownError" });
  });

  test("a broken logging sink changes neither values nor thrown errors", async () => {
    for (const method of ["log", "error"] as const) {
      const spy = spyOn(console, method).mockImplementation(() => { throw new Error("logging unavailable"); });
      restores.push(() => spy.mockRestore());
    }
    const diagnostic = createDiagnostics("mobile-suica", runId);
    expect(await diagnostic.step("history-collection", () => 42)).toBe(42);
    const error = new Error("original-provider-failure");
    await expect(diagnostic.step("history-collection", () => { throw error; })).rejects.toBe(error);
    diagnostic.finish("failed");
  });
});
