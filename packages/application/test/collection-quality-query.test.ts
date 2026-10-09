// The collection quality query (src/query/collection-quality.ts, ADR 0045)
// over the synthetic CORE store of packages/read-model: the jobs and sources it
// enumerates from configuration and stored state, the reason each stored state
// gives, and the wire contract every answer meets. Every key, run id, unit and
// time is invented; no amount or provider text is written.
import type { SQLQueryBindings } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import { validCollectionQualityCells } from "../../observation-shared/src/collection-quality-contract.ts";
import type { CellQualityRow } from "../../read-model/src/collection-quality.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { fullCoreSchema } from "../../read-model/test/card-usage-scale-fixture.ts";
import { QualityStore } from "../../read-model/test/collection-quality-fixture.ts";
import { COLLECTOR_SOURCE_IDS } from "../src/collection/descriptors.ts";
import {
  cell,
  CollectionQualityLimitError,
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
  safeCode,
  SCHEDULE_COLLECTOR_SOURCES,
  scheduleCollectors,
  sourceCollectors,
} from "../src/query/collection-quality.ts";

const JOBS = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../config/alarm-jobs.json"), "utf8"),
) as { id: string; source: string | null; kind: string }[];

// The first store pays the one-time CORE schema build (schema-template.ts,
// every migration in order), which crosses the 5 s default of the first hook
// or test that builds one on a loaded runner. Pay it here, outside their budgets.
beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

/**
 * The terminal source a collector declares in its shared-run module, read as
 * text: importing a Worker's module here would pull its runtime types into
 * this package's type check.
 */
function declaredSource(workspace: string, constant: string): string {
  const text = readFileSync(
    join(import.meta.dir, `../../../services/${workspace}/src/shared-run.ts`),
    "utf8",
  );
  const match = new RegExp(`export const ${constant} = "([a-z0-9-]+)";`, "u").exec(text);
  if (match === null) throw new Error(`${workspace} declares no ${constant}`);
  return match[1]!;
}

function executor(store: QualityStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

describe("which collectors a job runs, from configuration", () => {
  test("every configured job with a source names collector sources CORE registers", () => {
    for (const job of JOBS) {
      const collectors = scheduleCollectors(job.source);
      if (job.source === null) expect(collectors).toEqual([]);
      else expect(collectors.length).toBeGreaterThan(0);
      for (const collector of collectors)
        expect(Object.hasOwn(COLLECTOR_SOURCE_IDS, collector)).toBe(true);
    }
  });

  test("the aliases are only the jobs whose source is not a collector source, as the collectors name themselves", () => {
    for (const source of Object.keys(SCHEDULE_COLLECTOR_SOURCES)) {
      expect(Object.hasOwn(COLLECTOR_SOURCE_IDS, source)).toBe(false);
      expect(JOBS.some((job) => job.source === source)).toBe(true);
    }
    expect(SCHEDULE_COLLECTOR_SOURCES).toEqual({
      vpoint: [declaredSource("collector-vpoint", "VPOINT_SOURCE")],
      "vpoint-pay": [declaredSource("collector-vpoint-pay", "VPOINT_PAY_SOURCE")],
    });
  });

  test("a CORE source's collectors are the registration map's entries for it", () => {
    expect(sourceCollectors("v-point-pay")).toEqual(["v-point-pay", "v-point-pay-email"]);
    expect(sourceCollectors("global-pass")).toEqual(["prestia-globalpass"]);
    expect(sourceCollectors("paypay")).toEqual([]);
  });

  test("only safe codes pass through", () => {
    expect(safeCode("parser_rejected")).toBe("parser_rejected");
    expect(safeCode("Some provider text")).toBe("unclassified");
    expect(safeCode(null)).toBeNull();
  });
});

describe("the summary", () => {
  let store: QualityStore;
  let vpassRun: number;

  beforeAll(() => {
    store = new QualityStore();
    vpassRun = store.run({
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
      outcome: "partial",
      coverage: "partial",
      blockedCode: "registration_refused",
    });
    store.lease("vpass", "2099-01-02T21:00:01.000Z");
    // V Point is scheduled as `vpoint`; its terminal names `v-point`.
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
    store.occurrence("myjcb", {
      nominalAt: "2099-01-02T21:00:00.000Z",
      status: "uncertain",
      failureCode: "dispatch_uncertain",
    });
  });

  test("names every job and source, and is the wire contract", async () => {
    const summary = await queryCollectionQualitySummary(executor(store));
    expect(validApiResponse("/api/collection-quality", summary)).toBe(true);
    const placed = [
      ...summary.sources.flatMap((source) => source.schedules.map((job) => job.id)),
      ...summary.otherSchedules.map((job) => job.id),
    ].sort();
    expect(placed).toEqual(JOBS.map((job) => job.id).sort());
    expect(summary.otherSchedules.map((job) => job.id)).toEqual(["processor-tick"]);
    const visible = store.all<{ id: string }>("SELECT id FROM observation_sources ORDER BY id");
    expect(summary.sources.map((source) => source.sourceId)).toEqual(visible.map((row) => row.id));
  });

  test("a failed receipt, its runs where CORE has them, the lease and the withheld dataset", async () => {
    const summary = await queryCollectionQualitySummary(executor(store));
    const vpass = summary.sources.find((source) => source.sourceId === "vpass")!;
    expect(vpass.collectors).toEqual(["vpass"]);
    expect(vpass.schedules).toHaveLength(1);
    expect(vpass.schedules[0]).toMatchObject({
      id: "vpass",
      kind: "collection",
      enabled: true,
      leaseStartedAt: "2099-01-02T21:00:01.000Z",
      latest: { status: "failed", failureCode: "human_required" },
    });
    expect(vpass.schedules[0]!.latest!.terminals).toEqual([
      {
        collector: "vpass",
        outcome: "success",
        coverage: "complete",
        registration: "registered",
        blockedCode: null,
        fetchRunId: vpassRun,
      },
      {
        collector: "vpass",
        outcome: "partial",
        coverage: "partial",
        registration: "blocked",
        blockedCode: "registration_refused",
        fetchRunId: null,
      },
      {
        collector: "vpass",
        outcome: null,
        coverage: null,
        registration: "unrecorded",
        blockedCode: null,
        fetchRunId: null,
      },
    ]);
    expect(vpass.unregistered).toEqual([
      {
        collector: "vpass",
        blockedCode: "registration_refused",
        runs: 1,
        newestSeenAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    expect(vpass.latestFetchRun).toMatchObject({ id: vpassRun, succeeded: true });
    expect(vpass.reasons).toEqual([
      "occurrence_failed",
      "user_action_required",
      "lease_held",
      "terminal_unrecorded",
      "terminal_registration_blocked",
      "acquisition_partial",
      "coverage_partial",
      "unregistered_terminals",
      "dataset_withheld",
    ]);
  });

  test("a job whose source differs from its collector still reaches its runs", async () => {
    const summary = await queryCollectionQualitySummary(executor(store));
    const vpoint = summary.sources.find((source) => source.sourceId === "v-point")!;
    expect(vpoint.schedules.map((job) => job.id)).toEqual(["vpoint"]);
    expect(vpoint.schedules[0]!.latest!.terminals).toEqual([
      {
        collector: "v-point",
        outcome: "success",
        coverage: "complete",
        registration: "pending",
        blockedCode: "operation_budget",
        fetchRunId: null,
      },
    ]);
    expect(vpoint.reasons).toEqual([
      "terminal_registration_pending",
      "unregistered_terminals",
      "no_registered_run",
    ]);
  });

  test("stopped, unsupported, never-run and collector-less sources each say so", async () => {
    const summary = await queryCollectionQualitySummary(executor(store));
    const reasons = (id: string) =>
      summary.sources.find((source) => source.sourceId === id)!.reasons;
    expect(reasons("smbc-bank")).toEqual(["schedule_unsupported", "no_registered_run"]);
    expect(reasons("prestia")).toEqual(["schedule_disabled", "no_registered_run"]);
    expect(reasons("sony-bank")).toEqual(["schedule_never_ran", "no_registered_run"]);
    expect(reasons("myjcb")).toEqual(["occurrence_uncertain", "no_registered_run"]);
    expect(reasons("paypay")).toEqual(["no_collector", "no_registered_run"]);
    // The V Point Pay app job is unsupported; its e-mail path has no job.
    const pay = summary.sources.find((source) => source.sourceId === "v-point-pay")!;
    expect(pay.collectors).toEqual(["v-point-pay", "v-point-pay-email"]);
    expect(pay.schedules.map((job) => [job.id, job.enabled, job.supported])).toEqual([
      ["vpoint-pay", false, false],
    ]);
  });

  test("more jobs than the bound are refused, never cut", async () => {
    const crowded = new QualityStore();
    for (let index = 0; index < 200; index += 1)
      crowded.db.run(
        `INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by)
         VALUES(?,NULL,'processor',0,1,'UTC','{"kind":"interval","minutes":60}','2099-01-01T00:00:00.000Z','synthetic')`,
        [`synthetic-${index}`],
      );
    await expect(queryCollectionQualitySummary(executor(crowded))).rejects.toBeInstanceOf(
      CollectionQualityLimitError,
    );
  });

  test("more visible sources than the bound are refused, never cut", async () => {
    const crowded = new QualityStore();
    const visible = crowded.all<{ n: number }>("SELECT count(*) AS n FROM observation_sources")[0]!
      .n;
    for (let index = visible; index <= 200; index += 1)
      crowded.db.run(
        "INSERT INTO sources(id,provider,display_name) VALUES(?,'Synthetic','Synthetic source')",
        [`synthetic-source-${index}`],
      );
    expect(crowded.all<{ n: number }>("SELECT count(*) AS n FROM observation_sources")[0]!.n).toBe(
      201,
    );
    await expect(queryCollectionQualitySummary(executor(crowded))).rejects.toBeInstanceOf(
      CollectionQualityLimitError,
    );
  });
});

describe("the cells of a source", () => {
  test("GLOBAL PASS: current, older-current, refused and waiting months, with their reasons", async () => {
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
    s.parse(second.artifacts[0]!, "global-pass-activity", { kind: "published" });
    s.parse(second.artifacts[1]!, "global-pass-activity", { kind: "pending" });
    s.parse(second.artifacts[2]!, "global-pass-activity", {
      kind: "failed",
      code: "parser_rejected",
    });
    const page = await queryCollectionQualityCells(executor(s), {
      sourceId: "global-pass",
      offset: 0,
    });
    expect(validApiResponse("/api/collection-quality/global-pass", page)).toBe(true);
    // The answer belongs to the path's source only.
    expect(validApiResponse("/api/collection-quality/vpass", page)).toBe(false);
    expect(page!.latestFetchRun).toMatchObject({ id: second.run, succeeded: true });
    expect(
      page!.cells.map((entry) => [
        entry.period.value,
        entry.state,
        entry.reasons,
        entry.current?.capturedAt ?? null,
      ]),
    ).toEqual([
      [
        "2099-01",
        "current",
        [
          "identity_not_recorded",
          "published_without_observations",
          "retention_not_assessed",
          "coverage_not_recorded",
        ],
        "2099-02-02T00:00:00.000Z",
      ],
      [
        "2098-12",
        "older-current",
        ["retention_not_assessed", "parse_pending", "newer_capture_not_current"],
        "2099-02-01T00:00:00.000Z",
      ],
      [
        "2098-11",
        "no-current",
        ["retention_not_assessed", "parser_rejected", "no_current_capture"],
        null,
      ],
    ]);
    expect(page!.cells[0]).toMatchObject({
      dataset: "globalpass-activity",
      parser: "global-pass-activity",
      unitKey: null,
      period: { kind: "activity-month", value: "2099-01", state: null },
      currentRule: "global-pass-month",
      newest: { fetchRunId: second.run, artifacts: 1, rawStored: 1, runSucceeded: true },
    });
    expect(page!.cells[2]!.newest.failureCodes).toEqual(["parser_rejected"]);
    expect(page!.coverage).toEqual({ limit: 500, truncated: false, nextOffset: null });
  });

  test("an unknown or invisible source has no cells; a long source is paged", async () => {
    const s = new QualityStore();
    expect(
      await queryCollectionQualityCells(executor(s), { sourceId: "no-such-source", offset: 0 }),
    ).toBeNull();
    expect(
      await queryCollectionQualityCells(executor(s), { sourceId: "kogane-synthetic", offset: 0 }),
    ).toBeNull();
    const empty = await queryCollectionQualityCells(executor(s), { sourceId: "vpass", offset: 0 });
    // No capture at all: no cells and no run, never an empty success.
    expect(empty).toMatchObject({ cells: [], latestFetchRun: null });
    expect(validCollectionQualityCells(empty)).toBe(true);
    s.run({
      source: "sony-bank",
      at: "2099-01-01T00:00:00Z",
      artifacts: Array.from({ length: 501 }, (_, index) => ({
        key: `page-${index}.json`,
        dataset: `yen-history-page-${String(index + 1).padStart(4, "0")}`,
      })),
    });
    const first = await queryCollectionQualityCells(executor(s), {
      sourceId: "sony-bank",
      offset: 0,
    });
    expect(first!.cells).toHaveLength(500);
    expect(first!.coverage).toEqual({ limit: 500, truncated: true, nextOffset: 500 });
    expect(first!.cells[0]).toMatchObject({
      parser: null,
      state: "no-current",
      newest: { parses: { notQueued: 1, notEligible: 0, published: 0 } },
      reasons: ["retention_not_assessed", "parse_not_queued", "no_current_capture"],
    });
    expect(validApiResponse("/api/collection-quality/sony-bank", first)).toBe(true);
    const rest = await queryCollectionQualityCells(executor(s), {
      sourceId: "sony-bank",
      offset: 500,
    });
    expect(rest!.cells).toHaveLength(1);
    expect(rest!.coverage).toEqual({ limit: 500, truncated: false, nextOffset: null });
  });
});

/** A stored cell row with every stage done, for the reason mapping alone. */
function row(overrides: Partial<CellQualityRow> = {}): CellQualityRow {
  return {
    dataset: "synthetic-dataset",
    parser_name: "synthetic-parser",
    fetch_unit_key: null,
    period_kind: "latest",
    period: null,
    period_state: null,
    current_rule: "published-eligible",
    newest_run_id: 7,
    newest_captured_at: "2099-01-01T00:00:00.000Z",
    newest_run_succeeded: 1,
    latest_producer_run_id: 7,
    artifacts: 2,
    observations: 2,
    unresolved_identities: 0,
    identity_missing: 0,
    unit_outcome_unknown: 0,
    raw_stored: 2,
    not_queued: 0,
    not_eligible: 0,
    published: 2,
    pending: 0,
    failed: 0,
    unpublished: 0,
    failure_codes_json: "[null]",
    unit_failed: 0,
    unit_failure_code: null,
    incomplete_coverage: null,
    coverage_causes_json: null,
    unreported_coverage: 0,
    current_run_id: 7,
    current_captured_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("one reason per stored state", () => {
  const valid = (entry: ReturnType<typeof cell>) =>
    validCollectionQualityCells({
      apiVersion: 2,
      sourceId: "vpass",
      latestFetchRun: null,
      cells: [entry],
      coverage: { limit: 500, truncated: false, nextOffset: null },
    });

  test("stored stages never assert provider retention completeness", () => {
    const entry = cell(row());
    expect(entry).toMatchObject({ state: "current", reasons: ["retention_not_assessed"] });
    expect(valid(entry)).toBe(true);
  });

  test.each([
    [{ newest_run_succeeded: 0 }, ["run_not_successful"]],
    [
      { unit_failed: 1, unit_failure_code: "human_required_reauth" },
      ["unit_failed", "user_action_required"],
    ],
    [{ unit_failed: 1, unit_failure_code: "fetch_failed" }, ["unit_failed"]],
    [{ raw_stored: 1 }, ["raw_not_reachable"]],
    [{ published: 1, pending: 1 }, ["parse_pending"]],
    [{ published: 1, failed: 1, failure_codes_json: '["parser_rejected"]' }, ["parser_rejected"]],
    [
      { published: 0, failed: 2, failure_codes_json: '["parser_rejected","persistence_failed"]' },
      ["parse_failed", "parser_rejected"],
    ],
    [{ published: 1, failed: 1, failure_codes_json: "[null]" }, ["parse_failed"]],
    [{ published: 1, unpublished: 1 }, ["parse_unpublished"]],
    [{ incomplete_coverage: 1, coverage_causes_json: '["page_missing"]' }, ["coverage_incomplete"]],
    [
      { current_run_id: 3, current_captured_at: "2098-12-31T00:00:00.000Z" },
      ["newer_capture_not_current"],
    ],
    [{ current_run_id: null, current_captured_at: null }, ["no_current_capture"]],
    [
      {
        period_kind: "statement-slot",
        period: null,
        period_state: "unconfirmed",
        current_run_id: null,
        current_captured_at: null,
      },
      ["no_current_capture", "period_unplaced"],
    ],
    [{ unreported_coverage: 1 }, ["coverage_not_recorded"]],
    [{ latest_producer_run_id: 9 }, ["not_in_latest_run"]],
    [
      {
        parser_name: null,
        published: 0,
        not_queued: 1,
        not_eligible: 1,
        current_run_id: null,
        current_captured_at: null,
      },
      ["parse_not_queued", "not_parse_eligible", "no_current_capture"],
    ],
  ] as const)("%o gives %o", (overrides, reasons) => {
    const entry = cell(row(overrides as Partial<CellQualityRow>));
    expect(entry.reasons.filter((reason) => reason !== "retention_not_assessed")).toEqual([
      ...reasons,
    ]);
    expect(valid(entry)).toBe(true);
  });

  test("a stored code that is not a safe code is never passed on", () => {
    const entry = cell(
      row({
        published: 1,
        failed: 1,
        failure_codes_json: '["Provider said: no"]',
        unit_failed: 1,
        unit_failure_code: "Line\nbreak",
      }),
    );
    expect(entry.newest.failureCodes).toEqual(["unclassified"]);
    expect(entry.newest.unitFailureCode).toBe("unclassified");
    expect(valid(entry)).toBe(true);
  });

  test("the contract refuses a state the captures do not give, and an unnamed field", () => {
    const entry = cell(row());
    expect(valid({ ...entry, state: "older-current" })).toBe(false);
    expect(
      valid({
        ...entry,
        newest: { ...entry.newest, parses: { ...entry.newest.parses, published: 1 } },
      }),
    ).toBe(false);
    expect(valid({ ...entry, total: 0 } as never)).toBe(false);
    expect(valid({ ...entry, reasons: ["no_current_capture", "no_current_capture"] })).toBe(false);
  });
});
