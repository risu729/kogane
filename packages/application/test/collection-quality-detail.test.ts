// The `summary` detail of the collection quality reads (ADR 0123) over the
// synthetic CORE store of packages/read-model: a line collapses sources or
// cells, never a code. Every state, reason and closed code of what a line
// collapses is on that line, and every cell is counted once. Every key, run
// id, unit and time is invented; no amount or provider text is written.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  validCollectionQualityResponse,
  type CollectionQualityCell,
} from "../../observation-shared/src/collection-quality-contract.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { QualityStore } from "../../read-model/test/collection-quality-fixture.ts";
import {
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
} from "../src/query/collection-quality.ts";
import {
  collectionQualityCellSummary,
  collectionQualitySummaryLines,
} from "../src/query/collection-quality-detail.ts";

/** Every age is counted to this instant (collection-freshness-v1); after every synthetic capture. */
const AS_OF = "2099-03-01T00:00:00.000Z";
function executor(store: QualityStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}
const nonNull = (values: readonly (string | null)[]) =>
  values.filter((value): value is string => value !== null);

describe("the summary's lines", () => {
  test("keep each source's reasons, its jobs' receipt codes and its terminals' codes", async () => {
    const store = new QualityStore();
    const vpassRun = store.run({
      source: "vpass",
      at: "2099-01-02T00:00:00Z",
      artifacts: [{ key: "evidence.json", dataset: null }],
    }).run;
    store.occurrence("vpass", {
      nominalAt: "2099-01-02T21:00:00.000Z",
      status: "failed",
      failureCode: "human_required",
      runIds: ["run-a", "run-b", "run-c"],
    });
    store.terminal({ source: "vpass", runId: "run-a", outcome: "success", fetchRun: vpassRun });
    store.terminal({
      source: "vpass",
      runId: "run-b",
      outcome: "failed",
      coverage: "partial",
      blockedCode: "registration_refused",
      providerFailureCode: "login_rejected",
    });
    store.occurrence("vpoint", {
      nominalAt: "2099-01-02T21:15:00.000Z",
      status: "completed",
      runIds: ["run-v"],
    });
    store.terminal({
      source: "v-point",
      runId: "run-v",
      outcome: "success",
      stage: { state: "retryable", failureCode: "operation_budget" },
    });
    const full = await queryCollectionQualitySummary(executor(store), { asOf: AS_OF });
    const summary = collectionQualitySummaryLines(full);
    expect(validCollectionQualityResponse("/api/collection-quality", summary, "summary")).toBe(
      true,
    );
    // A page that asked for the full summary does not take the lines for it.
    expect(validCollectionQualityResponse("/api/collection-quality", summary, "full")).toBe(false);
    expect(validCollectionQualityResponse("/api/collection-quality", full, "summary")).toBe(false);
    // Every source is on exactly one line, and that line says what its full entry says.
    expect(summary.sources.flatMap((line) => line.sourceIds).sort()).toEqual(
      full.sources.map((source) => source.sourceId).sort(),
    );
    for (const source of full.sources) {
      const line = summary.sources.find((entry) => entry.sourceIds.includes(source.sourceId))!;
      expect(line.reasons, source.sourceId).toEqual(source.reasons);
      expect(line.unregistered).toBe(source.unregistered.length);
      for (const entry of source.unregistered)
        for (const code of nonNull([entry.blockedCode, entry.failureCode]))
          expect(line.unregisteredCodes, source.sourceId).toContain(code);
      expect(line.schedules.map((job) => job.id)).toEqual(source.schedules.map((job) => job.id));
      for (const [index, job] of source.schedules.entries()) {
        const latest = line.schedules[index]!.latest;
        if (job.latest === null) {
          expect(latest).toBeNull();
          continue;
        }
        expect(latest).toMatchObject({
          status: job.latest.status,
          failureCode: job.latest.failureCode,
        });
        for (const terminal of job.latest.terminals)
          for (const code of nonNull([terminal.blockedCode, terminal.failureCode]))
            expect(latest!.terminalCodes, job.id).toContain(code);
      }
      if (source.dataTypes !== null)
        expect(
          line.dataTypes!.collected + line.dataTypes!.partial + line.dataTypes!.notCollected,
        ).toBe(source.dataTypes.length);
    }
    const vpass = summary.sources.find((line) => line.sourceIds.includes("vpass"))!;
    expect(vpass.sourceIds).toEqual(["vpass"]);
    expect(vpass.schedules[0]!.latest).toEqual({
      nominalAt: "2099-01-02T21:00:00.000Z",
      status: "failed",
      failureCode: "human_required",
      terminalCodes: ["registration_refused", "login_rejected"],
    });
    expect(vpass.unregisteredCodes).toEqual(["registration_refused", "login_rejected"]);
    const vpoint = summary.sources.find((line) => line.sourceIds.includes("v-point"))!;
    expect(vpoint.schedules[0]!.latest!.terminalCodes).toEqual(["operation_budget"]);
  });

  test("collapse a source's cells over periods with every state, reason and code", async () => {
    const s = new QualityStore();
    const month = (value: string) => ({
      key: `activity-${value}.html`,
      dataset: "globalpass-activity",
    });
    const first = s.run({
      source: "global-pass",
      at: "2099-02-01T00:00:00Z",
      artifacts: [month("2099-01"), month("2098-12")],
    });
    for (const artifact of first.artifacts)
      s.parse(artifact, "global-pass-activity", { kind: "published" });
    const second = s.run({
      source: "global-pass",
      at: "2099-02-02T00:00:00Z",
      artifacts: [month("2099-01"), month("2098-12"), month("2098-11")],
    });
    s.parse(second.artifacts[0]!, "global-pass-activity", {
      kind: "published",
      claim: { completeness: "partial", cause: "page_missing" },
    });
    s.parse(second.artifacts[1]!, "global-pass-activity", { kind: "pending" });
    s.parse(second.artifacts[2]!, "global-pass-activity", {
      kind: "failed",
      code: "parser_rejected",
    });
    const page = (await queryCollectionQualityCells(executor(s), {
      sourceId: "global-pass",
      offset: 0,
      asOf: AS_OF,
    }))!;
    const cells: CollectionQualityCell[] = page.cells;
    expect(cells).toHaveLength(3);
    const summary = collectionQualityCellSummary([page], 0);
    expect(
      validCollectionQualityResponse("/api/collection-quality/global-pass", summary, "summary"),
    ).toBe(true);
    expect(
      validCollectionQualityResponse("/api/collection-quality/global-pass", summary, "full"),
    ).toBe(false);
    expect(
      validCollectionQualityResponse("/api/collection-quality/global-pass", page, "summary"),
    ).toBe(false);
    expect(summary.coverage).toMatchObject({ cells: 3, lines: 1, truncated: false });
    const [line] = summary.lines;
    expect(line).toMatchObject({
      dataset: "globalpass-activity",
      parser: "global-pass-activity",
      cells: 3,
      current: 1,
      olderCurrent: 1,
      noCurrent: 1,
      periods: { first: "2098-11", last: "2099-01" },
      failureCodes: ["parser_rejected"],
      coverageCauses: ["page_missing"],
    });
    for (const cell of cells) {
      for (const reason of cell.reasons) expect(line!.reasons).toContain(reason);
      for (const code of nonNull([cell.newest.unitFailureCode, ...cell.newest.failureCodes]))
        expect(line!.failureCodes).toContain(code);
      for (const cause of cell.newest.coverageCauses) expect(line!.coverageCauses).toContain(cause);
    }
  });

  test("keep a failed unit's closed code", async () => {
    const s = new QualityStore();
    s.run({
      source: "vpass",
      at: "2099-02-01T00:00:00Z",
      outcome: "partial",
      artifacts: [],
      units: {
        "synthetic-card-a": { outcome: "failed", code: "stated_total_mismatch" },
        "synthetic-card-b": { outcome: "human_required", code: "human_required_reauth" },
      },
    });
    const page = (await queryCollectionQualityCells(executor(s), {
      sourceId: "vpass",
      offset: 0,
      asOf: AS_OF,
    }))!;
    const summary = collectionQualityCellSummary([page], 0);
    const codes = Object.fromEntries(
      summary.lines.map((line) => [line.unitKey, line.failureCodes]),
    );
    for (const cell of page.cells)
      expect(codes[cell.unitKey!]).toEqual(nonNull([cell.newest.unitFailureCode]));
    expect(codes["synthetic-card-a"]).toEqual(["stated_total_mismatch"]);
  });
});
