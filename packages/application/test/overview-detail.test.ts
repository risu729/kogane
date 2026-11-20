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

/**
 * A random full overview: up to nine sources and eleven parsers (so a list
 * is empty, under five, exactly five, six or past it), any closed status on
 * any run, any error on any parse run (so a code repeats across statuses),
 * and unit updates whose datasets share a fetch run.
 */
function randomPage(next: () => number): {
  full: OverviewPage;
  expected: Map<number, string | null>;
} {
  const pick = <T>(choices: readonly T[]): T => choices[Math.floor(next() * choices.length)]!;
  const sources = Array.from({ length: Math.floor(next() * 10) }, (_, index) => `source-${index}`);
  const parsers = Array.from(
    { length: 1 + Math.floor(next() * 11) },
    (_, index) => `parser-${index}`,
  );
  const expected = new Map<number, string | null>();
  const ids = (count: number) =>
    [...new Set(Array.from({ length: count }, () => 1 + Math.floor(next() * 10_000)))].sort(
      (left, right) => right - left,
    );
  const fetchRuns = sources.length
    ? ids(Math.floor(next() * 60)).map((id) =>
        fetchRun(id, pick(sources), pick(["success", "partial", "partial"]), next() < 0.8),
      )
    : [];
  const parseRuns = ids(Math.floor(next() * 80)).map((id) => {
    const [error, code] = pick(ERRORS);
    expected.set(id, code);
    return parseRun(id, pick(parsers), pick(["ok", "pending", "error", "error"]), { error });
  });
  const unitUpdates = sources.length
    ? ids(Math.floor(next() * 12)).flatMap((fetchRunId) => {
        const source = pick(sources);
        // One fetch run can update several datasets: equal run ids across lines.
        return pick([
          ["statement"],
          ["statement", "balance"],
          ["balance", "card", "statement"],
        ]).map((dataset) => ({
          source_id: source,
          dataset,
          fetch_run_id: fetchRunId,
          fetched_at: "2099-01-05T21:02:00.000Z",
          updated_units: 1 + Math.floor(next() * 3),
          stale_units: Math.floor(next() * 3),
        }));
      })
    : [];
  return {
    full: page({
      sources: sources.map((id) => ({
        id,
        provider: "Synthetic Provider",
        ingestion: "collector-r2",
        artifact_count: Math.floor(next() * 4),
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

describe("overviewSummary on random full answers", () => {
  test("lists or counts every line and run, keeps every code, and always validates", () => {
    // How many lines each list had in full: every edge must come up.
    const seen = new Set<number>();
    for (let seed = 1; seed <= 1_500; seed += 1) {
      const next = random(seed);
      const { full, expected } = randomPage(next);
      const summary = overviewSummary(full);
      const label = `seed ${seed}`;
      expect(validApiResponse("/api/overview", summary, "summary"), label).toBe(true);
      const fetchLines = referenceLines(
        full.fetchRuns.filter((run) => run.status !== "success"),
        (run) => `${run.source_id} ${run.status}`,
        (run) => run.id,
      );
      expect(
        summary.fetchRuns.notSuccessful.map((line) => `${line.sourceId} ${line.status}`),
        label,
      ).toEqual(fetchLines.slice(0, 5).map((line) => line.key));
      const parseLines = referenceLines(
        full.parseRuns.filter((run) => run.status !== "ok"),
        (run) => `${run.parser_name} ${run.status}`,
        (run) => run.id,
      );
      expect(
        summary.parseRuns.notOk.map((line) => `${line.parser} ${line.status}`),
        label,
      ).toEqual(parseLines.slice(0, 5).map((line) => line.key));
      for (const lines of [fetchLines.length, parseLines.length]) seen.add(Math.min(lines, 7));
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
        expect(line.failureCodes, label).toEqual(codes.slice(0, 3));
        expect(line.failureCodes.length + line.moreFailureCodes, label).toBe(codes.length);
      }
      // A status's codes are exactly the union of its runs' codes.
      for (const line of summary.parseRuns.byStatus)
        expect(line.failureCodes, label).toEqual(
          codesOf(full.parseRuns.filter((run) => run.status === line.status)),
        );
      if (full.unitUpdates === undefined) {
        expect(summary, label).not.toHaveProperty("unitUpdatesOmitted");
        continue;
      }
      const unitLines = referenceLines(
        full.unitUpdates,
        (row) => `${row.source_id} ${row.dataset}`,
        (row) => row.fetch_run_id,
      );
      expect(
        summary.unitUpdates!.map((line) => `${line.sourceId} ${line.dataset}`),
        label,
      ).toEqual(unitLines.slice(0, 5).map((line) => line.key));
      expect(summary.unitUpdatesOmitted, label).toEqual({
        lines: unitLines.slice(5).length,
        runs: unitLines.slice(5).reduce((sum, line) => sum + line.runs, 0),
      });
      // The reader orders unit updates by run alone: the rows of one run in
      // another order are the same summary.
      expect(
        overviewSummary({ ...full, unitUpdates: [...full.unitUpdates].reverse() }),
        label,
      ).toEqual(summary);
    }
    // No lines, under five, exactly five, six, and more than six.
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
