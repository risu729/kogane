// The `summary` detail of the store overview (ADR 0123, amendment
// 2026-11-19), derived from its `full` answer alone, so `GET /api/overview`
// and `kogane.store.read` `{page: overview}` (ADR 0081) shape it once. The
// full answer lists up to 500 fetch runs and 500 parse runs; the summary
// collapses each window by status and keeps, for every status that is not a
// success, a line per source or parser with its newest run's ids, for the
// `OVERVIEW_SUMMARY_LINES` with the newest runs, and counts the rest. It
// drops text and provenance, never a state: every status is counted, with how
// many rows it collapsed, and every failure code is on its status's line.
//
// The tool's answer is held to `OVERVIEW_SUMMARY_BYTES` by construction
// (amendment 2026-11-20): names are as long as the schema lets them be, so
// the caps alone do not bound it. When the answer is over, the summary moves,
// one at a time and in a fixed order, sources into `sourcesOmitted`, then
// per-line failure codes into their line's count, then lines into their
// list's count, and says it did (`budget.trimmed`). When the counts, the
// coverage and the status lines alone pass it, it refuses
// (`OverviewSummaryLimitError`), never answering past the budget.
import {
  OVERVIEW_FETCH_RUN_STATUSES,
  OVERVIEW_LINE_FAILURE_CODES,
  OVERVIEW_PARSE_RUN_STATUSES,
  OVERVIEW_SUMMARY_BYTES,
  OVERVIEW_SUMMARY_LINES,
  type OverviewOmitted,
  type OverviewPage,
  type OverviewSummary,
  PAGE_READ_SCHEMA_VERSION,
} from "../../../observation-shared/src/api-contract.ts";
import { safeCode } from "./collection-quality.ts";

/**
 * The overview summary's counts, coverage and status lines alone are over
 * `OVERVIEW_SUMMARY_BYTES`: the read is refused (413), never answered past
 * the budget or with a status line cut.
 */
export class OverviewSummaryLimitError extends Error {
  constructor() {
    super("overview_summary_limit_exceeded");
  }
}

/** The bytes of the tool's answer that carries `data`, as the tool serializes it. */
export function overviewAnswerBytes(data: unknown): number {
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: PAGE_READ_SCHEMA_VERSION, data }))
    .length;
}

type FetchStatus = (typeof OVERVIEW_FETCH_RUN_STATUSES)[number];
type ParseStatus = (typeof OVERVIEW_PARSE_RUN_STATUSES)[number];

/** A status from the closed set, or a refusal: a status nobody defined is never passed on as one. */
function closed<T extends string>(choices: readonly T[], status: string, code: string): T {
  if (!(choices as readonly string[]).includes(status)) throw new Error(code);
  return status as T;
}

/** `rows` grouped by `key` in order of first appearance; the window is newest first. */
function groups<Row>(rows: readonly Row[], key: (row: Row) => unknown): Row[][] {
  const out = new Map<string, Row[]>();
  for (const row of rows) {
    const text = JSON.stringify(key(row));
    const group = out.get(text);
    if (group) group.push(row);
    else out.set(text, [row]);
  }
  return [...out.values()];
}

/** The row with the highest id: the newest of a window that is ordered by id. */
function newest<Row extends { id: number }>(rows: readonly Row[]): Row {
  return rows.reduce((best, row) => (row.id > best.id ? row : best));
}

/**
 * The distinct failure codes of some runs, newest first. The Processor
 * writes `parse_runs.error` as a closed code (a pipeline or metadata error's
 * code, the failing stage, or `parse_interrupted`), never the parser's text,
 * so the summary keeps it as the failure code it is (ADR 0123: every closed
 * reason and failure code stays). A value that is not code-shaped is
 * `unclassified`, never passed on as text.
 */
function failureCodes(rows: readonly OverviewPage["parseRuns"][number][]): string[] {
  const codes: string[] = [];
  for (const row of [...rows].sort((left, right) => right.id - left.id)) {
    const code = safeCode(row.error);
    if (code !== null && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * Lines newest first. Lines whose newest runs are the same run (one fetch
 * run's datasets) are ordered by `key`, so which of them is listed never
 * depends on the order the reader returned them in.
 */
function ordered<Line>(
  lines: readonly Line[],
  newestId: (line: Line) => number,
  key: (line: Line) => string,
): Line[] {
  return [...lines].sort(
    (left, right) =>
      newestId(right) - newestId(left) ||
      (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0),
  );
}

/**
 * Per status, the lines past the listed ones with their runs: what a list
 * leaves out is counted, never dropped silently (INV05).
 */
function leftOut<Line extends { status: string; runs: number }>(
  lines: readonly Line[],
): OverviewOmitted<Line["status"]>[] {
  const omitted: OverviewOmitted<Line["status"]>[] = [];
  for (const line of lines) {
    const entry = omitted.find((candidate) => candidate.status === line.status);
    if (entry) {
      entry.lines += 1;
      entry.runs += line.runs;
    } else omitted.push({ status: line.status, lines: 1, runs: line.runs });
  }
  return omitted;
}

/** The three bounded lists, in the order a tie between them is trimmed. */
const LISTS = ["unitUpdates", "notSuccessful", "notOk"] as const;

/**
 * The summary of one overview page; it reads nothing the page does not. Its
 * tool answer is at most `OVERVIEW_SUMMARY_BYTES`, or it throws
 * `OverviewSummaryLimitError`.
 */
export function overviewSummary(page: OverviewPage): OverviewSummary {
  const fetchRuns = page.fetchRuns.map((run) => ({
    ...run,
    status: closed<FetchStatus>(
      OVERVIEW_FETCH_RUN_STATUSES,
      run.status,
      "overview_fetch_run_status_unknown",
    ),
  }));
  const parseRuns = page.parseRuns.map((run) => ({
    ...run,
    status: closed<ParseStatus>(
      OVERVIEW_PARSE_RUN_STATUSES,
      run.status,
      "overview_parse_run_status_unknown",
    ),
  }));
  const notSuccessful = ordered(
    groups(
      fetchRuns.filter((run) => run.status !== "success"),
      (run) => [run.source_id, run.status],
    ).map((group) => {
      const run = newest(group);
      return {
        sourceId: run.source_id,
        status: run.status,
        runs: group.length,
        newest: { id: run.id, startedAt: run.started_at, completedAt: run.completed_at },
      };
    }),
    (line) => line.newest.id,
    (line) => `${line.sourceId} ${line.status}`,
  );
  const notOk = ordered(
    groups(
      parseRuns.filter((run) => run.status !== "ok"),
      (run) => [run.parser_name, run.status],
    ).map((group) => {
      const run = newest(group);
      return {
        line: {
          parser: run.parser_name,
          status: run.status,
          runs: group.length,
          superseded: group.filter((entry) => entry.superseded_by_parse_run_id !== null).length,
        },
        codes: failureCodes(group),
        newest: { id: run.id, artifactId: run.fetch_artifact_id, parsedAt: run.parsed_at },
        status: run.status,
        runs: group.length,
      };
    }),
    (entry) => entry.newest.id,
    (entry) => `${entry.line.parser} ${entry.line.status}`,
  );
  const unitUpdates =
    page.unitUpdates === undefined
      ? undefined
      : ordered(
          groups(page.unitUpdates, (row) => [row.source_id, row.dataset]).map((group) => {
            const row = group.reduce((best, entry) =>
              entry.fetch_run_id > best.fetch_run_id ? entry : best,
            );
            return {
              sourceId: row.source_id,
              dataset: row.dataset,
              runs: group.length,
              newest: {
                fetchRunId: row.fetch_run_id,
                fetchedAt: row.fetched_at,
                updatedUnits: row.updated_units,
                staleUnits: row.stale_units,
              },
            };
          }),
          (line) => line.newest.fetchRunId,
          (line) => `${line.sourceId} ${line.dataset}`,
        );
  const fetchByStatus = groups(fetchRuns, (run) => run.status).map((group) => {
    const run = newest(group);
    return {
      status: run.status,
      runs: group.length,
      sources: new Set(group.map((entry) => entry.source_id)).size,
      newest: {
        id: run.id,
        sourceId: run.source_id,
        startedAt: run.started_at,
        completedAt: run.completed_at,
      },
    };
  });
  const parseByStatus = groups(parseRuns, (run) => run.status).map((group) => {
    const run = newest(group);
    return {
      status: run.status,
      runs: group.length,
      superseded: group.filter((entry) => entry.superseded_by_parse_run_id !== null).length,
      withWarnings: group.filter((entry) => entry.warnings.list.length > 0).length,
      unreadableWarnings: group.filter((entry) => !entry.warnings.parsed).length,
      parsers: new Set(group.map((entry) => entry.parser_name)).size,
      failureCodes: failureCodes(group),
      newest: {
        id: run.id,
        artifactId: run.fetch_artifact_id,
        parser: run.parser_name,
        parsedAt: run.parsed_at,
      },
    };
  });

  // What the budget may trim: how many lines each list holds, how many codes
  // each `notOk` line lists, and how many sources are listed. The caps set
  // where they start.
  const listed = {
    unitUpdates: Math.min(OVERVIEW_SUMMARY_LINES, unitUpdates?.length ?? 0),
    notSuccessful: Math.min(OVERVIEW_SUMMARY_LINES, notSuccessful.length),
    notOk: Math.min(OVERVIEW_SUMMARY_LINES, notOk.length),
  };
  const codesListed = notOk.map((entry) =>
    Math.min(OVERVIEW_LINE_FAILURE_CODES, entry.codes.length),
  );
  let sourcesListed = page.sources.length;
  let trimmed = false;

  const build = (): OverviewSummary => {
    const sources = new Map<number, OverviewSummary["sources"][number]>();
    for (const source of page.sources.slice(0, sourcesListed)) {
      const same = sources.get(source.artifact_count);
      if (same) same.sourceIds.push(source.id);
      else
        sources.set(source.artifact_count, {
          sourceIds: [source.id],
          artifacts: source.artifact_count,
        });
    }
    const unitOmitted = unitUpdates === undefined ? [] : unitUpdates.slice(listed.unitUpdates);
    return {
      detail: "summary",
      counts: page.counts,
      sources: [...sources.values()],
      sourcesOmitted: page.sources.length - sourcesListed,
      fetchRuns: {
        byStatus: fetchByStatus,
        notSuccessful: notSuccessful.slice(0, listed.notSuccessful),
        notSuccessfulOmitted: leftOut(notSuccessful.slice(listed.notSuccessful)),
      },
      parseRuns: {
        byStatus: parseByStatus,
        notOk: notOk.slice(0, listed.notOk).map((entry, index) => ({
          ...entry.line,
          failureCodes: entry.codes.slice(0, codesListed[index]),
          moreFailureCodes: entry.codes.length - codesListed[index]!,
          newest: entry.newest,
        })),
        notOkOmitted: leftOut(notOk.slice(listed.notOk)),
      },
      ...(unitUpdates === undefined
        ? {}
        : {
            unitUpdates: unitUpdates.slice(0, listed.unitUpdates),
            unitUpdatesOmitted: {
              lines: unitOmitted.length,
              runs: unitOmitted.reduce((sum, line) => sum + line.runs, 0),
            },
          }),
      coverage: page.coverage,
      budget: { bytes: OVERVIEW_SUMMARY_BYTES, trimmed },
    };
  };
  const fitting = (): OverviewSummary | null => {
    const summary = build();
    return overviewAnswerBytes(summary) <= OVERVIEW_SUMMARY_BYTES ? summary : null;
  };

  const untrimmed = fitting();
  if (untrimmed) return untrimmed;
  trimmed = true;
  // 1. Sources, the last in the full answer's order (by id) first, into
  //    `sourcesOmitted`: an artifact count is neither a state nor a code,
  //    and `full` and `kogane.evidence.read` hold every one. Leaving one more
  //    out never lengthens the answer, so the most that still fit are found
  //    by halving, as leaving them out one at a time would.
  if (page.sources.length > 0) {
    sourcesListed = 0;
    if (fitting()) {
      // `fits` sources listed fit; `over` do not, or (all of them) trim nothing.
      let fits = 0;
      let over = page.sources.length;
      while (over - fits > 1) {
        const middle = Math.floor((fits + over) / 2);
        sourcesListed = middle;
        if (fitting()) fits = middle;
        else over = middle;
      }
      sourcesListed = fits;
      return build();
    }
  }
  // 2. Per-line failure codes, the oldest listed line's first and each
  //    line's oldest code first: a code moved into `moreFailureCodes` stays
  //    on its status's line, so only which line it was on is lost.
  for (let index = listed.notOk - 1; index >= 0; index -= 1)
    while (codesListed[index]! > 0) {
      codesListed[index]! -= 1;
      const summary = fitting();
      if (summary) return summary;
    }
  // 3. Lines, the oldest line of the list holding the most first (a tie goes
  //    `unitUpdates`, `notSuccessful`, `notOk`), into their list's count.
  for (;;) {
    const list = LISTS.reduce((most, name) => (listed[name] > listed[most] ? name : most));
    if (listed[list] === 0) break;
    listed[list] -= 1;
    const summary = fitting();
    if (summary) return summary;
  }
  // 4. Past that, only the counts, the coverage and the status lines are
  //    left, and none of them is cut: the read is refused.
  throw new OverviewSummaryLimitError();
}
