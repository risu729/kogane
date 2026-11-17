// Late publication is a read-only extension of the original immutable receipt.
import { describe, expect, test } from "bun:test";
import {
  collectorExecution,
  type CollectorDispatchRow,
} from "../src/operations/collector-trail.ts";
import type { CommandStore } from "../src/command/contract.ts";

const collected = "2026-09-11T00:00:00.000Z";
const finished = "2026-09-13T00:01:00.000Z";
const row: CollectorDispatchRow = {
  operation_id: `op_${"a".repeat(64)}`,
  action: "collect",
  terminal_source: "synthetic",
  connection_id: "synthetic",
  state: "unpublished",
  reason_code: "publication_not_observed",
  waits: 0,
  starts: 1,
  run_ids_json: '["original"]',
  accepted_at: collected,
  expires_at: "2026-09-12T00:00:00.000Z",
  started_at: collected,
  collected_at: collected,
  published_at: null,
  finished_at: finished,
  next_check_at_ms: 0,
  updated_at: finished,
};
const registered = (runId = "original", extra = {}) => ({
  run_id: runId,
  blocked_code: null,
  provider_outcome: "success",
  fetch_run_id: 1,
  registered_at: finished,
  processed_at_ms: 1,
  registration_state: "completed",
  registration_failure_code: null,
  registration_updated_at: finished,
  registration_attempts: 1,
  ...extra,
});
const counts = {
  fetch_run_id: 1,
  total: 1,
  parse_selected: 1,
  published: 1,
  pending: 0,
  parse_failed: 0,
};

async function report(
  change: Partial<CollectorDispatchRow> = {},
  runs = [registered()],
  artifacts = [counts],
  status = "failed",
) {
  const saved = { ...row, ...change };
  const reads: unknown[][] = [];
  const store: CommandStore = {
    first: async <T>() => saved as T,
    all: async <T>(sql: string, binds: readonly unknown[] = []) => {
      reads.push([...binds]);
      return (sql.includes("json_each(?2)") ? runs : artifacts) as T[];
    },
    batch: async () => {
      throw new Error("GET must never write");
    },
  };
  const result = await collectorExecution(store, {
    operationId: row.operation_id,
    kind: "collection",
    status,
    acceptedAt: collected,
    failureCode: "publication_not_observed",
  });
  return { result, reads, saved };
}

describe("same-operation current publication", () => {
  test("adds a versioned published result without changing recorded state or inventing time/READ", async () => {
    const { result, reads, saved } = await report();
    expect(result).toMatchObject({
      state: "unpublished",
      reasonCode: "publication_not_observed",
      finishedAt: finished,
      publishedAt: null,
      currentResult: {
        schemaVersion: "kogane-collector-current-result-v1",
        state: "published",
        publishedAt: null,
        readReadiness: "unproven",
        originalTracking: {
          state: "unpublished",
          reasonCode: "publication_not_observed",
          publicationDeadlineAt: "2026-09-13T00:00:00.000Z",
          finishedAt: finished,
        },
      },
    });
    expect(reads[0]).toEqual(["synthetic", '["original"]']);
    expect(saved).toEqual(row);
    expect((await report()).result).toEqual(result);
  });

  test("requires every original run settled and at least one published, including the 100-run bound", async () => {
    for (const extra of [
      { processed_at_ms: null },
      { fetch_run_id: null, registered_at: null },
      { provider_outcome: "failed" },
    ])
      expect((await report({}, [registered("original", extra)])).result?.currentResult?.state).toBe(
        "publication_not_observed",
      );
    for (const extra of [
      { published: 0, parse_selected: 0 },
      { published: 0, pending: 1 },
      { published: 0, parse_failed: 1 },
    ])
      expect(
        (await report({}, [registered()], [{ ...counts, ...extra }])).result?.currentResult?.state,
      ).toBe("publication_not_observed");
    const bound = Array.from({ length: 100 }, (_, i) => `run-${i}`);
    expect(
      (
        await report(
          { run_ids_json: JSON.stringify(bound) },
          bound.map((id) => registered(id)),
        )
      ).result?.currentResult?.state,
    ).toBe("published");
    expect(
      (
        await report({ run_ids_json: '["original","pending"]' }, [
          registered(),
          registered("pending", { processed_at_ms: null }),
        ])
      ).result?.currentResult?.state,
    ).toBe("publication_not_observed");
    // Normal trail semantics permit a settled closed reason alongside one published run.
    expect(
      (
        await report({ run_ids_json: '["original","blocked"]' }, [
          registered(),
          registered("blocked", {
            fetch_run_id: null,
            registered_at: null,
            blocked_code: "object_missing",
            registration_state: "blocked",
          }),
        ])
      ).result?.currentResult?.state,
    ).toBe("published");
  });

  test("rejects malformed bindings and non-horizon terminal outcomes without broadening the read", async () => {
    for (const change of [
      { state: "expired" as const },
      { state: "uncertain" as const },
      { state: "failed" as const },
      { reason_code: "provider_failed" },
      { reason_code: "parse_failed" },
      { terminal_source: null },
      { terminal_source: "invalid/source" },
      { collected_at: null },
      { finished_at: null },
      { finished_at: collected },
      { collected_at: "invalid" },
      { run_ids_json: "invalid" },
      { run_ids_json: "[]" },
      { run_ids_json: '["original",1]' },
      { run_ids_json: '["original","original"]' },
      { run_ids_json: '["bad/run"]' },
      { run_ids_json: JSON.stringify(Array.from({ length: 101 }, (_, i) => `run-${i}`)) },
    ])
      expect((await report(change)).result?.currentResult).toBeUndefined();
    expect((await report({}, [registered("unrelated")])).result?.currentResult).toBeUndefined();
    expect((await report({}, [], [])).result?.currentResult).toBeUndefined();
    expect(
      (await report({}, [registered()], [counts], "running")).result?.currentResult,
    ).toBeUndefined();
  });
});
