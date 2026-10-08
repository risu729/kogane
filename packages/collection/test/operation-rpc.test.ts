// The collector side of an operations-API request (issue #544, ADR 0048):
// what a collector's `runOperation` accepts, what it runs, and what it
// refuses without contacting anyone. Synthetic identifiers only.
import { expect, test } from "bun:test";
import jobs from "../../../config/alarm-jobs.json";
import {
  COLLECTOR_OPERATION_VERSION,
  collectorOperationResult,
  OPERATION_CONNECTIONS,
  parseCollectorOperationRequest,
  runCollectorOperation,
} from "../src/operation-rpc";
import { withCollectionLease, type ScheduleLeaseDatabase } from "../src/schedule-lease";
import { scheduledFailure, type ScheduledResult } from "../src/schedule-result";

const OPERATION = `op_${"a".repeat(64)}`;
const REQUEST = {
  version: COLLECTOR_OPERATION_VERSION,
  operationId: OPERATION,
  connectionId: "sony-bank",
  source: "sony-bank",
  action: "collect",
  requestedAtMs: 1_790_000_000_000,
};

function recorder(
  result: ScheduledResult = { status: "completed", runIds: ["r1"], failureCode: null },
) {
  const calls: [string, number][] = [];
  return {
    calls,
    run: async (cron: string, time: number) => {
      calls.push([cron, time]);
      return result;
    },
  };
}

test("the connection table is exactly the collector jobs of config/alarm-jobs.json", () => {
  const expected = jobs
    .filter(
      (job) =>
        job.supported &&
        job.workspace?.startsWith("collector-") &&
        (job.kind === "collection" || job.kind === "keepalive"),
    )
    .map((job) => ({
      connectionId: job.id,
      workspace: job.workspace,
      source: job.source,
      action: job.kind === "collection" ? "collect" : "refresh-session",
      cron: job.cron,
    }))
    .sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  const actual = OPERATION_CONNECTIONS.map(({ terminalSource: _terminal, ...rest }) => rest).sort(
    (a, b) => a.connectionId.localeCompare(b.connectionId),
  );
  expect(actual).toEqual(expected);
  // Unsupported sources (no unattended login, email-only) have no connection.
  expect(OPERATION_CONNECTIONS.map((entry) => entry.connectionId)).not.toContain("smbc-direct");
  expect(OPERATION_CONNECTIONS.map((entry) => entry.connectionId)).not.toContain("vpoint-pay");
  // One refresh connection exists today: SBI VC's keepalive.
  expect(
    OPERATION_CONNECTIONS.filter((entry) => entry.action === "refresh-session").map(
      (entry) => entry.connectionId,
    ),
  ).toEqual(["sbi-vc-keepalive"]);
});

test("a valid request runs the connection's own job once, with its cron and the request time", async () => {
  const sony = recorder();
  expect(await runCollectorOperation(REQUEST, "collector-sony-bank", sony.run)).toEqual({
    status: "completed",
    runIds: ["r1"],
    failureCode: null,
  });
  expect(sony.calls).toEqual([["0 21 * * *", REQUEST.requestedAtMs]]);
  // SBI VC serves two connections; each runs its own job shape.
  const vc = recorder({ status: "completed", runIds: [], failureCode: null });
  await runCollectorOperation(
    {
      ...REQUEST,
      connectionId: "sbi-vc-keepalive",
      source: "sbi-vc-trade",
      action: "refresh-session",
    },
    "collector-sbi-vc-trade",
    vc.run,
  );
  await runCollectorOperation(
    { ...REQUEST, connectionId: "sbi-vc-trade", source: "sbi-vc-trade" },
    "collector-sbi-vc-trade",
    vc.run,
  );
  expect(vc.calls.map(([cron]) => cron)).toEqual(["*/15 * * * *", "5 21 * * *"]);
});

test("a request for another collector, source or action is refused before anything runs", async () => {
  const run = recorder();
  const refusals = [
    // Another collector's connection reaching this binding.
    [{ ...REQUEST, connectionId: "myjcb", source: "myjcb" }, "connection_mismatch"],
    // This connection, another source.
    [{ ...REQUEST, source: "myjcb" }, "connection_mismatch"],
    // An unknown connection.
    [{ ...REQUEST, connectionId: "not-a-job" }, "connection_mismatch"],
    // An action the connection does not have: no session refresh is guessed.
    [{ ...REQUEST, action: "refresh-session" }, "action_unsupported"],
  ] as const;
  for (const [request, code] of refusals)
    expect(await runCollectorOperation(request, "collector-sony-bank", run.run)).toEqual({
      status: "failed",
      runIds: [],
      failureCode: code,
    });
  expect(run.calls).toEqual([]);
});

test("the request shape is closed: no extra key, no URL, no coercion", () => {
  expect(parseCollectorOperationRequest(REQUEST).ok).toBe(true);
  const invalid: unknown[] = [
    null,
    [],
    "sony-bank",
    { ...REQUEST, url: "https://example.invalid/" },
    { ...REQUEST, version: "v0" },
    { ...REQUEST, operationId: "op_short" },
    { ...REQUEST, connectionId: "Sony Bank" },
    { ...REQUEST, source: "../sony-bank" },
    { ...REQUEST, action: "login" },
    { ...REQUEST, requestedAtMs: "1790000000000" },
    { ...REQUEST, requestedAtMs: -1 },
    { ...REQUEST, requestedAtMs: 1.5 },
    Object.fromEntries(Object.entries(REQUEST).filter(([key]) => key !== "action")),
  ];
  for (const value of invalid)
    expect(parseCollectorOperationRequest(value)).toEqual({ ok: false, code: "operation_invalid" });
});

test("the Processor accepts back only the closed result shape", () => {
  expect(
    collectorOperationResult({ status: "completed", runIds: ["a", "a"], failureCode: null }),
  ).toEqual({ status: "completed", runIds: ["a"], failureCode: null });
  expect(
    collectorOperationResult({ status: "failed", runIds: [], failureCode: "collection_busy" }),
  ).toEqual({ status: "failed", runIds: [], failureCode: "collection_busy" });
  for (const value of [
    null,
    { status: "success", runIds: [], failureCode: null },
    { status: "completed", runIds: ["has space"], failureCode: null },
    { status: "completed", runIds: [], failureCode: "collection_failed" },
    { status: "failed", runIds: [], failureCode: null },
    { status: "failed", runIds: [], failureCode: "Provider said: no" },
    {
      status: "completed",
      runIds: Array.from({ length: 101 }, (_, i) => `r${i}`),
      failureCode: null,
    },
  ])
    expect(collectorOperationResult(value)).toBeNull();
});

test("a lease refusal is reported as collection_busy, every other error as collection_failed", async () => {
  // The real lease helper over a store whose lease another execution holds.
  const held: ScheduleLeaseDatabase = {
    prepare(sql) {
      return {
        bind() {
          return {
            async run() {
              return { meta: { changes: sql.startsWith("UPDATE") ? 0 : 1 } };
            },
          };
        },
      };
    },
  };
  let contacted = false;
  const refused = await withCollectionLease({ SCHEDULE_DB: held }, "synthetic", async () => {
    contacted = true;
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(contacted).toBe(false);
  expect(scheduledFailure(refused)).toEqual({
    status: "failed",
    runIds: [],
    failureCode: "collection_busy",
  });
  expect(scheduledFailure(new Error("synthetic provider failure"), ["r1"])).toEqual({
    status: "failed",
    runIds: ["r1"],
    failureCode: "collection_failed",
  });
  expect(scheduledFailure("collection_busy_or_uncertain").failureCode).toBe("collection_failed");
});
