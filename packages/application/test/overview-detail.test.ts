// The store overview's `summary` detail (ADR 0123, amendment 2026-11-19):
// the run windows collapse by status and by source or parser, never a state.
// Every status is counted with how many rows it collapsed, and every line
// keeps the ids that read its newest run further. Every id, name and time is
// invented; no amount or provider text is written.
import { describe, expect, test } from "bun:test";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import type { OverviewPage, OverviewSummary } from "../../observation-shared/src/api-contract.ts";
import { OverviewSummaryLimitError, overviewSummary } from "../src/query/overview-detail.ts";

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
      sourcesOmitted: 0,
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
      // Far under the byte budget: nothing was trimmed to fit it.
      budget: { bytes: 8192, trimmed: false },
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

/** The bytes of the tool's answer, as the tool serializes it. */
const answerBytes = (data: unknown) =>
  new TextEncoder().encode(JSON.stringify({ schemaVersion: "kogane-page-read-v1", data })).length;

/** `prefix` padded with `x` to `length` characters. */
const padded = (prefix: string, length: number) => prefix.padEnd(length, "x");

/** A 64-character code, the longest `safeCode` passes on. */
const longCode = (index: number) => padded(`code_${index}_`, 64);

/**
 * A full answer whose three lists are each full (five lines, one left out)
 * with every `notOk` line at three codes and one more, at the schema's
 * longest source ids (100 characters) and datasets (200), with four sources
 * each with its own artifact count, and widest counts. `filler` lengthens one
 * table name in `counts`, a byte at a time: only the budget trims for it.
 */
function crowded(filler: number): OverviewPage {
  const failing = Array.from({ length: 6 }, (_, index) => padded(`parser-${index}-`, 60));
  return page({
    counts: [
      { table: padded("synthetic_", 10 + filler), rows: Number.MAX_SAFE_INTEGER },
      { table: "sources", rows: Number.MAX_SAFE_INTEGER },
    ],
    sources: Array.from({ length: 4 }, (_, index) => ({
      id: padded(`source-${index}-`, 100),
      provider: "Synthetic Provider",
      ingestion: "collector-r2",
      artifact_count: Number.MAX_SAFE_INTEGER - index,
    })),
    fetchRuns: Array.from({ length: 6 }, (_, index) =>
      fetchRun(9_000_000 - index, padded(`partial-${index}-`, 100), "partial"),
    ),
    // Each failing parser has four codes, newest first, out of eight in all.
    parseRuns: failing.flatMap((parser, line) =>
      Array.from({ length: 4 }, (_, code) =>
        parseRun(8_000_000 - line * 10 - code, parser, "error", {
          error: longCode((line + code) % 8),
        }),
      ),
    ),
    unitUpdates: Array.from({ length: 6 }, (_, index) => ({
      source_id: padded(`unit-${index}-`, 100),
      dataset: padded(`dataset-${index}-`, 200),
      fetch_run_id: 7_000_000 - index,
      fetched_at: "2099-01-05T21:02:00.000Z",
      updated_units: Number.MAX_SAFE_INTEGER,
      stale_units: Number.MAX_SAFE_INTEGER,
    })),
  });
}

/** How far the budget went: codes counted per listed `notOk` line, lines per list, sources left out. */
function trimState(summary: OverviewSummary) {
  return {
    codes: summary.parseRuns.notOk.map((line) => line.moreFailureCodes),
    lines: [
      summary.unitUpdates?.length ?? 0,
      summary.fetchRuns.notSuccessful.length,
      summary.parseRuns.notOk.length,
    ],
    sources: summary.sourcesOmitted,
  };
}

/** The summaries of `crowded` as its filler grows, a step at a time, until it is refused. */
function ladder(step: number): { filler: number; summary: OverviewSummary | null }[] {
  const out: { filler: number; summary: OverviewSummary | null }[] = [];
  for (let filler = 0; ; filler += step) {
    try {
      out.push({ filler, summary: overviewSummary(crowded(filler)) });
    } catch (error) {
      expect(error).toBeInstanceOf(OverviewSummaryLimitError);
      out.push({ filler, summary: null });
      return out;
    }
  }
}

describe("overviewSummary within its byte budget (amendment 2026-11-20)", () => {
  // Steps of 16 bytes: finer than a code (66 bytes with its quotes and comma).
  const steps = ladder(16);

  test("trims sources, then per-line codes, then lines, then refuses, in a fixed order, and says so", () => {
    const stages: string[] = [];
    let previous: OverviewSummary | undefined;
    for (const { filler, summary } of steps) {
      const label = `filler ${filler}`;
      if (summary === null) {
        stages.push("refused");
        // Refused only once nothing but the counts, coverage and status lines is left.
        expect(previous && trimState(previous), label).toEqual({
          codes: [],
          lines: [0, 0, 0],
          sources: 4,
        });
        continue;
      }
      expect(answerBytes(summary), label).toBeLessThanOrEqual(8192);
      expect(validApiResponse("/api/overview", summary, "summary"), label).toBe(true);
      const state = trimState(summary);
      let stage: string;
      if (!summary.budget.trimmed) {
        // The caps alone: five lines a list, three codes a line, every source.
        expect(state, label).toEqual({ codes: [1, 1, 1, 1, 1], lines: [5, 5, 5], sources: 0 });
        stage = "untrimmed";
      } else if (state.lines.some((count) => count < 5)) {
        // Lines go last, after every source and every per-line code.
        expect(state.sources, label).toBe(4);
        for (const line of summary.parseRuns.notOk) expect(line.failureCodes, label).toEqual([]);
        stage = "lines";
      } else if (state.codes.some((count) => count > 1)) {
        // Per-line codes go after every source, before any line.
        expect(state.sources, label).toBe(4);
        stage = "codes";
      } else {
        // Sources go first, the last by id first, before any code or line.
        expect(state, label).toEqual({
          codes: [1, 1, 1, 1, 1],
          lines: [5, 5, 5],
          sources: expect.any(Number),
        });
        expect(state.sources, label).toBeGreaterThan(0);
        stage = "sources";
      }
      const listed = summary.sources.flatMap((line) => line.sourceIds);
      expect(listed, label).toEqual(
        crowded(filler)
          .sources.slice(0, 4 - state.sources)
          .map((source) => source.id),
      );
      if (stages.at(-1) !== stage) stages.push(stage);
      // Each listed line keeps the newest of its codes and counts the rest.
      for (const line of summary.parseRuns.notOk)
        expect(line.failureCodes.length + line.moreFailureCodes, label).toBe(4);
      // Every code stays on its status's line.
      expect(summary.parseRuns.byStatus[0]!.failureCodes, label).toHaveLength(8);
      if (previous) {
        // A longer answer is trimmed at least as far.
        const before = trimState(previous);
        expect(state.sources, label).toBeGreaterThanOrEqual(before.sources);
        for (const [index, count] of state.lines.entries())
          expect(count, label).toBeLessThanOrEqual(before.lines[index]!);
        if (state.lines[2] === before.lines[2])
          for (const [index, count] of state.codes.entries())
            expect(count, label).toBeGreaterThanOrEqual(before.codes[index]!);
      }
      previous = summary;
    }
    expect(stages).toEqual(["untrimmed", "sources", "codes", "lines", "refused"]);
  });

  test("leaves the last source out first, then the oldest listed line's oldest code, then the oldest line of the longest list", () => {
    const first = (predicate: (summary: OverviewSummary) => boolean) =>
      steps.find(({ summary }) => summary !== null && predicate(summary))!.summary!;
    // A source's line is longer than a step: the first trim leaves one out, the last by id.
    const sourced = first((summary) => summary.budget.trimmed);
    expect(sourced.sourcesOmitted).toBe(1);
    expect(sourced.sources.flatMap((line) => line.sourceIds)).toEqual(
      [0, 1, 2].map((index) => padded(`source-${index}-`, 100)),
    );
    const coded = first((summary) => trimState(summary).codes.some((count) => count > 1));
    expect(trimState(coded)).toEqual({ codes: [1, 1, 1, 1, 2], lines: [5, 5, 5], sources: 4 });
    expect(coded.sources).toEqual([]);
    // The fifth line's codes are 4, 5, 6 and 7, newest first.
    expect(coded.parseRuns.notOk[4]!.failureCodes).toEqual([longCode(4), longCode(5)]);
    // Then the fourth line's, once the fifth lists none.
    expect(
      trimState(first((summary) => summary.parseRuns.notOk[3]?.moreFailureCodes === 2)).codes,
    ).toEqual([1, 1, 1, 2, 4]);
    // A tie between full lists goes `unitUpdates`, `notSuccessful`, `notOk`.
    const lined = first((summary) => trimState(summary).lines.some((count) => count < 5));
    expect(trimState(lined).lines).toEqual([4, 5, 5]);
    expect(lined.unitUpdates!.map((line) => line.sourceId)).toEqual(
      [0, 1, 2, 3].map((index) => padded(`unit-${index}-`, 100)),
    );
    expect(lined.unitUpdatesOmitted).toEqual({ lines: 2, runs: 2 });
    expect(trimState(first((summary) => trimState(summary).lines[1]! < 5)).lines).toEqual([
      4, 4, 5,
    ]);
    const parsed = first((summary) => trimState(summary).lines[2]! < 5);
    expect(trimState(parsed).lines).toEqual([4, 4, 4]);
    expect(parsed.parseRuns.notOkOmitted).toEqual([{ status: "error", lines: 2, runs: 8 }]);
    expect(trimState(first((summary) => trimState(summary).lines[0]! < 4)).lines).toEqual([
      3, 4, 4,
    ]);
  });

  test("refuses when the counts, coverage and status lines alone pass the budget", () => {
    // Parser names have no schema bound: three statuses' newest parsers at
    // 3,000 characters each leave no room, and no status line is ever cut.
    const huge = (status: string, id: number) => parseRun(id, padded(status, 3_000), status);
    const parseRuns = [huge("ok", 3), huge("pending", 2), huge("error", 1)];
    expect(() => overviewSummary(page({ parseRuns }))).toThrow(OverviewSummaryLimitError);
    // With no source to leave out either: still refused, never over.
    expect(() => overviewSummary(page({ sources: [], parseRuns }))).toThrow(
      OverviewSummaryLimitError,
    );
  });

  test("the validator accepts what the budget trims only when the summary says so, and still refuses miscounts", () => {
    const untrimmed = steps[0]!.summary!;
    expect(untrimmed.budget.trimmed).toBe(false);
    const claimed = structuredClone(untrimmed);
    claimed.budget.trimmed = true;
    expect(validApiResponse("/api/overview", claimed, "summary")).toBe(false);
    for (const { summary } of steps) {
      if (summary === null || !summary.budget.trimmed) continue;
      expect(validApiResponse("/api/overview", summary, "summary")).toBe(true);
      const hidden = structuredClone(summary);
      hidden.budget.trimmed = false;
      expect(validApiResponse("/api/overview", hidden, "summary")).toBe(false);
      // Another budget is not this one.
      const other = structuredClone(summary);
      other.budget.bytes = 16_384;
      expect(validApiResponse("/api/overview", other, "summary")).toBe(false);
      // Lines left out without being counted, or miscounted, are refused.
      const silent = structuredClone(summary);
      silent.fetchRuns.notSuccessfulOmitted = [];
      expect(validApiResponse("/api/overview", silent, "summary")).toBe(false);
      const miscounted = structuredClone(summary);
      miscounted.parseRuns.notOkOmitted[0]!.runs += 1;
      expect(validApiResponse("/api/overview", miscounted, "summary")).toBe(false);
      // A line counting more codes than its status has is refused.
      const codes = structuredClone(summary);
      if (codes.parseRuns.notOk[0]) {
        codes.parseRuns.notOk[0].moreFailureCodes += 8;
        expect(validApiResponse("/api/overview", codes, "summary")).toBe(false);
      }
    }
    // A summary past the budget is refused, whatever it says.
    const over = structuredClone(untrimmed);
    over.counts = Array.from({ length: 200 }, (_, index) => ({
      table: `synthetic_table_${index}`,
      rows: index,
    }));
    expect(answerBytes(over)).toBeGreaterThan(8192);
    expect(validApiResponse("/api/overview", over, "summary")).toBe(false);
  });
});

/** A seeded generator, so a failing case repeats. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Each stored error and the failure code the summary must keep for it. */
const ERRORS: [string | null, string | null][] = [
  [null, null],
  ["parser_rejected", "parser_rejected"],
  ["raw_object_missing", "raw_object_missing"],
  ["parse_interrupted", "parse_interrupted"],
  ["manifest-shape-invalid", "manifest_shape_invalid"],
  ["persistence_failed", "persistence_failed"],
  ["Synthetic provider text", "unclassified"],
];
/** The same, with codes as long as `safeCode` passes on. */
const LONG_ERRORS: [string | null, string | null][] = [
  ...ERRORS,
  ...[0, 1, 2, 3].map((index): [string, string] => [longCode(index), longCode(index)]),
];

/**
 * A random full overview: up to nine sources and eleven parsers (so a list
 * is empty, under five, exactly five, six or past it), any closed status on
 * any run, any error on any parse run (so a code repeats across statuses),
 * and unit updates whose datasets share a fetch run. `long` widens it to
 * what the schema lets through: up to 120 sources, source ids of up to 100
 * characters, datasets of up to 200, parser names of up to 400, codes of
 * 64, and counts and ids as wide as a safe integer.
 */
function randomPage(
  next: () => number,
  long = false,
): {
  full: OverviewPage;
  expected: Map<number, string | null>;
} {
  const pick = <T>(choices: readonly T[]): T => choices[Math.floor(next() * choices.length)]!;
  const width = (name: string, lengths: readonly number[]) =>
    long ? padded(`${name}-`, pick(lengths)) : name;
  const sources = Array.from({ length: Math.floor(next() * (long ? 121 : 10)) }, (_, index) =>
    width(`source-${String(index).padStart(3, "0")}`, [17, 60, 100]),
  );
  const parsers = Array.from({ length: 1 + Math.floor(next() * 11) }, (_, index) =>
    width(`parser-${index}`, [40, 120, 400]),
  );
  const datasets = ["statement", "balance", "card"].map((dataset) =>
    width(dataset, [37, 120, 200]),
  );
  const [statement, balance, card] = datasets as [string, string, string];
  const expected = new Map<number, string | null>();
  // Ids as wide as a safe integer when long: the summary repeats them.
  const scale = long ? 900_000_000_000 : 1;
  const ids = (count: number) =>
    [
      ...new Set(Array.from({ length: count }, () => (1 + Math.floor(next() * 10_000)) * scale)),
    ].sort((left, right) => right - left);
  const fetchRuns = sources.length
    ? ids(Math.floor(next() * 60)).map((id) =>
        fetchRun(id, pick(sources), pick(["success", "partial", "partial"]), next() < 0.8),
      )
    : [];
  const parseRuns = ids(Math.floor(next() * 80)).map((id) => {
    const [error, code] = pick(long ? LONG_ERRORS : ERRORS);
    expected.set(id, code);
    return parseRun(id, pick(parsers), pick(["ok", "pending", "error", "error"]), { error });
  });
  const unitUpdates = sources.length
    ? ids(Math.floor(next() * 12)).flatMap((fetchRunId) => {
        const source = pick(sources);
        // One fetch run can update several datasets: equal run ids across lines.
        return pick([[statement], [statement, balance], [balance, card, statement]]).map(
          (dataset) => ({
            source_id: source,
            dataset,
            fetch_run_id: fetchRunId,
            fetched_at: "2099-01-05T21:02:00.000Z",
            updated_units: long ? Number.MAX_SAFE_INTEGER : 1 + Math.floor(next() * 3),
            stale_units: long ? Number.MAX_SAFE_INTEGER - 1 : Math.floor(next() * 3),
          }),
        );
      })
    : [];
  return {
    full: page({
      ...(long
        ? {
            counts: ["sources", "fetch_runs", "raw_objects", "parse_runs"].map((table) => ({
              table,
              rows: Number.MAX_SAFE_INTEGER,
            })),
          }
        : {}),
      sources: sources.map((id) => ({
        id,
        provider: "Synthetic Provider",
        ingestion: "collector-r2",
        artifact_count: long
          ? Number.MAX_SAFE_INTEGER - Math.floor(next() * 1_000)
          : Math.floor(next() * 4),
      })),
      fetchRuns,
      parseRuns,
      ...(unitUpdates.length ? { unitUpdates } : {}),
    }),
    expected,
  };
}

/** Lines per key of `rows`, each with its runs and newest id, newest first, ties by key. */
function referenceLines<Row>(
  rows: readonly Row[],
  key: (row: Row) => string,
  id: (row: Row) => number,
): { key: string; runs: number; rows: Row[] }[] {
  const lines = new Map<string, { key: string; runs: number; newest: number; rows: Row[] }>();
  for (const row of rows) {
    const line = lines.get(key(row)) ?? { key: key(row), runs: 0, newest: 0, rows: [] };
    line.runs += 1;
    line.newest = Math.max(line.newest, id(row));
    line.rows.push(row);
    lines.set(key(row), line);
  }
  return [...lines.values()].sort(
    (left, right) => right.newest - left.newest || (left.key < right.key ? -1 : 1),
  );
}

/**
 * Check one random full answer's summary: it fits the budget and validates;
 * each list holds a prefix of the reference ordering (the first five when
 * the budget did not trim it); listed and left-out lines and runs add up to
 * the full answer's; a line's codes are a prefix of its runs' codes (the
 * first three untrimmed) with the rest counted; each status's codes are
 * exactly its runs'; the sources listed are the first of the full answer's
 * order; the budget's steps came in order; and miscounted omitted entries
 * fail the validator. Returns how many lines each list had in full, and how
 * far the budget went.
 */
function checkRandom(
  seed: number,
  long: boolean,
): { lines: number[]; stage: "untrimmed" | "codes" | "lines" | "sources" } {
  const next = random(seed);
  const { full, expected } = randomPage(next, long);
  const summary = overviewSummary(full);
  const label = `seed ${seed}${long ? " (long)" : ""}`;
  const { trimmed } = summary.budget;
  expect(validApiResponse("/api/overview", summary, "summary"), label).toBe(true);
  expect(answerBytes(summary), label).toBeLessThanOrEqual(8192);
  let short = false;
  /** Listed lines are the reference's first: five of them, or fewer only when trimmed. */
  const listedPrefix = (listed: string[], reference: string[]) => {
    expect(listed, label).toEqual(reference.slice(0, listed.length));
    if (listed.length < Math.min(5, reference.length)) short = true;
    if (!trimmed) expect(listed.length, label).toBe(Math.min(5, reference.length));
  };
  /**
   * How far the budget went: per-line codes go only after every source, and
   * lines only after every source and every listed line's codes.
   */
  const stage = () => {
    if (!trimmed) return "untrimmed" as const;
    if (short) {
      expect(summary.sourcesOmitted, label).toBe(full.sources.length);
      for (const line of summary.parseRuns.notOk) expect(line.failureCodes, label).toEqual([]);
      return "lines" as const;
    }
    if (
      summary.parseRuns.notOk.some(
        (line) => line.moreFailureCodes > 0 && line.failureCodes.length < 3,
      )
    ) {
      expect(summary.sourcesOmitted, label).toBe(full.sources.length);
      return "codes" as const;
    }
    expect(summary.sourcesOmitted, label).toBeGreaterThan(0);
    return "sources" as const;
  };
  const fetchLines = referenceLines(
    full.fetchRuns.filter((run) => run.status !== "success"),
    (run) => `${run.source_id} ${run.status}`,
    (run) => run.id,
  );
  listedPrefix(
    summary.fetchRuns.notSuccessful.map((line) => `${line.sourceId} ${line.status}`),
    fetchLines.map((line) => line.key),
  );
  const parseLines = referenceLines(
    full.parseRuns.filter((run) => run.status !== "ok"),
    (run) => `${run.parser_name} ${run.status}`,
    (run) => run.id,
  );
  listedPrefix(
    summary.parseRuns.notOk.map((line) => `${line.parser} ${line.status}`),
    parseLines.map((line) => line.key),
  );
  // Listed and left-out lines and runs add up to the full answer's, per status.
  for (const [lines, listed, omitted] of [
    [fetchLines, summary.fetchRuns.notSuccessful, summary.fetchRuns.notSuccessfulOmitted],
    [parseLines, summary.parseRuns.notOk, summary.parseRuns.notOkOmitted],
  ] as const) {
    for (const status of new Set(lines.map((line) => line.key.split(" ")[1]))) {
      const all = lines.filter((line) => line.key.endsWith(` ${status}`));
      const shown = (listed as readonly { status: string; runs: number }[]).filter(
        (line) => line.status === status,
      );
      const left = (omitted as readonly { status: string; lines: number; runs: number }[]).find(
        (entry) => entry.status === status,
      ) ?? { lines: 0, runs: 0 };
      expect(shown.length + left.lines, label).toBe(all.length);
      expect(shown.reduce((sum, line) => sum + line.runs, 0) + left.runs, label).toBe(
        all.reduce((sum, line) => sum + line.runs, 0),
      );
    }
  }
  // A left-out entry that miscounts its lines is not a summary, even
  // with its runs right.
  for (const omitted of [
    summary.fetchRuns.notSuccessfulOmitted,
    summary.parseRuns.notOkOmitted,
  ] as { lines: number; runs: number }[][])
    for (const [index, entry] of omitted.entries())
      for (const lines of [entry.lines - 1, entry.lines + 1]) {
        // Each left-out line has a run: a count past its runs is refused anyway.
        if (lines < 1 || lines > entry.runs) continue;
        const miscounted = structuredClone(summary);
        (omitted === summary.fetchRuns.notSuccessfulOmitted
          ? miscounted.fetchRuns.notSuccessfulOmitted
          : miscounted.parseRuns.notOkOmitted)[index]!.lines = lines;
        expect(validApiResponse("/api/overview", miscounted, "summary"), label).toBe(false);
      }
  // A line's codes, shown and counted, are its runs' distinct codes, newest first.
  const codesOf = (rows: readonly { id: number }[]) => [
    ...new Set(
      [...rows]
        .sort((left, right) => right.id - left.id)
        .map((row) => expected.get(row.id))
        .filter((code): code is string => code !== null && code !== undefined),
    ),
  ];
  for (const line of summary.parseRuns.notOk) {
    const codes = codesOf(
      parseLines.find((entry) => entry.key === `${line.parser} ${line.status}`)!.rows,
    );
    expect(line.failureCodes, label).toEqual(
      codes.slice(0, trimmed ? line.failureCodes.length : 3),
    );
    expect(line.failureCodes.length + line.moreFailureCodes, label).toBe(codes.length);
  }
  // A status's codes are exactly the union of its runs' codes, trimmed or not.
  for (const line of summary.parseRuns.byStatus)
    expect(line.failureCodes, label).toEqual(
      codesOf(full.parseRuns.filter((run) => run.status === line.status)),
    );
  // The sources listed are the full answer's first, every one when untrimmed.
  const sourceIds = summary.sources.flatMap((line) => line.sourceIds);
  expect(new Set(sourceIds), label).toEqual(
    new Set(full.sources.slice(0, full.sources.length - summary.sourcesOmitted).map((s) => s.id)),
  );
  expect(sourceIds.length + summary.sourcesOmitted, label).toBe(full.sources.length);
  if (!trimmed) expect(summary.sourcesOmitted, label).toBe(0);
  const lines = [fetchLines.length, parseLines.length];
  if (full.unitUpdates === undefined) {
    expect(summary, label).not.toHaveProperty("unitUpdatesOmitted");
    return { lines, stage: stage() };
  }
  const unitLines = referenceLines(
    full.unitUpdates,
    (row) => `${row.source_id} ${row.dataset}`,
    (row) => row.fetch_run_id,
  );
  listedPrefix(
    summary.unitUpdates!.map((line) => `${line.sourceId} ${line.dataset}`),
    unitLines.map((line) => line.key),
  );
  const left = unitLines.slice(summary.unitUpdates!.length);
  expect(summary.unitUpdatesOmitted, label).toEqual({
    lines: left.length,
    runs: left.reduce((sum, line) => sum + line.runs, 0),
  });
  // The reader orders unit updates by run alone: the rows of one run in
  // another order are the same summary.
  expect(overviewSummary({ ...full, unitUpdates: [...full.unitUpdates].reverse() }), label).toEqual(
    summary,
  );
  return { lines, stage: stage() };
}

describe("overviewSummary on random full answers", () => {
  test("lists or counts every line and run, keeps every code, and always validates", () => {
    // How many lines each list had in full: every edge must come up.
    const seen = new Set<number>();
    for (let seed = 1; seed <= 1_500; seed += 1) {
      const { lines, stage } = checkRandom(seed, false);
      // Names this short never reach the budget.
      expect(stage, `seed ${seed}`).toBe("untrimmed");
      for (const count of lines) seen.add(Math.min(count, 7));
    }
    // No lines, under five, exactly five, six, and more than six.
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("stays within 8,192 bytes at the schema's longest names and widest counts", () => {
    // 100-character source ids, 200-character datasets, 400-character parser
    // names, 64-character codes, up to 120 sources and safe-integer counts:
    // trimmed or not, every summary fits, validates and counts what it
    // leaves out, and the budget's every step comes up.
    const stages = new Set<string>();
    for (let seed = 1; seed <= 600; seed += 1) stages.add(checkRandom(seed, true).stage);
    expect([...stages].sort()).toEqual(["codes", "lines", "sources", "untrimmed"]);
  });
});
