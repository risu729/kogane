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
        artifacts: null,
      }),
    ).toBe(true);
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

  test("refuses more runs than the trail reads", () => {
    const runs = Array.from({ length: 101 }, (_, index) => run({ runId: `run-${index}` }));
    expect(validOperationRecord(record({ execution: execution({ runs }) }))).toBe(false);
  });
});
