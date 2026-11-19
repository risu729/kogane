// The `summary` detail of the collection quality reads (ADR 0123), derived
// from their `full` answers alone, so `GET /api/collection-quality[/<source>]`
// and `kogane.collection-quality.read` (ADR 0081) shape it once. A summary
// collapses lines, never codes: every reason, state and failure code of what
// it collapses is kept, with how many cells it collapsed.
import {
  COLLECTION_QUALITY_LINE_PAGE,
  type CollectionQualityCell,
  type CollectionQualityCellLine,
  type CollectionQualityCells,
  type CollectionQualityCellSummary,
  type CollectionQualitySchedule,
  type CollectionQualitySourceLine,
  type CollectionQualityScheduleLine,
  type CollectionQualitySummary,
  type CollectionQualitySummaryLines,
} from "../../../observation-shared/src/collection-quality-contract.ts";

/** Each distinct code of `codes`, in order of first appearance; a null is no code. */
function distinctCodes(codes: Iterable<string | null>): string[] {
  const out: string[] = [];
  for (const code of codes) if (code !== null && !out.includes(code)) out.push(code);
  return out;
}

function scheduleLine(schedule: CollectionQualitySchedule): CollectionQualityScheduleLine {
  return {
    id: schedule.id,
    enabled: schedule.enabled,
    latest:
      schedule.latest === null
        ? null
        : {
            nominalAt: schedule.latest.nominalAt,
            status: schedule.latest.status,
            failureCode: schedule.latest.failureCode,
            // The receipt's terminals collapse to their closed blocked and
            // failure codes; which stage each stands at is the source's reasons.
            terminalCodes: distinctCodes(
              schedule.latest.terminals.flatMap((terminal) => [
                terminal.blockedCode,
                terminal.failureCode,
              ]),
            ),
          },
  };
}

/**
 * The summary of the collection quality summary: one line per source with its
 * freshness, newest fetch run, reasons, jobs (newest receipt only, with its
 * terminals' closed codes), its unregistered collectors' count and codes and
 * its data type counts, and the jobs under no CORE source. Sources whose lines would
 * be the same apart from their id (such as the sources no collector serves)
 * share one line that names them all, in the summary's order.
 */
export function collectionQualitySummaryLines(
  summary: CollectionQualitySummary,
): CollectionQualitySummaryLines {
  const lines = new Map<string, CollectionQualitySourceLine>();
  for (const source of summary.sources) {
    const line: Omit<CollectionQualitySourceLine, "sourceIds"> = {
      freshness: source.freshness,
      latestFetchRun: source.latestFetchRun,
      reasons: source.reasons,
      schedules: source.schedules.map(scheduleLine),
      unregistered: source.unregistered.length,
      unregisteredCodes: distinctCodes(
        source.unregistered.flatMap((entry) => [entry.blockedCode, entry.failureCode]),
      ),
      dataTypes:
        source.dataTypes === null
          ? null
          : {
              collected: source.dataTypes.filter((entry) => entry.status === "collected").length,
              partial: source.dataTypes.filter((entry) => entry.status === "partial").length,
              notCollected: source.dataTypes.filter((entry) => entry.status === "not_collected")
                .length,
            },
    };
    const key = JSON.stringify(line);
    const same = lines.get(key);
    if (same) same.sourceIds.push(source.sourceId);
    else lines.set(key, { sourceIds: [source.sourceId], ...line });
  }
  return {
    apiVersion: summary.apiVersion,
    detail: "summary",
    freshnessAsOf: summary.freshnessAsOf,
    sources: [...lines.values()],
    otherSchedules: summary.otherSchedules.map(scheduleLine),
  };
}

/**
 * A source's cells as lines, one per dataset, parser and fetch unit in order
 * of first appearance, collapsed over periods. `cells` is the whole source:
 * every page of the cell read, in its order.
 */
function collectionQualityCellLines(
  cells: readonly CollectionQualityCell[],
): CollectionQualityCellLine[] {
  const groups = new Map<string, CollectionQualityCell[]>();
  for (const cell of cells) {
    const key = JSON.stringify([cell.dataset, cell.parser, cell.unitKey]);
    const group = groups.get(key);
    if (group) group.push(cell);
    else groups.set(key, [cell]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const named = group
      .map((cell) => cell.period.value)
      .filter((value): value is string => value !== null)
      .sort();
    let freshest: CollectionQualityCell | null = null;
    for (const cell of group)
      if (
        cell.current !== null &&
        (freshest?.current == null || cell.current.capturedAt > freshest.current.capturedAt)
      )
        freshest = cell;
    const reasons: CollectionQualityCell["reasons"] = [];
    for (const cell of group)
      for (const reason of cell.reasons) if (!reasons.includes(reason)) reasons.push(reason);
    return {
      dataset: first.dataset,
      parser: first.parser,
      unitKey: first.unitKey,
      cells: group.length,
      periods: { first: named[0] ?? null, last: named.at(-1) ?? null },
      current: group.filter((cell) => cell.state === "current").length,
      olderCurrent: group.filter((cell) => cell.state === "older-current").length,
      noCurrent: group.filter((cell) => cell.state === "no-current").length,
      newestCapturedAt: group
        .map((cell) => cell.newest.capturedAt)
        .reduce((newest, at) => (at > newest ? at : newest)),
      freshness: (freshest ?? first).freshness,
      reasons,
      // The closed codes the newest captures carry, kept as the reasons are.
      failureCodes: distinctCodes(
        group.flatMap((cell) => [cell.newest.unitFailureCode, ...cell.newest.failureCodes]),
      ),
      coverageCauses: distinctCodes(group.flatMap((cell) => cell.newest.coverageCauses)),
    };
  });
}

/**
 * One page of a source's summary lines. `pages` are every page of that
 * source's cell read at one instant, in order; `offset` counts lines.
 */
export function collectionQualityCellSummary(
  pages: readonly CollectionQualityCells[],
  offset: number,
): CollectionQualityCellSummary {
  const head = pages[0]!;
  const cells = pages.flatMap((page) => page.cells);
  const lines = collectionQualityCellLines(cells);
  const end = offset + COLLECTION_QUALITY_LINE_PAGE;
  return {
    apiVersion: head.apiVersion,
    detail: "summary",
    freshnessAsOf: head.freshnessAsOf,
    sourceId: head.sourceId,
    latestFetchRun: head.latestFetchRun,
    lines: lines.slice(offset, end),
    coverage: {
      cells: cells.length,
      lines: lines.length,
      limit: COLLECTION_QUALITY_LINE_PAGE,
      truncated: end < lines.length,
      nextOffset: end < lines.length ? end : null,
    },
  };
}
