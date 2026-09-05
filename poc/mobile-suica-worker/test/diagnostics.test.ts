import { afterEach, expect, spyOn, test } from "bun:test";
import worker from "../src/worker";
import { collectMobileSuica } from "../src/mobile-suica";
import { safeErrorDetails } from "../../collector-diagnostics/src/index";

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
function capture() {
  const records: Array<Record<string, unknown>> = [];
  for (const method of ["log", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation(value => records.push(JSON.parse(String(value))));
    restores.push(() => spy.mockRestore());
  }
  return records;
}

test("configuration failure remains distinguishable from manifest and central import outcomes", async () => {
  const records = capture();
  let storedManifest: Record<string, unknown> | undefined;
  const env = {
    COLLECTOR_SCHEMA_VERSION: "mobile-suica-worker-poc-v2",
    SNAPSHOTS: { put: async (_key: string, body: string) => { storedManifest = JSON.parse(body); } },
    RAW_EVIDENCE_IMPORTER: { fetch: async (request: Request) => {
      const { manifestKey } = await request.json() as { manifestKey: string };
      return Response.json({ source: "mobile-suica", manifestKey, status: "sealed", centralRunId: 1, artifactCount: 1, sealed: true, finalChunkAllObjectsReused: false });
    } },
  } as unknown as Env;
  await expect(worker.scheduled({} as ScheduledController, env)).rejects.toThrow("collection incomplete");
  expect(storedManifest?.status).toBe("failed");
  expect(records).toContainEqual(expect.objectContaining({ stage: "configuration", outcome: "failed", category: "configuration" }));
  expect(records).toContainEqual(expect.objectContaining({ stage: "manifest-write", outcome: "success" }));
  expect(records).toContainEqual(expect.objectContaining({ stage: "central-import", outcome: "success" }));
  expect(records).toContainEqual(expect.objectContaining({ stage: "terminal", outcome: "failed" }));
  expect(new Set(records.filter(record => record.event === "collector-diagnostic").map(record => record.runId)).size).toBe(1);
});

test("R2 failure records its own stage without leaking error text", async () => {
  const records = capture();
  const error = new Error("secret-cookie user@example.test provider-body");
  const env = { SNAPSHOTS: { put: async () => { throw error; } } } as unknown as Env;
  await expect(worker.scheduled({} as ScheduledController, env)).rejects.toBe(error);
  expect(records).toContainEqual(expect.objectContaining({ stage: "manifest-write", outcome: "failed" }));
  expect(records).not.toContainEqual(expect.objectContaining({ stage: "central-import" }));
  expect(JSON.stringify(records)).not.toMatch(/secret|example|provider-body/u);
});

test("history HTTP failures preserve status without retaining a financial response body", async () => {
  const mock = spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-account-body", { status: 503 }));
  restores.push(() => mock.mockRestore());
  let error: unknown;
  try {
    await collectMobileSuica({ session: { cookieHeader: "session=test", formBody: "baseVariable=test", userAgent: "test" }, asOfDateJst: "2026-09-05" });
  } catch (caught) { error = caught; }
  expect(safeErrorDetails(error)).toMatchObject({ category: "http", httpStatus: 503, code: "history_request_failed" });
  expect(JSON.stringify(safeErrorDetails(error))).not.toContain("private-account-body");
});
