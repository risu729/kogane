// The store overview's `summary` detail (ADR 0123, amendment 2026-11-19):
// the run windows collapse by status and by source or parser, never a state.
// Every status is counted with how many rows it collapsed, and every line
// keeps the ids that read its newest run further. Every id, name and time is
// invented; no amount or provider text is written.
import { describe, expect, test } from "bun:test";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import type { OverviewPage } from "../../observation-shared/src/api-contract.ts";
import { overviewSummary } from "../src/query/overview-detail.ts";

type FetchRun = OverviewPage["fetchRuns"][number];
type ParseRun = OverviewPage["parseRuns"][number];

function fetchRun(id: number, source: string, status: string, completed = true): FetchRun {
  return {
    id,
    source_id: source,
    tool: "synthetic-collector",
    external_run_id: `synthetic-session-${id}`,
    status,
    started_at: `2099-01-0${id % 9}T21:00:00.000Z`,
    completed_at: completed ? `2099-01-0${id % 9}T21:05:00.000Z` : null,
  };
}

function parseRun(
  id: number,
  parser: string,
  status: string,
  extra: Partial<ParseRun> = {},
): ParseRun {
  return {
    id,
    fetch_artifact_id: 100 + id,
    parser_name: parser,
    parser_version: "2",
    parsed_at: `2099-01-0${id % 9}T21:10:00.000Z`,
    status,
    warnings: { list: [], raw: "[]", parsed: true },
    error: status === "error" ? "synthetic parse error text" : null,
    superseded_by_parse_run_id: null,
    ...extra,
  };
}

function page(extra: Partial<OverviewPage> = {}): OverviewPage {
  return {
    counts: [
      { table: "sources", rows: 4 },
      { table: "fetch_runs", rows: 6 },
    ],
    sources: [
      { id: "bank-a", provider: "Synthetic Bank A", ingestion: "collector-r2", artifact_count: 12 },
      { id: "bank-b", provider: "Synthetic Bank B", ingestion: "collector-r2", artifact_count: 0 },
      { id: "card-c", provider: "Synthetic Card C", ingestion: "collector-r2", artifact_count: 7 },
      { id: "card-d", provider: "Synthetic Card D", ingestion: "collector-r2", artifact_count: 0 },
    ],
    // Newest first, as the reader lists them.
    fetchRuns: [
      fetchRun(6, "bank-a", "success"),
      fetchRun(5, "card-c", "partial", false),
      fetchRun(4, "bank-a", "partial"),
      fetchRun(3, "card-c", "success"),
      fetchRun(2, "bank-a", "success"),
      fetchRun(1, "card-c", "partial"),
    ],
    parseRuns: [
      parseRun(8, "bank-a-statement", "ok", {
        warnings: { list: ["synthetic warning"], raw: '["synthetic warning"]', parsed: true },
      }),
      parseRun(7, "card-c-statement", "error", { error: "parser_rejected" }),
      parseRun(6, "card-c-statement", "error", { superseded_by_parse_run_id: 9 }),
      parseRun(5, "bank-a-statement", "pending"),
      parseRun(4, "card-c-statement", "ok", {
        warnings: { list: [], raw: "not json", parsed: false },
      }),
      parseRun(3, "bank-a-statement", "ok", { superseded_by_parse_run_id: 8 }),
    ],
    coverage: { limit: 500, truncated: false },
    ...extra,
  };
}

describe("overviewSummary", () => {
  test("collapses each window by status, and by source or parser for every status not a success", () => {
    const full = page();
    expect(overviewSummary(full)).toEqual({
      detail: "summary",
      counts: full.counts,
      // Sources with the same artifact count share one line.
      sources: [
        { sourceIds: ["bank-a"], artifacts: 12 },
        { sourceIds: ["bank-b", "card-d"], artifacts: 0 },
        { sourceIds: ["card-c"], artifacts: 7 },
      ],
      fetchRuns: {
        byStatus: [
          {
            status: "success",
            runs: 3,
            sources: 2,
            newest: {
              id: 6,
              sourceId: "bank-a",
              startedAt: "2099-01-06T21:00:00.000Z",
              completedAt: "2099-01-06T21:05:00.000Z",
            },
          },
          {
            status: "partial",
            runs: 3,
            sources: 2,
            // A run that has not completed keeps its null, never a time.
            newest: {
              id: 5,
              sourceId: "card-c",
              startedAt: "2099-01-05T21:00:00.000Z",
              completedAt: null,
            },
          },
        ],
        notSuccessful: [
          {
            sourceId: "card-c",
            status: "partial",
            runs: 2,
            newest: { id: 5, startedAt: "2099-01-05T21:00:00.000Z", completedAt: null },
          },
          {
            sourceId: "bank-a",
            status: "partial",
            runs: 1,
            newest: {
              id: 4,
              startedAt: "2099-01-04T21:00:00.000Z",
              completedAt: "2099-01-04T21:05:00.000Z",
            },
          },
        ],
        notSuccessfulOmitted: [],
      },
      parseRuns: {
        byStatus: [
          {
            status: "ok",
            runs: 3,
            superseded: 1,
            withWarnings: 1,
            unreadableWarnings: 1,
            parsers: 2,
            failureCodes: [],
            newest: {
              id: 8,
              artifactId: 108,
              parser: "bank-a-statement",
              parsedAt: "2099-01-08T21:10:00.000Z",
            },
          },
          {
            status: "error",
            runs: 2,
            superseded: 1,
            withWarnings: 0,
            unreadableWarnings: 0,
            parsers: 1,
            // Every failure code of the status, newest first.
            failureCodes: ["parser_rejected", "unclassified"],
            newest: {
              id: 7,
              artifactId: 107,
              parser: "card-c-statement",
              parsedAt: "2099-01-07T21:10:00.000Z",
            },
          },
          {
            status: "pending",
            runs: 1,
            superseded: 0,
            withWarnings: 0,
            unreadableWarnings: 0,
            parsers: 1,
            failureCodes: [],
            newest: {
              id: 5,
              artifactId: 105,
              parser: "bank-a-statement",
              parsedAt: "2099-01-05T21:10:00.000Z",
            },
          },
        ],
        notOk: [
          {
            parser: "card-c-statement",
            status: "error",
            runs: 2,
            superseded: 1,
            // The closed code of each failure, newest first; text is never a code.
            failureCodes: ["parser_rejected", "unclassified"],
            moreFailureCodes: 0,
            newest: { id: 7, artifactId: 107, parsedAt: "2099-01-07T21:10:00.000Z" },
          },
          {
            parser: "bank-a-statement",
            status: "pending",
            runs: 1,
            superseded: 0,
            failureCodes: [],
            moreFailureCodes: 0,
            newest: { id: 5, artifactId: 105, parsedAt: "2099-01-05T21:10:00.000Z" },
          },
        ],
        // Every line is listed: nothing is left out.
        notOkOmitted: [],
      },
      coverage: full.coverage,
    });
  });

  test("drops provider names, producers, session ids, parser versions, warnings and error text", () => {
    const text = JSON.stringify(overviewSummary(page()));
    for (const dropped of [
      "Synthetic Bank",
      "collector-r2",
      "synthetic-collector",
      "synthetic-session",
      "synthetic warning",
      "synthetic parse error",
      "not json",
      "parser_version",
    ])
      expect(text).not.toContain(dropped);
  });

  test("collapses partial-unit updates per source and dataset, and leaves them absent when the page has none", () => {
    expect(overviewSummary(page())).not.toHaveProperty("unitUpdates");
    expect(overviewSummary(page())).not.toHaveProperty("unitUpdatesOmitted");
    const summary = overviewSummary(
      page({
        unitUpdates: [
          {
            source_id: "card-c",
            dataset: "statement",
            fetch_run_id: 5,
            fetched_at: "2099-01-05T21:02:00.000Z",
            updated_units: 2,
            stale_units: 1,
          },
          {
            source_id: "card-c",
            dataset: "statement",
            fetch_run_id: 1,
            fetched_at: "2099-01-01T21:02:00.000Z",
            updated_units: 1,
            stale_units: 2,
          },
        ],
      }),
    );
    expect(summary.unitUpdates).toEqual([
      {
        sourceId: "card-c",
        dataset: "statement",
        runs: 2,
        newest: {
          fetchRunId: 5,
          fetchedAt: "2099-01-05T21:02:00.000Z",
          updatedUnits: 2,
          staleUnits: 1,
        },
      },
    ]);
    expect(summary.unitUpdatesOmitted).toEqual({ lines: 0, runs: 0 });
    expect(validApiResponse("/api/overview", summary, "summary")).toBe(true);
    const bare = structuredClone(summary);
    delete bare.unitUpdatesOmitted;
    expect(validApiResponse("/api/overview", bare, "summary")).toBe(false);
  });

  test("keeps every failure code of a failing parser, newest first, and never its text", () => {
    // Three codes on the line, the fourth counted there; all four on its status's line.
    const summary = overviewSummary(
      page({
        parseRuns: [
          parseRun(9, "card-c-statement", "error", { error: "raw_checksum_mismatch" }),
          parseRun(8, "card-c-statement", "error", { error: "parser_rejected" }),
          parseRun(7, "card-c-statement", "error", { error: "raw_checksum_mismatch" }),
          parseRun(6, "card-c-statement", "error", { error: "parse_interrupted" }),
          parseRun(5, "card-c-statement", "error", { error: "Provider said: no rows" }),
          parseRun(4, "card-c-statement", "error", { error: null }),
        ],
      }),
    );
    expect(summary.parseRuns.notOk).toEqual([
      expect.objectContaining({
        parser: "card-c-statement",
        status: "error",
        runs: 6,
        failureCodes: ["raw_checksum_mismatch", "parser_rejected", "parse_interrupted"],
        moreFailureCodes: 1,
      }),
    ]);
    expect(summary.parseRuns.byStatus).toEqual([
      expect.objectContaining({
        status: "error",
        failureCodes: [
          "raw_checksum_mismatch",
          "parser_rejected",
          "parse_interrupted",
          "unclassified",
        ],
      }),
    ]);
    expect(JSON.stringify(summary)).not.toContain("Provider said");
    expect(validApiResponse("/api/overview", summary, "summary")).toBe(true);
    // A summary that carries text where a code belongs is not a summary.
    const text = structuredClone(summary);
    text.parseRuns.byStatus[0]!.failureCodes.push("Provider said: no rows");
    expect(validApiResponse("/api/overview", text, "summary")).toBe(false);
    // A line over its cap, a code its status's line lacks, or more codes
    // counted than its status has, is not a summary either.
    const over = structuredClone(summary);
    over.parseRuns.notOk[0]!.failureCodes.push("unclassified");
    over.parseRuns.notOk[0]!.moreFailureCodes = 0;
    expect(validApiResponse("/api/overview", over, "summary")).toBe(false);
    const missing = structuredClone(summary);
    missing.parseRuns.byStatus[0]!.failureCodes.splice(1, 1);
    expect(validApiResponse("/api/overview", missing, "summary")).toBe(false);
    const counted = structuredClone(summary);
    counted.parseRuns.notOk[0]!.moreFailureCodes = 2;
    expect(validApiResponse("/api/overview", counted, "summary")).toBe(false);
  });

  test("lists the newest five sources and parsers of each list and counts the rest, never dropping them", () => {
    const parsers = Array.from({ length: 8 }, (_, index) => `parser-${index}`);
    const summary = overviewSummary(
      page({
        // Eight parsers failing and one pending, newest first.
        parseRuns: [
          parseRun(20, "parser-pending", "pending"),
          ...parsers.flatMap((parser, index) => [
            parseRun(19 - index * 2, parser, "error", { error: `code_${index}` }),
            parseRun(18 - index * 2, parser, "error", { error: "parser_rejected" }),
          ]),
        ],
        // Seven sources with partial runs, one run each.
        fetchRuns: Array.from({ length: 7 }, (_, index) =>
          fetchRun(30 - index, `source-${index}`, "partial"),
        ),
        unitUpdates: Array.from({ length: 7 }, (_, index) => ({
          source_id: `source-${index}`,
          dataset: "statement",
          fetch_run_id: 30 - index,
          fetched_at: "2099-01-05T21:02:00.000Z",
          updated_units: 1,
          stale_units: 1,
        })),
      }),
    );
    expect(summary.parseRuns.notOk.map((line) => line.parser)).toEqual([
      "parser-pending",
      "parser-0",
      "parser-1",
      "parser-2",
      "parser-3",
    ]);
    expect(summary.parseRuns.notOkOmitted).toEqual([{ status: "error", lines: 4, runs: 8 }]);
    // The lines left out keep their failure codes on the status's line.
    expect(
      summary.parseRuns.byStatus.find((line) => line.status === "error")?.failureCodes,
    ).toEqual([
      "code_0",
      "parser_rejected",
      ...parsers.slice(1).map((_, index) => `code_${index + 1}`),
    ]);
    expect(summary.fetchRuns.notSuccessful.map((line) => line.sourceId)).toEqual([
      "source-0",
      "source-1",
      "source-2",
      "source-3",
      "source-4",
    ]);
    expect(summary.fetchRuns.notSuccessfulOmitted).toEqual([
      { status: "partial", lines: 2, runs: 2 },
    ]);
    expect(summary.unitUpdates?.map((line) => line.sourceId)).toEqual([
      "source-0",
      "source-1",
      "source-2",
      "source-3",
      "source-4",
    ]);
    expect(summary.unitUpdatesOmitted).toEqual({ lines: 2, runs: 2 });
    expect(validApiResponse("/api/overview", summary, "summary")).toBe(true);
    // Lines left out without being counted, a sixth line, or lines counted
    // out of a list that is not full, are not a summary.
    const silent = structuredClone(summary);
    silent.parseRuns.notOkOmitted = [];
    expect(validApiResponse("/api/overview", silent, "summary")).toBe(false);
    const sixth = structuredClone(summary);
    sixth.fetchRuns.notSuccessful.push({
      ...sixth.fetchRuns.notSuccessful[0]!,
      sourceId: "source-5",
    });
    sixth.fetchRuns.notSuccessfulOmitted = [{ status: "partial", lines: 1, runs: 1 }];
    expect(validApiResponse("/api/overview", sixth, "summary")).toBe(false);
    const early = structuredClone(summary);
    early.fetchRuns.notSuccessful.pop();
    early.fetchRuns.notSuccessfulOmitted = [{ status: "partial", lines: 3, runs: 3 }];
    expect(validApiResponse("/api/overview", early, "summary")).toBe(false);
    const units = structuredClone(summary);
    units.unitUpdates!.push(units.unitUpdates![0]!);
    expect(validApiResponse("/api/overview", units, "summary")).toBe(false);
  });

  test("refuses a status outside the closed sets, never passing it on as one", () => {
    expect(() => overviewSummary(page({ fetchRuns: [fetchRun(1, "bank-a", "ok")] }))).toThrow(
      "overview_fetch_run_status_unknown",
    );
    expect(() =>
      overviewSummary(page({ parseRuns: [parseRun(1, "bank-a-statement", "running")] })),
    ).toThrow("overview_parse_run_status_unknown");
  });

  test("each shape passes the validator only under its own detail", () => {
    const full = page();
    const summary = overviewSummary(full);
    expect(validApiResponse("/api/overview", summary, "summary")).toBe(true);
    expect(validApiResponse("/api/overview", summary, "full")).toBe(false);
    expect(validApiResponse("/api/overview", full, "full")).toBe(true);
    expect(validApiResponse("/api/overview", full, "summary")).toBe(false);
    // A full page that claims a detail is not a full page.
    expect(validApiResponse("/api/overview", { ...full, detail: "full" }, "full")).toBe(false);
  });

  test("the validator refuses a summary whose lines do not count their status's runs", () => {
    const summary = overviewSummary(page());
    const dropped = structuredClone(summary);
    dropped.parseRuns.notOk.pop();
    expect(validApiResponse("/api/overview", dropped, "summary")).toBe(false);
    const twice = structuredClone(summary);
    twice.fetchRuns.byStatus.push(twice.fetchRuns.byStatus[0]!);
    expect(validApiResponse("/api/overview", twice, "summary")).toBe(false);
    const success = structuredClone(summary);
    success.fetchRuns.notSuccessful[0]!.status = "success" as never;
    expect(validApiResponse("/api/overview", success, "summary")).toBe(false);
    const unknown = structuredClone(summary);
    unknown.parseRuns.byStatus[0]!.status = "running" as never;
    expect(validApiResponse("/api/overview", unknown, "summary")).toBe(false);
  });
});
