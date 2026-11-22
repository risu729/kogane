// The `summary` detail of the collection quality reads (ADR 0123 and its
// amendment of 2026-11-20), derived from their `full` answers alone, so
// `GET /api/collection-quality[/<source>[/accounts]]` and
// `kogane.collection-quality.read` (ADR 0081) shape it once. A summary
// collapses lines, never codes: every reason, state and failure code of what
// it collapses is kept, with how many cells it collapsed.
import {
  ACCOUNT_SUMMARY_BYTES,
  ACCOUNT_SUMMARY_LINE_PAGE,
  type AccountCoverage,
  type AccountCoverageAccount,
  type AccountCoverageAccountLine,
  type AccountCoverageSummary,
  type AccountCoverageUnattributedLine,
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
  OBSERVATION_KINDS,
  pageReadAnswerBytes,
  PROVIDER_DATA_TYPES,
} from "../../../observation-shared/src/collection-quality-contract.ts";
import { CollectionQualityLimitError } from "./collection-quality.ts";

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
            // failure codes; which stage each stands at is the source's
            // reasons. A job under no CORE source (`otherSchedules`) has no
            // source line: its terminals' stages are in `full` only.
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

/** The smallest and largest named period value of `values`; both null when none is named. */
function periodSpan(values: readonly (string | null)[]): {
  first: string | null;
  last: string | null;
} {
  const named = values.filter((value): value is string => value !== null).sort();
  return { first: named[0] ?? null, last: named.at(-1) ?? null };
}

/** An account of the account view, collapsed over its data types and periods. */
function accountLine(account: AccountCoverageAccount): AccountCoverageAccountLine {
  const periods = account.dataTypes.flatMap((type) => type.periods);
  let newest = periods[0]!.capture.capturedAt;
  for (const entry of periods)
    if (Date.parse(entry.capture.capturedAt) > Date.parse(newest))
      newest = entry.capture.capturedAt;
  const reasons: AccountCoverageAccountLine["reasons"] = [];
  for (const entry of periods)
    for (const reason of entry.reasons) if (!reasons.includes(reason)) reasons.push(reason);
  const standing = (value: string) => periods.filter((entry) => entry.standing === value).length;
  const state = (value: string) => periods.filter((entry) => entry.cellState === value).length;
  return {
    accountId: account.accountId,
    label: account.label,
    statuses: account.statuses,
    freshness: account.freshness,
    kinds: OBSERVATION_KINDS.filter((kind) => account.dataTypes.some((type) => type.kind === kind)),
    dataTypes: account.dataTypes.length,
    providerTypes: PROVIDER_DATA_TYPES.filter((type) =>
      account.dataTypes.some((entry) => entry.providerTypes.includes(type)),
    ),
    periods: {
      count: periods.length,
      ...periodSpan(periods.map((entry) => entry.period.value)),
    },
    standings: {
      current: standing("current"),
      olderCurrent: standing("older-current"),
      newestNotCurrent: standing("newest-not-current"),
    },
    cellStates: {
      current: state("current"),
      olderCurrent: state("older-current"),
      noCurrent: state("no-current"),
    },
    newestCapturedAt: newest,
    reasons,
  };
}

/** The unattributed cells as lines, one per dataset, parser and fetch unit in order of first appearance. */
function unattributedLines(
  cells: AccountCoverage["unattributed"],
): AccountCoverageUnattributedLine[] {
  const groups = new Map<string, AccountCoverage["unattributed"]>();
  for (const cell of cells) {
    const key = JSON.stringify([cell.dataset, cell.parser, cell.unitKey]);
    const group = groups.get(key);
    if (group) group.push(cell);
    else groups.set(key, [cell]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const reasons: AccountCoverageUnattributedLine["reasons"] = [];
    for (const cell of group)
      for (const reason of cell.reasons) if (!reasons.includes(reason)) reasons.push(reason);
    return {
      dataset: first.dataset,
      parser: first.parser,
      unitKey: first.unitKey,
      cells: group.length,
      periods: periodSpan(group.map((cell) => cell.period.value)),
      current: group.filter((cell) => cell.state === "current").length,
      olderCurrent: group.filter((cell) => cell.state === "older-current").length,
      noCurrent: group.filter((cell) => cell.state === "no-current").length,
      reasons,
    };
  });
}

/**
 * One page of the account view's summary (ADR 0123, amendment 2026-11-20):
 * the full answer's accounts, one line each, then its unattributed cells,
 * one line per dataset, parser and fetch unit; `offset` counts lines. A page
 * holds up to `ACCOUNT_SUMMARY_LINE_PAGE` lines, and fewer when the next
 * would carry the tool's answer past `ACCOUNT_SUMMARY_BYTES`; `nextOffset`
 * is where the next page starts. A page that cannot hold its first line
 * within the bytes (texts near the schema's 512 characters) is refused
 * (`CollectionQualityLimitError`, `413`), never cut.
 */
export function accountCoverageSummary(
  full: AccountCoverage,
  offset: number,
): AccountCoverageSummary {
  const accounts = full.accounts.map(accountLine);
  const apart = unattributedLines(full.unattributed);
  const total = accounts.length + apart.length;
  const page = (end: number): AccountCoverageSummary => ({
    apiVersion: full.apiVersion,
    detail: "summary",
    freshnessAsOf: full.freshnessAsOf,
    dataTypesVersion: full.dataTypesVersion,
    dataTypes:
      full.dataTypes === null
        ? null
        : {
            collected: full.dataTypes
              .filter((entry) => entry.status === "collected")
              .map((entry) => entry.type),
            partial: full.dataTypes
              .filter((entry) => entry.status === "partial")
              .map((entry) => entry.type),
            notCollected: full.dataTypes
              .filter((entry) => entry.status === "not_collected")
              .map((entry) => entry.type),
          },
    sourceId: full.sourceId,
    latestFetchRun: full.latestFetchRun,
    cells: full.cells,
    accounts: accounts.slice(Math.min(offset, accounts.length), Math.min(end, accounts.length)),
    unattributed: apart.slice(
      Math.max(offset - accounts.length, 0),
      Math.max(end - accounts.length, 0),
    ),
    coverage: {
      accounts: accounts.length,
      unattributedCells: full.unattributed.length,
      lines: total,
      limit: ACCOUNT_SUMMARY_LINE_PAGE,
      offset,
      truncated: end < total,
      nextOffset: end < total ? end : null,
    },
  });
  // Lines in order until the page holds its limit or the next would pass the bytes.
  let answer = page(offset);
  for (let end = offset + 1; end <= Math.min(offset + ACCOUNT_SUMMARY_LINE_PAGE, total); end++) {
    const next = page(end);
    if (pageReadAnswerBytes(next) > ACCOUNT_SUMMARY_BYTES) break;
    answer = next;
  }
  // A page that cannot hold one line (or, past the last line, its header) is refused.
  const listed = answer.accounts.length + answer.unattributed.length;
  if ((listed === 0 && offset < total) || pageReadAnswerBytes(answer) > ACCOUNT_SUMMARY_BYTES)
    throw new CollectionQualityLimitError();
  return answer;
}
