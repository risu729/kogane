// The `summary` detail of the store overview (ADR 0123, amendment
// 2026-11-19), derived from its `full` answer alone, so `GET /api/overview`
// and `kogane.store.read` `{page: overview}` (ADR 0081) shape it once. The
// full answer lists up to 500 fetch runs and 500 parse runs; the summary
// collapses each window by status and keeps, for every status that is not a
// success, one line per source or parser with its newest run's ids. It drops
// text and provenance, never a state: every status is counted, with how many
// rows it collapsed.
import {
  OVERVIEW_FETCH_RUN_STATUSES,
  OVERVIEW_PARSE_RUN_STATUSES,
  type OverviewPage,
  type OverviewSummary,
} from "../../../observation-shared/src/api-contract.ts";
import { safeCode } from "./collection-quality.ts";

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
 * The distinct failure codes of a line's runs, newest first. The Processor
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

/** The summary of one overview page; it reads nothing the page does not. */
export function overviewSummary(page: OverviewPage): OverviewSummary {
  const sources = new Map<number, OverviewSummary["sources"][number]>();
  for (const source of page.sources) {
    const same = sources.get(source.artifact_count);
    if (same) same.sourceIds.push(source.id);
    else
      sources.set(source.artifact_count, {
        sourceIds: [source.id],
        artifacts: source.artifact_count,
      });
  }
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
  return {
    detail: "summary",
    counts: page.counts,
    sources: [...sources.values()],
    fetchRuns: {
      byStatus: groups(fetchRuns, (run) => run.status).map((group) => {
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
      }),
      notSuccessful: groups(
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
    },
    parseRuns: {
      byStatus: groups(parseRuns, (run) => run.status).map((group) => {
        const run = newest(group);
        return {
          status: run.status,
          runs: group.length,
          superseded: group.filter((entry) => entry.superseded_by_parse_run_id !== null).length,
          withWarnings: group.filter((entry) => entry.warnings.list.length > 0).length,
          unreadableWarnings: group.filter((entry) => !entry.warnings.parsed).length,
          parsers: new Set(group.map((entry) => entry.parser_name)).size,
          newest: {
            id: run.id,
            artifactId: run.fetch_artifact_id,
            parser: run.parser_name,
            parsedAt: run.parsed_at,
          },
        };
      }),
      notOk: groups(
        parseRuns.filter((run) => run.status !== "ok"),
        (run) => [run.parser_name, run.status],
      ).map((group) => {
        const run = newest(group);
        return {
          parser: run.parser_name,
          status: run.status,
          runs: group.length,
          superseded: group.filter((entry) => entry.superseded_by_parse_run_id !== null).length,
          failureCodes: failureCodes(group),
          newest: { id: run.id, artifactId: run.fetch_artifact_id, parsedAt: run.parsed_at },
        };
      }),
    },
    ...(page.unitUpdates === undefined
      ? {}
      : {
          unitUpdates: groups(page.unitUpdates, (row) => [row.source_id, row.dataset]).map(
            (group) => {
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
            },
          ),
        }),
    coverage: page.coverage,
  };
}
