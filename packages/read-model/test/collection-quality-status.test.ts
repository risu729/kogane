// The status view's two bounded reads (ADR 0045 amendment 2026-11-19): the
// newest receipts per job and the newest visible fetch runs per source, what
// they return, and their plans on a scaled store with the complete CORE schema
// and no table statistics (D1 runs no `ANALYZE`). Everything is synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import { explain, type PlanStep } from "./card-usage-plan";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import { QualityStore } from "./collection-quality-fixture";
import {
  STATUS_OCCURRENCE_WINDOW,
  STATUS_OCCURRENCES_SQL,
  STATUS_RUN_WINDOW,
  STATUS_RUNS_SQL,
  type StatusOccurrenceRow,
  type StatusRunRow,
} from "../src/collection-quality";

const DAY_MS = 86_400_000;
const START_MS = Date.parse("2098-01-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

/** Every full scan the plan makes, other than of the request's own JSON array. */
const scans = (steps: readonly PlanStep[]) =>
  steps
    .map((step) => step.detail)
    .filter((detail) => detail.startsWith("SCAN ") && !/^SCAN wanted VIRTUAL TABLE/u.test(detail));

describe("the status view's reads", () => {
  let scaled: QualityStore;

  beforeAll(() => {
    scaled = new QualityStore();
    // A year of daily receipts for two jobs, and a year of daily V Point runs,
    // every other one published, so the windows are far smaller than the store.
    for (let day = 0; day < 365; day += 1) {
      const at = iso(START_MS + day * DAY_MS);
      for (const job of ["vpoint", "myjcb"])
        scaled.occurrence(job, {
          nominalAt: at,
          status: day % 2 === 0 ? "failed" : "completed",
          failureCode: day % 2 === 0 ? "collection_failed" : undefined,
        });
      const run = scaled.run({
        source: "v-point",
        at,
        outcome: day % 3 === 0 ? "partial" : "success",
        artifacts: [{ key: "balance-info.json", dataset: "balance-info" }],
      });
      if (day % 2 === 0)
        scaled.parse(run.artifacts[0]!, "v-point-balance-info", { kind: "published" });
    }
  }, 120_000);

  test("the store is what D1 runs: no table statistics", () => {
    expect(
      scaled.db
        .query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
        .get(),
    ).toEqual({ n: 0 });
  });

  test("the newest window + 1 receipts of each named job, newest first, and all of a short history", () => {
    const rows = scaled.all<StatusOccurrenceRow>(STATUS_OCCURRENCES_SQL, [
      JSON.stringify(["myjcb", "vpoint", "vpass"]),
    ]);
    for (const job of ["myjcb", "vpoint"]) {
      const own = rows.filter((row) => row.schedule_id === job);
      expect(own).toHaveLength(STATUS_OCCURRENCE_WINDOW + 1);
      expect(own[0]!.nominal_at).toBe(iso(START_MS + 364 * DAY_MS));
      expect(own.at(-1)!.nominal_at).toBe(
        iso(START_MS + (364 - STATUS_OCCURRENCE_WINDOW) * DAY_MS),
      );
    }
    expect(rows.filter((row) => row.schedule_id === "vpass")).toEqual([]);
    const short = new QualityStore();
    short.occurrence("vpass", { nominalAt: "2099-01-01T21:00:00.000Z", status: "completed" });
    short.occurrence("vpass", { nominalAt: "2099-01-02T21:00:00.000Z", status: "started" });
    expect(
      short
        .all<StatusOccurrenceRow>(STATUS_OCCURRENCES_SQL, [JSON.stringify(["vpass"])])
        .map((row) => [row.status, row.finished_at]),
    ).toEqual([
      ["started", null],
      ["completed", "2099-01-01T21:00:00.000Z"],
    ]);
  });

  test("the newest window of visible runs of each named source, with success and publication", () => {
    const rows = scaled.all<StatusRunRow>(STATUS_RUNS_SQL, [JSON.stringify(["v-point", "vpass"])]);
    expect(rows).toHaveLength(STATUS_RUN_WINDOW);
    expect(rows.every((row) => row.source_id === "v-point")).toBe(true);
    expect(rows[0]!.completed_at).toBe(iso(START_MS + 364 * DAY_MS));
    for (const row of rows) {
      const day = Math.round((Date.parse(row.completed_at!) - START_MS) / DAY_MS);
      expect([row.succeeded, row.published], String(day)).toEqual([
        day % 3 === 0 ? 0 : 1,
        day % 2 === 0 ? 1 : 0,
      ]);
    }
  });

  test("the receipts are read by the job's (schedule_id, nominal_at) index, edge and window", () => {
    const steps = explain(scaled.db, STATUS_OCCURRENCES_SQL, [JSON.stringify(["vpoint"])]);
    expect(scans(steps)).toEqual([]);
    const details = steps.map((step) => step.detail);
    expect(
      details.some((detail) =>
        /^SEARCH o USING INDEX sqlite_autoindex_collection_schedule_occurrences\S*_2 \(schedule_id=\? AND nominal_at>\?\)$/u.test(
          detail,
        ),
      ),
    ).toBe(true);
    expect(
      details.some((detail) =>
        /^SEARCH edge USING COVERING INDEX sqlite_autoindex_collection_schedule_occurrences\S*_2 \(schedule_id=\?\)$/u.test(
          detail,
        ),
      ),
    ).toBe(true);
  });

  test("the runs are read by idx_fetch_runs_source and each run's rows by key", () => {
    const steps = explain(scaled.db, STATUS_RUNS_SQL, [JSON.stringify(["v-point"])]);
    expect(scans(steps)).toEqual([]);
    const details = steps.map((step) => step.detail);
    expect(details).toContain(
      "SEARCH run USING INDEX idx_fetch_runs_source (source_id=? AND id>?)",
    );
    expect(details).toContain("SEARCH run USING INDEX idx_fetch_runs_source (source_id=?)");
    expect(
      details.some((detail) =>
        /^SEARCH pub USING (?:COVERING )?INDEX sqlite_autoindex_published_parse_runs_1 \(fetch_artifact_id=\?\)$/u.test(
          detail,
        ),
      ),
    ).toBe(true);
    // No observation table is read.
    expect(details.filter((detail) => /_observations\b/u.test(detail))).toEqual([]);
  });

  test("timings on the scaled store (printed, not asserted)", () => {
    let started = performance.now();
    scaled.all(STATUS_OCCURRENCES_SQL, [JSON.stringify(["myjcb", "vpoint"])]);
    console.log(`status receipts: ${(performance.now() - started).toFixed(1)} ms`);
    started = performance.now();
    scaled.all(STATUS_RUNS_SQL, [JSON.stringify(["v-point"])]);
    console.log(`status runs: ${(performance.now() - started).toFixed(1)} ms`);
  });
});
