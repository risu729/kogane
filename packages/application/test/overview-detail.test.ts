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
      parseRun(7, "card-c-statement", "error"),
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
            newest: { id: 7, artifactId: 107, parsedAt: "2099-01-07T21:10:00.000Z" },
          },
          {
            parser: "bank-a-statement",
            status: "pending",
            runs: 1,
            superseded: 0,
            newest: { id: 5, artifactId: 105, parsedAt: "2099-01-05T21:10:00.000Z" },
          },
        ],
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
