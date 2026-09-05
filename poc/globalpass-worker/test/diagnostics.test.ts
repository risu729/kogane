import { describe, expect, test, spyOn } from "bun:test";
import { logEvent, relayRunId, withRunId } from "../src/log-context";
// @ts-expect-error runtime container module is tested directly
import { createBrowserDiagnostics } from "../container/diagnostics.mjs";
const runId = "01234567-89ab-4cde-8fab-0123456789ab";
describe("GLOBAL PASS diagnostic boundaries", () => {
  test("preserves relay routing and accepts only run UUID metadata", () => {
    const url = new URL(withRunId("wss://relay.test/tcp?network=tamia", runId));
    expect(url.searchParams.get("network")).toBe("tamia");
    expect(relayRunId(url)).toBe(runId);
    expect(relayRunId(new URL("https://relay.test/?runId=private-account-value"))).toBeUndefined();
  });
  test("emits stage, UUID, status and safe type without exception content", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line) => { lines.push(String(line)); });
    const error = Object.assign(new Error("password=private-token; body=private-account"), { name: "private-secret-name" });
    try {
      const diag = createBrowserDiagnostics(withRunId("wss://relay.test/tcp", runId));
      await expect(diag.step("login-submit", async () => { diag.http(503); throw error; })).rejects.toBe(error);
      const text = lines.join("\n");
      expect(text).not.toContain("private-");
      expect(text).toContain(runId);
      expect(text).toContain('"httpStatus":503');
      expect(text).toContain('"errorType":"UnknownError"');
      expect(text).toContain('"stage":"login-submit"');
    } finally { spy.mockRestore(); }
  });
  test("logging failure cannot replace the original exception", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => { throw new Error("logger unavailable"); });
    const original = new Error("original");
    try {
      await expect(createBrowserDiagnostics("invalid").step("challenge", async () => { throw original; })).rejects.toBe(original);
    } finally { spy.mockRestore(); }
  });
  test("snapshots an adversarial error name once before allowlisting", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line) => { lines.push(String(line)); });
    let reads = 0;
    const original = new Error("private-message");
    Object.defineProperty(original, "name", { get: () => ++reads === 1 ? "Error" : "private-name" });
    try {
      try { await createBrowserDiagnostics("invalid").step("challenge", () => { throw original; }); }
      catch (caught) { expect(caught === original).toBe(true); }
      expect(reads).toBe(1);
      expect(lines.join("\n")).not.toContain("private-");
    } finally { spy.mockRestore(); }
  });
  test("Worker logging is best effort at each severity", () => {
    for (const level of ["log", "warn", "error"] as const) {
      const spy = spyOn(console, level).mockImplementation(() => { throw new Error("logger unavailable"); });
      try { expect(() => logEvent(level, "{}" )).not.toThrow(); }
      finally { spy.mockRestore(); }
    }
  });
});
