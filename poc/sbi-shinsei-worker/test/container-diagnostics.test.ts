import { afterEach, expect, spyOn, test } from "bun:test";

const { createStageDiagnostics } = await import(
  new URL("../container/stage-diagnostics.mjs", import.meta.url).href
);
const restores: Array<() => void> = [];
afterEach(() => restores.splice(0).forEach((restore) => restore()));

test("container stages correlate login and reads while excluding the relay URL and handoff body", () => {
  const records: Record<string, unknown>[] = [];
  for (const level of ["log", "error"] as const) {
    const spy = spyOn(console, level).mockImplementation((value) =>
      records.push(JSON.parse(String(value))),
    );
    restores.push(() => spy.mockRestore());
  }
  const diagnostic = createStageDiagnostics(
    "wss://private-host.invalid/tcp?token=private-token&runId=00000000-0000-4000-8000-000000000001",
  );
  diagnostic.begin("login-session");
  diagnostic.begin("authenticated-reads");
  const handoff = JSON.stringify({ ok: true, responses: { account: "private-financial-body" } });
  expect(diagnostic.finish(handoff)).toBe(handoff);
  expect(records).toContainEqual(
    expect.objectContaining({
      stage: "login-session",
      outcome: "success",
      runId: "00000000-0000-4000-8000-000000000001",
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({ stage: "terminal", outcome: "success" }),
  );
  expect(records.every((record) => typeof record.durationMs === "number")).toBe(true);
  expect(JSON.stringify(records)).not.toContain("private-");
});

test("unknown stage and correlation are omitted or replaced and cleanup remains nonfatal", async () => {
  const records: Record<string, unknown>[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    const spy = spyOn(console, level).mockImplementation((value) =>
      records.push(JSON.parse(String(value))),
    );
    restores.push(() => spy.mockRestore());
  }
  const diagnostic = createStageDiagnostics("wss://private-host.invalid/?runId=private-person");
  diagnostic.begin("private-stage");
  diagnostic.finish('{"ok":true}');
  await diagnostic.cleanup("browser-close", async () => {
    throw new Error("private-cookie");
  });
  expect(records).toContainEqual(
    expect.objectContaining({ stage: "browser-close", phase: "teardown", outcome: "failed" }),
  );
  expect(records.filter((record) => record.stage === "terminal")).toEqual([
    expect.objectContaining({ outcome: "success" }),
  ]);
  expect(JSON.stringify(records)).not.toContain("private-");
});

test("a partial handoff stays partial in the stage and terminal logs without changing its bytes", () => {
  const records: Record<string, unknown>[] = [];
  for (const level of ["log", "warn"] as const) {
    const spy = spyOn(console, level).mockImplementation((value) =>
      records.push(JSON.parse(String(value))),
    );
    restores.push(() => spy.mockRestore());
  }
  const diagnostic = createStageDiagnostics("wss://worker.invalid/");
  diagnostic.begin("authenticated-reads");
  const handoff = JSON.stringify({
    ok: true,
    responses: { topBalances: "private-response" },
    failure: { dataset: "balance-summary", stage: "balance-summary-http-500" },
  });
  expect(diagnostic.finish(handoff)).toBe(handoff);
  expect(records).toContainEqual(
    expect.objectContaining({ stage: "terminal", outcome: "partial" }),
  );
  expect(records.some((record) => record.outcome === "success")).toBe(false);
});

test("broken logging cannot change collection handoff or prevent cleanup", async () => {
  for (const level of ["log", "warn", "error"] as const) {
    const spy = spyOn(console, level).mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    restores.push(() => spy.mockRestore());
  }
  const diagnostic = createStageDiagnostics("wss://worker.invalid/");
  diagnostic.begin("security-connect");
  const handoff = '{"ok":false,"stage":"security-connect-timeout"}';
  expect(diagnostic.finish(handoff)).toBe(handoff);
  let cleaned = false;
  await diagnostic.cleanup("relay-close", async () => {
    cleaned = true;
  });
  expect(cleaned).toBe(true);
});
