import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { afterEach, expect, spyOn, test } from "bun:test";
import worker from "../src/worker";
import { collectMobileSuica } from "../src/mobile-suica";
import { safeErrorDetails } from "../../../packages/collector-diagnostics/src/index";

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});
function capture() {
  const records: Array<Record<string, unknown>> = [];
  for (const method of ["log", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation((value) =>
      records.push(JSON.parse(String(value))),
    );
    restores.push(() => spy.mockRestore());
  }
  return records;
}

test("configuration failure remains distinguishable from manifest and central import outcomes", async () => {
  const records = capture();
  const data = new FakeR2Bucket();
  const env = {
    COLLECTOR_SCHEMA_VERSION: "mobile-suica-worker-poc-v2",
    DATA: data,
  } as unknown as Env;
  await expect(worker.scheduled({} as ScheduledController, env)).rejects.toThrow(
    "collection incomplete",
  );
  const terminal = [...data.entries].find(([key]) => key.endsWith("/terminal.json"));
  expect(JSON.parse(new TextDecoder().decode(terminal![1].bytes)).providerOutcome).toBe("failed");
  expect(records).toContainEqual(
    expect.objectContaining({
      stage: "configuration",
      outcome: "failed",
      category: "configuration",
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({ stage: "terminal-write", outcome: "success" }),
  );
  expect(records).not.toContainEqual(expect.objectContaining({ stage: "central-import" }));
  expect(records).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "failed" }));
  expect(
    new Set(
      records
        .filter((record) => record.event === "collector-diagnostic")
        .map((record) => record.runId),
    ).size,
  ).toBe(1);
});

test("R2 failure records its own stage without leaking error text", async () => {
  const records = capture();
  const data = new FakeR2Bucket();
  data.faults = {
    beforePut: () => {
      throw new Error("secret-cookie provider-body");
    },
  };
  const env = {
    DATA: data,
    COLLECTOR_SCHEMA_VERSION: "mobile-suica-worker-poc-v2",
  } as unknown as Env;
  await expect(worker.scheduled({} as ScheduledController, env)).rejects.toThrow(
    "collection incomplete",
  );
  expect(data.putKeys.some((key) => key.endsWith("/terminal.json"))).toBe(false);

  expect(records).not.toContainEqual(expect.objectContaining({ stage: "central-import" }));
  expect(JSON.stringify(records)).not.toMatch(/secret|example|provider-body/u);
});

test("history HTTP failures preserve status without retaining a financial response body", async () => {
  const mock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("private-account-body", { status: 503 }),
  );
  restores.push(() => mock.mockRestore());
  let error: unknown;
  try {
    await collectMobileSuica({
      session: { cookieHeader: "session=test", formBody: "baseVariable=test", userAgent: "test" },
      asOfDateJst: "2026-09-05",
    });
  } catch (caught) {
    error = caught;
  }
  expect(safeErrorDetails(error)).toMatchObject({
    category: "http",
    httpStatus: 503,
    code: "history_request_failed",
  });
  expect(JSON.stringify(safeErrorDetails(error))).not.toContain("private-account-body");
});
