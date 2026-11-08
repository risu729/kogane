import { expect, test } from "bun:test";
import { scheduledResultDiagnostic } from "../src/log-diagnostic";

test("a busy alarm answer is logged with its closed code and no run ids", () => {
  expect(
    scheduledResultDiagnostic(
      { status: "failed", runIds: [], failureCode: "collection_busy" },
      Date.parse("2026-11-07T21:00:00.000Z"),
      412,
    ),
  ).toEqual({
    event: "vpass-scheduled-result",
    nominalAt: "2026-11-07T21:00:00.000Z",
    status: "failed",
    failureCode: "collection_busy",
    runCount: 0,
    durationMs: 412,
  });
});

test("a completed answer counts its runs without listing them", () => {
  const record = scheduledResultDiagnostic(
    { status: "completed", runIds: ["run-a-card-001", "run-a-card-002"], failureCode: null },
    0,
    5,
  );
  expect(record).toMatchObject({ status: "completed", runCount: 2, failureCode: null });
  expect(JSON.stringify(record)).not.toContain("run-a");
});

test("an out-of-range scheduled time is logged as null instead of throwing", () => {
  expect(
    scheduledResultDiagnostic(
      { status: "failed", runIds: [], failureCode: "invalid_schedule" },
      Number.MAX_SAFE_INTEGER,
      0,
    ).nominalAt,
  ).toBeNull();
});
