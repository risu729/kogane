import { afterEach, expect, spyOn, test } from "bun:test";
import worker from "../src/worker";
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

test("scheduled login failure produces a correlated terminal record and safe R2 error", async () => {
  const records: Array<Record<string, unknown>> = [];
  for (const method of ["log", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation((value) =>
      records.push(JSON.parse(String(value))),
    );
    restores.push(() => spy.mockRestore());
  }
  let saved: Record<string, unknown> | undefined;
  const env = {
    SNAPSHOTS: {
      put: async (_key: string, body: string) => {
        saved = JSON.parse(body);
      },
    },
  } as unknown as Parameters<typeof worker.scheduled>[1];
  await expect(
    worker.scheduled(
      { scheduledTime: Date.parse("2026-09-05T00:00:00Z") } as ScheduledController,
      env,
    ),
  ).rejects.toThrow("Missing Worker secret");
  expect(records).toContainEqual(
    expect.objectContaining({
      source: "vpass",
      stage: "session-open",
      outcome: "failed",
      category: "configuration",
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      stage: "terminal",
      outcome: "failed",
      runId: "2026-09-05T00-00-00-000Z",
    }),
  );
  expect(JSON.parse(String(saved?.message))).toEqual({
    category: "configuration",
    errorType: "Error",
  });
});
