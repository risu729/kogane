// The collection quality status view (ADR 0045, amendment 2026-11-19;
// docs/collection.md "Is anything stuck?"): one line per configured job, in
// closed codes, answering "which sources are failing, and is anything stuck?"
// in one small read. It composes what the summary and the cell page already
// read, never the Processor's schedule store:
//
//   jobs          SCHEDULE_QUALITY_SQL (every configured job);
//   receipts      the newest STATUS_OCCURRENCE_WINDOW + 1 receipts per job;
//   recoveries    the newest STATUS_RUN_WINDOW visible fetch runs per source;
//   publication   the source's cells (CELL_QUALITY_SQL, paged, mapped by `cell`).
//
// Read-only; nothing is written, no amount or label is read, and a value the
// read cannot know is null or `"100+"`, never a zero (INV05).
import { coreSourceId } from "../collection/descriptors.ts";
import {
  ACCOUNT_COVERAGE_CELL_BOUND,
  CELL_QUALITY_SQL,
  COLLECTION_QUALITY_ROW_BOUND,
  SCHEDULE_QUALITY_SQL,
  STATUS_OCCURRENCE_WINDOW,
  STATUS_OCCURRENCES_SQL,
  STATUS_RUNS_SQL,
  type CellQualityRow,
  type ScheduleQualityRow,
  type StatusOccurrenceRow,
  type StatusRunRow,
} from "../../../read-model/src/collection-quality.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { collectionFreshness, tokyoDate } from "../../../domain/src/collection-freshness.ts";
import {
  CELL_REASONS,
  COLLECTION_QUALITY_PAGE,
  COLLECTION_STATUS_API_VERSION,
  COLLECTION_STATUS_VIEW,
  FAILURES_BEYOND_WINDOW,
  NOT_PUBLISHING_OMITTED_REASONS,
  STATUS_DEGRADED_AFTER_DAYS,
  type CellReason,
  type CollectionStatus,
  type CollectionStatusNotPublishing,
  type CollectionStatusRow,
  type CollectionStatusRun,
  type CollectionStatusState,
  type OccurrenceStatus,
} from "../../../observation-shared/src/collection-quality-contract.ts";
import {
  cell,
  COLLECTING_KINDS,
  CollectionQualityLimitError,
  safeCode,
  scheduleCollectors,
  userActionRequired,
  VPOINT_SESSION_CODES,
  type CollectionQualityCellStates,
} from "./collection-quality.ts";

/** Receipt statuses that are a failed attempt: it did not complete. */
const FAILED: readonly string[] = ["failed", "uncertain", "not_dispatched"];

/** One fetch run that counts as a successful collection: it succeeded and published something. */
interface Success {
  at: string;
  time: number;
}

/** The CORE sources a job collects: none for a keepalive, the Processor tick or a job without a collector. */
export function jobCoreSources(job: Pick<ScheduleQualityRow, "kind" | "source">): string[] {
  if (!COLLECTING_KINDS.includes(job.kind)) return [];
  const sources = scheduleCollectors(job.source)
    .map((collector) => coreSourceId(collector))
    .filter((source): source is string => source !== null);
  return [...new Set(sources)].sort();
}

/**
 * The earliest successful collection that recovers a failed receipt: a
 * succeeded fetch run of the job's source that published something and
 * completed strictly after the receipt finished (its start when it has no
 * finish) and strictly before the next receipt started. Nominal times decide
 * nothing (ADR 0045's V Point amendment).
 */
export function recoveryOf(
  receipt: Pick<StatusOccurrenceRow, "status" | "started_at" | "finished_at">,
  nextStartedAt: string | null,
  successes: readonly Success[],
): Success | null {
  if (!FAILED.includes(receipt.status)) return null;
  const after = Date.parse(receipt.finished_at ?? receipt.started_at);
  const before = nextStartedAt === null ? Infinity : Date.parse(nextStartedAt);
  if (!Number.isFinite(after) || Number.isNaN(before)) return null;
  let found: Success | null = null;
  for (const success of successes)
    if (
      success.time > after &&
      success.time < before &&
      (found === null || success.time < found.time)
    )
      found = success;
  return found;
}

/** The code whose "a person must act" reading decides `needs-owner`. */
function ownerCode(sources: readonly string[], code: string | null): string | null {
  // An unrecovered V Point session failure is its session-refresh action, as
  // the summary's `currentSessionFailure` reads it.
  if (sources.includes("v-point") && VPOINT_SESSION_CODES.includes(code ?? ""))
    return "human_required_session_refresh";
  return code;
}

/** Tokyo civil days from `at` to `asOfDate`. */
function ageDays(at: string, asOfDate: string): number {
  return collectionFreshness(at, asOfDate, null).ageDays!;
}

/** The newest of some instants, or undefined. */
function newestOf(values: readonly (string | null)[]): string | undefined {
  return values
    .filter((at): at is string => at !== null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

/**
 * The source's datasets with a cell whose newest capture has no published
 * parse, from its cells: per dataset, the units of those cells, the newest
 * capture of the dataset that is parsed (a cell's current capture, or a
 * newest capture with a published parse), its age and those cells' reasons.
 * Only a dataset some parser names (a parse job or a recorded parse of any of
 * its cells) is listed: a capture no parser is meant to read is not a stop.
 * When no capture of a listed dataset was ever published, the age is that of
 * its oldest unpublished newest capture.
 */
function notPublishing(
  cells: readonly CollectionQualityCellStates[],
  asOfDate: string,
): CollectionStatusNotPublishing[] {
  const groups = new Map<string, CollectionQualityCellStates[]>();
  for (const value of cells)
    if (value.dataset !== null)
      groups.set(value.dataset, [...(groups.get(value.dataset) ?? []), value]);
  return [...groups.entries()]
    .filter(
      ([, all]) =>
        all.some((value) => value.parser !== null) &&
        all.some((value) => value.newest.parses.published === 0),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dataset, all]) => {
      const members = all.filter((value) => value.newest.parses.published === 0);
      const parsed = newestOf(
        all.flatMap((value) => [
          value.current?.capturedAt ?? null,
          value.newest.parses.published > 0 ? value.newest.capturedAt : null,
        ]),
      );
      const waiting = members
        .map((member) => member.newest.capturedAt)
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
      const reasons = new Set<CellReason>(members.flatMap((member) => member.reasons));
      return {
        dataset,
        units: new Set(members.map((member) => member.unitKey).filter((key) => key !== null)).size,
        newestParsedCapture: parsed ?? null,
        ageDays: ageDays(parsed ?? waiting, asOfDate),
        reasons: CELL_REASONS.filter(
          (reason) => reasons.has(reason) && !NOT_PUBLISHING_OMITTED_REASONS.includes(reason),
        ),
      };
    });
}

/** Every cell of one CORE source, page by page; more than the account view's bound is refused. */
async function sourceCells(
  executor: SqlExecutor,
  sourceId: string,
): Promise<CollectionQualityCellStates[]> {
  const cells: CollectionQualityCellStates[] = [];
  for (let offset = 0; ; offset += COLLECTION_QUALITY_PAGE) {
    const rows = await executor.all<CellQualityRow>(CELL_QUALITY_SQL, [sourceId, offset]);
    cells.push(...rows.slice(0, COLLECTION_QUALITY_PAGE).map(cell));
    if (cells.length > ACCOUNT_COVERAGE_CELL_BOUND) throw new CollectionQualityLimitError();
    if (rows.length <= COLLECTION_QUALITY_PAGE) return cells;
  }
}

/** One job's line, from its receipts (newest first), its source's successes and cells. */
function statusRow(
  job: Pick<ScheduleQualityRow, "id" | "source" | "kind" | "enabled">,
  receipts: readonly StatusOccurrenceRow[],
  successes: readonly Success[],
  cells: readonly CollectionQualityCellStates[] | null,
  asOfDate: string,
): CollectionStatusRow {
  const sources = jobCoreSources(job);
  const read = receipts.slice(0, STATUS_OCCURRENCE_WINDOW);
  const recovery = (index: number) =>
    recoveryOf(read[index]!, index === 0 ? null : read[index - 1]!.started_at, successes);
  let failures = 0;
  let head: StatusOccurrenceRow | null = null;
  let reachedSuccess = false;
  let lastCompleted: string | null = null;
  for (const [index, receipt] of read.entries()) {
    if (receipt.status === "completed") {
      reachedSuccess = true;
      lastCompleted = receipt.finished_at ?? receipt.started_at;
      break;
    }
    if (!FAILED.includes(receipt.status)) continue;
    if (recovery(index) !== null) {
      reachedSuccess = true;
      break;
    }
    failures += 1;
    head ??= receipt;
  }
  // A completed receipt older than a recovery is still the newest completed one.
  if (lastCompleted === null) {
    const completed = read.find((receipt) => receipt.status === "completed");
    if (completed) lastCompleted = completed.finished_at ?? completed.started_at;
  }
  const beyond = !reachedSuccess && failures > 0 && receipts.length > STATUS_OCCURRENCE_WINDOW;
  const failureCode = head === null ? null : (safeCode(head.failure_code) ?? "unclassified");
  const newest = read[0];
  let lastRun: CollectionStatusRun | null = null;
  if (newest !== undefined) {
    const code = safeCode(newest.failure_code);
    const recovered = recovery(0);
    lastRun = {
      at: newest.started_at,
      status: newest.status as OccurrenceStatus,
      ...(code === null ? {} : { failureCode: code }),
      ...(recovered === null ? {} : { recovered: { at: recovered.at, by: "fetch_run" as const } }),
    };
  }
  const newestSuccess = successes.reduce<Success | null>(
    (found, success) => (found === null || success.time > found.time ? success : found),
    null,
  );
  const lastSuccessAt =
    lastCompleted !== null &&
    (newestSuccess === null || Date.parse(lastCompleted) >= newestSuccess.time)
      ? lastCompleted
      : (newestSuccess?.at ?? null);
  const datasets = job.enabled === 1 && cells !== null ? notPublishing(cells, asOfDate) : [];
  const owner =
    (head !== null && userActionRequired(ownerCode(sources, failureCode))) ||
    datasets.some((entry) => entry.reasons.includes("user_action_required"));
  const state: CollectionStatusState =
    job.enabled !== 1
      ? "disabled"
      : owner
        ? "needs-owner"
        : failures > 0
          ? "failing"
          : datasets.some((entry) => entry.ageDays > STATUS_DEGRADED_AFTER_DAYS)
            ? "degraded"
            : "ok";
  return {
    job: job.id,
    source: job.source,
    enabled: job.enabled === 1,
    lastRun,
    lastSuccessAt,
    failuresSinceSuccess: beyond ? FAILURES_BEYOND_WINDOW : failures,
    failureCode,
    state,
    notPublishing: datasets,
  };
}

/** `GET /api/collection-quality?view=status`, counted to `asOf` (an instant). */
export async function queryCollectionQualityStatus(
  executor: SqlExecutor,
  input: { asOf: string },
): Promise<CollectionStatus> {
  const asOfDate = tokyoDate(input.asOf);
  if (asOfDate === null) throw new Error("invalid_as_of");
  const jobs = await executor.all<ScheduleQualityRow>(SCHEDULE_QUALITY_SQL, []);
  if (jobs.length > COLLECTION_QUALITY_ROW_BOUND) throw new CollectionQualityLimitError();
  const receipts =
    jobs.length === 0
      ? []
      : await executor.all<StatusOccurrenceRow>(STATUS_OCCURRENCES_SQL, [
          JSON.stringify(jobs.map((job) => job.id)),
        ]);
  const sources = [...new Set(jobs.flatMap((job) => jobCoreSources(job)))].sort();
  const runs =
    sources.length === 0
      ? []
      : await executor.all<StatusRunRow>(STATUS_RUNS_SQL, [JSON.stringify(sources)]);
  // The cells of every source an enabled job collects, each source read once.
  const cellSources = [
    ...new Set(jobs.filter((job) => job.enabled === 1).flatMap((job) => jobCoreSources(job))),
  ].sort();
  const cells = new Map<string, CollectionQualityCellStates[]>();
  for (const source of cellSources) cells.set(source, await sourceCells(executor, source));
  return {
    apiVersion: COLLECTION_STATUS_API_VERSION,
    view: COLLECTION_STATUS_VIEW,
    asOf: input.asOf,
    sources: jobs.map((job) => {
      const own = jobCoreSources(job);
      const successes = runs
        .filter((run) => own.includes(run.source_id) && run.succeeded === 1 && run.published === 1)
        .flatMap((run) => {
          const time = Date.parse(run.completed_at ?? "");
          return Number.isFinite(time) ? [{ at: run.completed_at!, time }] : [];
        });
      return statusRow(
        job,
        receipts.filter((receipt) => receipt.schedule_id === job.id),
        successes,
        own.length === 0 ? null : own.flatMap((source) => cells.get(source) ?? []),
        asOfDate,
      );
    }),
  };
}
