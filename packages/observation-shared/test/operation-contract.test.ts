// The `GET /api/ops/v1/operations/{id}` contract: exact keys, closed codes,
// the stages each kind reports in order, and a run trail that agrees with
// itself. Synthetic identifiers only.
import { describe, expect, test } from "bun:test";
import { validApiResponse } from "../src/api-validation.ts";
import {
  OPERATION_RECORD_PATH_PREFIX,
  OPERATION_RECORD_STAGES_BY_KIND,
  operationIdOfPath,
  validOperationRecord,
  type OperationRecordExecutionWire,
  type OperationRecordKind,
  type OperationRecordRunWire,
  type OperationRecordWire,
} from "../src/operation-contract.ts";

const ID = `op_${"a".repeat(64)}`;
const PATH = `${OPERATION_RECORD_PATH_PREFIX}${ID}`;

const run = (change: Partial<OperationRecordRunWire> = {}): OperationRecordRunWire => ({
  runId: "synthetic-run-001",
  state: "published",
  reasonCode: null,
  blockedCode: null,
  providerOutcome: "success",
  evidenceRunId: "r_12",
  registeredAt: "2026-09-11T00:10:00.000Z",
  registration: {
    state: "completed",
    failureCode: null,
    attempts: 1,
    updatedAt: "2026-09-11T00:10:00.000Z",
  },
  artifacts: {
    total: 2,
    parseSelected: 1,
    published: 1,
    pending: 0,
    parseFailed: 0,
    notPublished: 0,
  },
  ...change,
});
const execution = (
  change: Partial<OperationRecordExecutionWire> = {},
): OperationRecordExecutionWire => ({
  action: "collect",
  state: "published",
  connectionId: "synthetic",
  reasonCode: null,
  scope: "collector_default",
  waits: 0,
  expiresAt: "2026-09-12T00:00:00.000Z",
  startedAt: "2026-09-11T00:05:00.000Z",
  collectedAt: "2026-09-11T00:05:00.000Z",
  publishedAt: "2026-09-11T00:15:00.000Z",
  finishedAt: "2026-09-11T00:15:00.000Z",
  runs: [run()],
  ...change,
});
const stages = (kind: OperationRecordKind) =>
  OPERATION_RECORD_STAGES_BY_KIND[kind].map((stage) => ({
    stage,
    state: "pending" as const,
    evidenceRef: null,
    failureCode: null,
    attempts: 0,
    updatedAt: null,
  }));
const record = (change: Partial<OperationRecordWire> = {}): OperationRecordWire => ({
  schemaVersion: "kogane-operation-v1",
  operationId: ID,
  kind: "collection",
  status: "running",
  source: "synthetic-source",
  targetRef: "collector:synthetic",
  dispatch: { state: "dispatched", attempts: 1 },
  stages: stages("collection"),
  failureCode: null,
  acceptedAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:15:00Z",
  execution: execution(),
  ...change,
});

describe("operation record contract", () => {
  test("accepts a collection record with its trail, by its own path", () => {
    expect(validApiResponse(PATH, record())).toBe(true);
    expect(validOperationRecord(record(), ID)).toBe(true);
  });

  test("accepts every kind with exactly the stages it reports", () => {
    expect(
      validOperationRecord(
        record({
          kind: "session-refresh",
          stages: [],
          execution: execution({
            action: "refresh-session",
            scope: null,
            state: "refreshed",
            runs: [],
          }),
        }),
      ),
    ).toBe(true);
    for (const kind of ["import", "replay", "projection"] as const)
      expect(validOperationRecord(record({ kind, stages: stages(kind), execution: null }))).toBe(
        true,
      );
  });

  test("refuses another operation's record and any path that is not an id", () => {
    expect(validApiResponse(PATH, record({ operationId: `op_${"b".repeat(64)}` }))).toBe(false);
    expect(validApiResponse(`${OPERATION_RECORD_PATH_PREFIX}op_ABC`, record())).toBe(false);
    expect(operationIdOfPath(PATH)).toBe(ID);
    expect(operationIdOfPath(`${PATH}/x`)).toBeNull();
    expect(operationIdOfPath("/api/ops/v1/collections")).toBeNull();
  });

  test("refuses unknown keys, open vocabulary and stages out of order", () => {
    expect(validOperationRecord({ ...record(), note: "x" })).toBe(false);
    expect(validOperationRecord(record({ status: "done" as never }))).toBe(false);
    expect(validOperationRecord(record({ stages: stages("collection").reverse() }))).toBe(false);
    expect(validOperationRecord(record({ stages: stages("import") }))).toBe(false);
    expect(validOperationRecord(record({ failureCode: "Provider said no" }))).toBe(false);
    expect(validOperationRecord(record({ targetRef: "https://example.invalid/x" }))).toBe(false);
    expect(validOperationRecord(record({ acceptedAt: "2026-09-11" }))).toBe(false);
  });

  test("an execution belongs to the collector kinds only, with the scope of its action", () => {
    expect(validOperationRecord(record({ execution: null }))).toBe(false);
    expect(
      validOperationRecord(
        record({ kind: "import", stages: stages("import"), execution: execution() }),
      ),
    ).toBe(false);
    expect(validOperationRecord(record({ execution: execution({ scope: null }) }))).toBe(false);
    expect(
      validOperationRecord(record({ execution: execution({ action: "refresh-session" }) })),
    ).toBe(false);
  });

  test("a run's state agrees with its registration and its artifact counts", () => {
    const withRun = (change: Partial<OperationRecordRunWire>) =>
      validOperationRecord(record({ execution: execution({ runs: [run(change)] }) }));
    expect(
      withRun({
        state: "not_registered",
        providerOutcome: null,
        evidenceRunId: null,
        registeredAt: null,
        registration: { state: "pending", failureCode: null, attempts: 0, updatedAt: null },
        artifacts: null,
      }),
    ).toBe(true);
    expect(
      withRun({
        state: "blocked",
        reasonCode: "registration_blocked",
        blockedCode: "terminal_invalid",
        evidenceRunId: null,
        registeredAt: null,
        registration: {
          state: "blocked",
          failureCode: "terminal_invalid",
          attempts: 1,
          updatedAt: "2026-09-11T00:10:00.000Z",
        },
        artifacts: null,
      }),
    ).toBe(true);
    expect(
      withRun({
        state: "retryable",
        reasonCode: "inactive_ingest_route",
        blockedCode: null,
        evidenceRunId: null,
        registeredAt: null,
        artifacts: null,
        registration: {
          state: "retryable",
          failureCode: "inactive_ingest_route",
          attempts: 2,
          updatedAt: "2026-09-11T00:10:00.000Z",
        },
      }),
    ).toBe(true);
    expect(
      withRun({
        state: "retryable",
        reasonCode: "Provider said no",
        evidenceRunId: null,
        registeredAt: null,
        artifacts: null,
        registration: {
          state: "retryable",
          failureCode: "Provider said no",
          attempts: 1,
          updatedAt: "2026-09-11T00:10:00.000Z",
        },
      }),
    ).toBe(false);
    expect(
      withRun({
        state: "unpublished",
        reasonCode: "no_parser_selected",
        artifacts: {
          total: 1,
          parseSelected: 0,
          published: 0,
          pending: 0,
          parseFailed: 0,
          notPublished: 0,
        },
      }),
    ).toBe(true);
    // Registered without a fetch run, or the reverse.
    expect(withRun({ registeredAt: null })).toBe(false);
    // Published with nothing published; unpublished without a reason.
    expect(
      withRun({
        artifacts: {
          total: 1,
          parseSelected: 1,
          published: 0,
          pending: 0,
          parseFailed: 0,
          notPublished: 1,
        },
      }),
    ).toBe(false);
    expect(withRun({ state: "unpublished" })).toBe(false);
    // Counts that do not add up.
    expect(
      withRun({
        artifacts: {
          total: 1,
          parseSelected: 2,
          published: 1,
          pending: 0,
          parseFailed: 0,
          notPublished: 1,
        },
      }),
    ).toBe(false);
    expect(
      withRun({
        artifacts: {
          total: 2,
          parseSelected: 1,
          published: 1,
          pending: 0,
          parseFailed: 1,
          notPublished: 0,
        },
      }),
    ).toBe(false);
    expect(withRun({ evidenceRunId: "12" })).toBe(false);
    expect(withRun({ providerOutcome: "ok" as never })).toBe(false);
  });

  test("accepts the longest run id the collector RPC stores, and its persisted evidence", () => {
    const runId = `r${"x".repeat(199)}`;
    const persisted = stages("collection").map((stage, index) =>
      index === 0
        ? { ...stage, state: "completed" as const, evidenceRef: `run:${runId}`, attempts: 1 }
        : stage,
    );
    expect(
      validOperationRecord(
        record({ stages: persisted, execution: execution({ runs: [run({ runId })] }) }),
      ),
    ).toBe(true);
    expect(
      validOperationRecord(
        record({ execution: execution({ runs: [run({ runId: `${runId}x` })] }) }),
      ),
    ).toBe(false);
  });

  test("a connection is an alarm job id within the 0068 bound", () => {
    const withConnection = (connectionId: string | null) =>
      validOperationRecord(record({ execution: execution({ connectionId }) }));
    expect(withConnection(null)).toBe(true);
    expect(withConnection("a".repeat(100))).toBe(true);
    expect(withConnection("a".repeat(101))).toBe(false);
    expect(withConnection("Synthetic")).toBe(false);
    expect(withConnection("run:synthetic")).toBe(false);
  });

  test("refuses more runs than the trail reads", () => {
    const runs = Array.from({ length: 101 }, (_, index) => run({ runId: `run-${index}` }));
    expect(validOperationRecord(record({ execution: execution({ runs }) }))).toBe(false);
  });
});

describe("versioned same-operation late-publication result", () => {
  const late = (): OperationRecordWire =>
    record({
      status: "failed",
      failureCode: "publication_not_observed",
      execution: execution({
        state: "unpublished",
        reasonCode: "publication_not_observed",
        publishedAt: null,
        finishedAt: "2026-09-13T00:06:00.000Z",
        currentResult: {
          schemaVersion: "kogane-collector-current-result-v1",
          state: "published",
          publishedAt: null,
          readReadiness: "unproven",
          originalTracking: {
            state: "unpublished",
            reasonCode: "publication_not_observed",
            publicationDeadlineAt: "2026-09-13T00:05:00.000Z",
            finishedAt: "2026-09-13T00:06:00.000Z",
          },
        },
      }),
    });
  test("accepts both recorded deadline failure and current publication on the same GET", () => {
    expect(validApiResponse(PATH, late())).toBe(true);
  });
  test("rejects widened versions, unknown fields, fabricated times and READ readiness", () => {
    for (const change of [
      { schemaVersion: "kogane-collector-current-result-v2" },
      { extra: "provider text" },
      { publishedAt: "2026-09-13T01:00:00Z" },
      { readReadiness: "completed" },
      { state: "publication_not_observed" },
    ]) {
      const value = late();
      Object.assign(value.execution!.currentResult!, change);
      expect(validOperationRecord(value)).toBe(false);
    }
  });
  test("rejects publication claims with pending, empty, duplicated or provider-failed runs", () => {
    for (const runs of [
      [],
      [run({ state: "parsing" })],
      [run(), run()],
      [run({ providerOutcome: "failed" })],
      [
        run({
          artifacts: {
            total: 2,
            parseSelected: 2,
            published: 1,
            pending: 1,
            parseFailed: 0,
            notPublished: 0,
          },
        }),
      ],
    ]) {
      const value = late();
      value.execution!.runs = runs;
      expect(validOperationRecord(value)).toBe(false);
    }
    const value = late();
    value.execution!.runs = [run({ state: "parsing" })];
    value.execution!.currentResult!.state = "publication_not_observed";
    expect(validOperationRecord(value)).toBe(true);
  });
  test("rejects a different historical outcome or deadline", () => {
    for (const mutate of [
      (v: OperationRecordWire) => {
        v.status = "completed";
      },
      (v: OperationRecordWire) => {
        v.failureCode = "provider_failed";
      },
      (v: OperationRecordWire) => {
        v.execution!.reasonCode = "parse_failed";
      },
      (v: OperationRecordWire) => {
        v.execution!.finishedAt = "2026-09-11T01:00:00Z";
      },
      (v: OperationRecordWire) => {
        v.execution!.currentResult!.originalTracking.publicationDeadlineAt =
          "2026-09-14T00:05:00.000Z";
      },
    ]) {
      const value = late();
      mutate(value);
      expect(validOperationRecord(value)).toBe(false);
    }
  });
});
