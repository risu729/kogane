// Collection quality (ADR 0045, docs/read-model.md "Collection quality"): per
// configured job, per CORE source, and per source × fetch unit × dataset ×
// period, what each collection stage last did and why a stage is not done,
// in closed codes. One bounded read path; it never writes, never adds two
// amounts, and never turns a missing stage into a zero or a success (INV05).
//
// What is enumerated comes from configuration and stored state, never from a
// count written into the code: the jobs are the rows of `collection_schedules`,
// the sources the visible CORE sources, the collectors of a source the
// `COLLECTOR_SOURCE_IDS` entries that register under it.
import { COLLECTOR_SOURCE_IDS, WITHHELD_ARTIFACT_DATASETS } from "../collection/descriptors.ts";
import {
  PROVIDER_DATA_TYPES_VERSION,
  providerDataTypes,
} from "../collection/provider-data-types.ts";
import {
  ACCOUNT_COVERAGE_SQL,
  CELL_QUALITY_SQL,
  COLLECTION_QUALITY_ROW_BOUND,
  ONE_SOURCE_QUALITY_SQL,
  SCHEDULE_QUALITY_SQL,
  SOURCE_JOBS_SQL,
  SOURCE_QUALITY_SQL,
  TERMINAL_QUALITY_SQL,
  UNCOMPOSED_QUERY_RULE_PARSERS,
  UNREGISTERED_QUALITY_SQL,
  type AccountCoverageRow,
  type CellQualityRow,
  type ScheduleQualityRow,
  type SourceJobRow,
  type SourceQualityRow,
  type TerminalQualityRow,
  type UnregisteredQualityRow,
} from "../../../read-model/src/collection-quality.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import {
  COLLECTION_FRESHNESS_POLICY,
  collectionFreshness,
  tokyoDate,
  type CollectionFreshness,
  type CollectionWait,
} from "../../../domain/src/collection-freshness.ts";
import {
  ACCOUNT_COVERAGE_API_VERSION,
  ACCOUNT_COVERAGE_CELL_BOUND,
  ACCOUNT_COVERAGE_ENTRY_BOUND,
  CELL_REASONS,
  COLLECTION_QUALITY_API_VERSION,
  MAPPING_STATUSES,
  OBSERVATION_KINDS,
  type AccountCoverage,
  type AccountCoverageAccount,
  type AccountCoveragePeriod,
  type AccountStanding,
  type MappingStatus,
  type ObservationKind,
  COLLECTION_QUALITY_PAGE,
  SOURCE_REASONS,
  type CellReason,
  type CellState,
  type CollectionQualityCell,
  type CollectionQualityCells,
  type CollectionQualityFetchRun,
  type CollectionQualityOccurrence,
  type CollectionQualityPeriod,
  type CollectionQualitySchedule,
  type CollectionQualitySource,
  type CollectionQualitySummary,
  type CollectionQualityTerminal,
  type CoverageStatus,
  type CurrentRule,
  type OccurrenceStatus,
  type PeriodKind,
  type ProviderOutcome,
  type ScheduleKind,
  type SourceReason,
} from "../../../observation-shared/src/collection-quality-contract.ts";

/** More jobs or sources than the bound is refused (413), never cut. */
export class CollectionQualityLimitError extends Error {
  constructor() {
    super("collection_quality_limit_exceeded");
  }
}

/**
 * A job's source (the alarm and lease vocabulary of `config/alarm-jobs.json`)
 * → the collector sources its runs name in their terminals, where the two
 * differ. The V Point collector leases and is scheduled as `vpoint` but names
 * its terminal `v-point` (services/collector-vpoint/src/shared-run.ts); the V
 * Point Pay job is the app collector, `v-point-pay`. Every other job's source
 * is a collector source as it stands. `test/collection-quality-query.test.ts`
 * checks every configured job against this and `COLLECTOR_SOURCE_IDS`.
 */
export const SCHEDULE_COLLECTOR_SOURCES: Readonly<Record<string, readonly string[]>> = {
  vpoint: ["v-point"],
  "vpoint-pay": ["v-point-pay"],
};

/** The collector sources a job's runs register under; none for a job without a source. */
export function scheduleCollectors(source: string | null): readonly string[] {
  if (source === null) return [];
  if (Object.hasOwn(SCHEDULE_COLLECTOR_SOURCES, source)) return SCHEDULE_COLLECTOR_SOURCES[source]!;
  return Object.hasOwn(COLLECTOR_SOURCE_IDS, source) ? [source] : [];
}

/** The collector sources that register under a CORE source, in a stable order. */
export function sourceCollectors(sourceId: string): string[] {
  return Object.entries(COLLECTOR_SOURCE_IDS)
    .filter(([, core]) => core === sourceId)
    .map(([collector]) => collector)
    .sort();
}

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * A stored failure code as the contract carries it. Codes are written as safe
 * codes; anything else (an older free-text error) is never passed through and
 * reads `unclassified`. Collector terminals spell their unit and run codes
 * with hyphens (`collection-unit-failed`, the manifest's own grammar), so a
 * hyphen reads as `_`: the code keeps its meaning instead of becoming
 * `unclassified`.
 */
export function safeCode(value: string | null): string | null {
  if (value === null) return null;
  const code = value.replaceAll("-", "_");
  return SAFE_CODE.test(code) ? code : "unclassified";
}

/**
 * A collector's own "a person must act" codes: `HUMAN_REQUIRED_CODE`, MyJCB's
 * `human_required`, and SBI VC's `manual_agreement_required` (the provider's
 * terms wait for the owner's agreement; owner, 2026-11-07 06:28 UTC).
 */
const userActionRequired = (code: string | null): boolean =>
  code !== null && (code.startsWith("human_required") || code === "manual_agreement_required");

/** The kinds of job that collect a source's data (a keepalive or the Processor tick does not). */
const COLLECTING_KINDS: readonly string[] = ["collection", "manual", "email"];

/**
 * What a source waits on, from its jobs' stored settings and newest receipts
 * (`collection-freshness-v1`): `human-required` when a job collects only by
 * hand or its newest attempt stopped on a "a person must act" code;
 * `disabled` when it has supported collecting jobs and none is enabled; else
 * nothing. An unsupported job can never be enabled (CORE 0065), so it says
 * nothing about whether collection was switched off: V Point Pay's app job is
 * unsupported while its e-mail path, which has no job, still delivers.
 */
export function sourceWait(
  jobs: readonly {
    kind: string;
    enabled: boolean;
    supported: boolean;
    failureCode: string | null;
  }[],
): CollectionWait {
  if (jobs.some((job) => job.kind === "manual" || userActionRequired(job.failureCode)))
    return "human-required";
  const collecting = jobs.filter((job) => job.supported && COLLECTING_KINDS.includes(job.kind));
  if (collecting.length > 0 && collecting.every((job) => !job.enabled)) return "disabled";
  return null;
}

/** The instant and civil date every age of one answer is counted to. */
export interface FreshnessAsOf {
  policy: typeof COLLECTION_FRESHNESS_POLICY;
  at: string;
  date: string;
}

export function freshnessAsOf(at: string): FreshnessAsOf {
  const date = tokyoDate(at);
  if (date === null) throw new Error("invalid_as_of");
  return { policy: COLLECTION_FRESHNESS_POLICY, at, date };
}

function ordered<T extends string>(reasons: Set<T>, order: readonly T[]): T[] {
  return order.filter((reason) => reasons.has(reason));
}

function jsonCodes(value: string | null): string[] {
  if (value === null) return [];
  const parsed = JSON.parse(value) as unknown[];
  const codes = parsed.filter((entry): entry is string => typeof entry === "string");
  return [...new Set(codes.map((code) => safeCode(code)!))].sort();
}

function fetchRun(row: SourceQualityRow): CollectionQualityFetchRun | null {
  if (row.fetch_run_id === null) return null;
  return { id: row.fetch_run_id, succeeded: row.succeeded === 1, completedAt: row.completed_at };
}

function runIds(row: ScheduleQualityRow): string[] {
  if (row.occurrence_run_ids === null) return [];
  const parsed = JSON.parse(row.occurrence_run_ids) as unknown;
  return Array.isArray(parsed)
    ? [...new Set(parsed.filter((entry): entry is string => typeof entry === "string"))]
    : [];
}

/** The row that decides where one run stands: a registered row first, then the newest. */
function decisiveRow(rows: readonly TerminalQualityRow[]): TerminalQualityRow | undefined {
  const newestFirst = [...rows].sort((a, b) => b.id - a.id);
  return newestFirst.find((row) => row.registered_at !== null) ?? newestFirst[0];
}

function terminal(
  collector: string,
  row: TerminalQualityRow | undefined,
): CollectionQualityTerminal {
  if (row === undefined)
    return {
      collector,
      outcome: null,
      coverage: null,
      registration: "unrecorded",
      blockedCode: null,
      fetchRunId: null,
    };
  const stageCode = safeCode(row.registered_stage_failure_code);
  const registered = row.registered_at !== null;
  const blocked =
    !registered && (row.blocked_code !== null || row.registered_stage_state === "blocked");
  return {
    collector,
    outcome: row.provider_outcome as ProviderOutcome | null,
    coverage: row.coverage_status as CoverageStatus | null,
    registration: registered ? "registered" : blocked ? "blocked" : "pending",
    blockedCode: registered ? null : (safeCode(row.blocked_code) ?? stageCode),
    fetchRunId: registered ? row.visible_fetch_run_id : null,
  };
}

function schedule(
  row: ScheduleQualityRow,
  terminals: ReadonlyMap<string, TerminalQualityRow[]>,
): CollectionQualitySchedule {
  const collectors = scheduleCollectors(row.source);
  let latest: CollectionQualityOccurrence | null = null;
  if (
    row.occurrence_status !== null &&
    row.occurrence_nominal_at !== null &&
    row.occurrence_started_at !== null
  ) {
    latest = {
      status: row.occurrence_status as OccurrenceStatus,
      failureCode: safeCode(row.occurrence_failure_code),
      nominalAt: row.occurrence_nominal_at,
      startedAt: row.occurrence_started_at,
      finishedAt: row.occurrence_finished_at,
      terminals: runIds(row).map((runId) => {
        // The run belongs to whichever of the job's collectors recorded it.
        for (const collector of collectors) {
          const rows = terminals.get(JSON.stringify([collector, runId]));
          if (rows !== undefined) return terminal(collector, decisiveRow(rows));
        }
        return terminal(collectors[0] ?? row.source ?? "unknown", undefined);
      }),
    };
  }
  return {
    id: row.id,
    kind: row.kind as ScheduleKind,
    enabled: row.enabled === 1,
    supported: row.supported === 1,
    nextNominalAt: row.next_nominal_at,
    nextRunAt: row.next_run_at,
    alarm: { status: "unavailable", actualAt: null },
    leaseStartedAt: row.lease_started_at,
    latest,
  };
}

function sourceReasons(
  source: Omit<CollectionQualitySource, "reasons" | "freshness" | "dataTypes">,
): SourceReason[] {
  const reasons = new Set<SourceReason>();
  if (source.collectors.length === 0) reasons.add("no_collector");
  else if (source.schedules.length === 0) reasons.add("no_schedule");
  for (const job of source.schedules) {
    if (!job.supported) reasons.add("schedule_unsupported");
    else if (!job.enabled) reasons.add("schedule_disabled");
    else if (job.latest === null) reasons.add("schedule_never_ran");
    if (job.leaseStartedAt !== null) reasons.add("lease_held");
    const latest = job.latest;
    if (latest === null) continue;
    if (latest.status === "started") reasons.add("occurrence_running");
    if (latest.status === "failed") reasons.add("occurrence_failed");
    if (latest.status === "uncertain") reasons.add("occurrence_uncertain");
    if (latest.status === "not_dispatched") reasons.add("occurrence_not_dispatched");
    if (userActionRequired(latest.failureCode)) reasons.add("user_action_required");
    for (const run of latest.terminals) {
      if (run.registration === "unrecorded") reasons.add("terminal_unrecorded");
      if (run.registration === "pending") reasons.add("terminal_registration_pending");
      if (run.registration === "blocked") reasons.add("terminal_registration_blocked");
      if (run.outcome === "partial") reasons.add("acquisition_partial");
      if (run.outcome === "failed") reasons.add("acquisition_failed");
      if (run.coverage === "partial") reasons.add("coverage_partial");
      if (run.coverage === "unknown") reasons.add("coverage_unknown");
    }
  }
  if (source.unregistered.length > 0) reasons.add("unregistered_terminals");
  if (source.latestFetchRun === null) reasons.add("no_registered_run");
  else if (!source.latestFetchRun.succeeded) reasons.add("latest_run_not_successful");
  if (source.collectors.some((collector) => Object.hasOwn(WITHHELD_ARTIFACT_DATASETS, collector)))
    reasons.add("dataset_withheld");
  return ordered(reasons, SOURCE_REASONS);
}

/**
 * `GET /api/collection-quality`: every configured job and every visible
 * source, each source's freshness counted to `asOf` (an instant).
 */
export async function queryCollectionQualitySummary(
  executor: SqlExecutor,
  input: { asOf: string },
): Promise<CollectionQualitySummary> {
  const asOf = freshnessAsOf(input.asOf);
  const jobs = await executor.all<ScheduleQualityRow>(SCHEDULE_QUALITY_SQL, []);
  const sources = await executor.all<SourceQualityRow>(SOURCE_QUALITY_SQL, []);
  if (jobs.length > COLLECTION_QUALITY_ROW_BOUND || sources.length > COLLECTION_QUALITY_ROW_BOUND)
    throw new CollectionQualityLimitError();
  // Exactly the runs each newest receipt names, under each collector of its job.
  const pairs = jobs.flatMap((job) =>
    runIds(job).flatMap((runId) =>
      scheduleCollectors(job.source).map((collector) => [collector, runId]),
    ),
  );
  const terminalRows =
    pairs.length === 0
      ? []
      : await executor.all<TerminalQualityRow>(TERMINAL_QUALITY_SQL, [JSON.stringify(pairs)]);
  const terminals = new Map<string, TerminalQualityRow[]>();
  for (const row of terminalRows) {
    const key = JSON.stringify([row.source, row.run_id]);
    terminals.set(key, [...(terminals.get(key) ?? []), row]);
  }
  const visible = new Set(sources.map((row) => row.source_id));
  const collectors = Object.keys(COLLECTOR_SOURCE_IDS)
    .filter((collector) => visible.has(COLLECTOR_SOURCE_IDS[collector]!))
    .sort();
  const unregisteredRows =
    collectors.length === 0
      ? []
      : await executor.all<UnregisteredQualityRow>(UNREGISTERED_QUALITY_SQL, [
          JSON.stringify(collectors),
        ]);
  const schedules = jobs.map((job) => schedule(job, terminals));
  const placed = new Set<string>();
  const summaries = sources.map((row): CollectionQualitySource => {
    const own = sourceCollectors(row.source_id);
    const jobsOfSource = schedules.filter((job, index) =>
      scheduleCollectors(jobs[index]!.source).some((collector) => own.includes(collector)),
    );
    for (const job of jobsOfSource) placed.add(job.id);
    const entry = {
      sourceId: row.source_id,
      collectors: own,
      schedules: jobsOfSource,
      latestFetchRun: fetchRun(row),
      unregistered: unregisteredRows
        .filter((unregistered) => own.includes(unregistered.source))
        .map((unregistered) => ({
          collector: unregistered.source,
          blockedCode: safeCode(unregistered.blocked_code),
          runs: unregistered.runs,
          newestSeenAt: unregistered.newest_seen_at,
        })),
    };
    const wait = sourceWait(
      jobsOfSource.map((job) => ({
        kind: job.kind,
        enabled: job.enabled,
        supported: job.supported,
        failureCode: job.latest?.failureCode ?? null,
      })),
    );
    return {
      ...entry,
      reasons: sourceReasons(entry),
      freshness: collectionFreshness(entry.latestFetchRun?.completedAt ?? null, asOf.date, wait),
      dataTypes: providerDataTypes(row.source_id),
    };
  });
  return {
    apiVersion: COLLECTION_QUALITY_API_VERSION,
    freshnessAsOf: asOf,
    dataTypesVersion: PROVIDER_DATA_TYPES_VERSION,
    sources: summaries,
    otherSchedules: schedules.filter((job) => !placed.has(job.id)),
  };
}

function period(row: CellQualityRow): CollectionQualityPeriod {
  const kind = row.period_kind as PeriodKind;
  if (kind === "latest") return { kind, value: null, state: null };
  return {
    kind,
    value: row.period || null,
    state: kind === "statement-slot" ? row.period_state : null,
  };
}

const UNCOMPOSED: readonly string[] = UNCOMPOSED_QUERY_RULE_PARSERS;

/** A cell as its stored states give it, before its freshness is counted to an instant. */
export type CollectionQualityCellStates = Omit<CollectionQualityCell, "freshness">;

/** One cell as the contract carries it, with the reasons its stored states give. */
export function cell(row: CellQualityRow): CollectionQualityCellStates {
  const failureCodes = jsonCodes(row.failure_codes_json);
  const coverageCauses = jsonCodes(row.coverage_causes_json);
  const unitFailureCode = row.unit_failed === 1 ? safeCode(row.unit_failure_code) : null;
  const current =
    row.current_run_id === null || row.current_captured_at === null
      ? null
      : { fetchRunId: row.current_run_id, capturedAt: row.current_captured_at };
  const state: CellState =
    current === null
      ? "no-current"
      : current.fetchRunId === row.newest_run_id
        ? "current"
        : "older-current";
  const named = period(row);
  const reasons = new Set<CellReason>();
  if (row.artifacts === 0) reasons.add("unit_without_artifacts");
  if (row.unit_outcome_unknown === 1) reasons.add("unit_outcome_unknown");
  if ((row.unresolved_identities ?? 0) > 0) reasons.add("identity_unresolved");
  if (row.published > 0 && (row.identity_missing ?? 0) > 0) reasons.add("identity_not_recorded");
  if (row.published > 0 && row.observations === 0) reasons.add("published_without_observations");
  reasons.add("retention_not_assessed");
  if (row.newest_run_succeeded !== 1) reasons.add("run_not_successful");
  if (row.unit_failed === 1) reasons.add("unit_failed");
  if (userActionRequired(unitFailureCode)) reasons.add("user_action_required");
  if (row.raw_stored < row.artifacts) reasons.add("raw_not_reachable");
  if (row.not_queued > 0) reasons.add("parse_not_queued");
  if (row.not_eligible > 0) reasons.add("not_parse_eligible");
  if (row.pending > 0) reasons.add("parse_pending");
  if (row.failed > 0) {
    if (failureCodes.includes("parser_rejected")) reasons.add("parser_rejected");
    if (failureCodes.length === 0 || failureCodes.some((code) => code !== "parser_rejected"))
      reasons.add("parse_failed");
  }
  if (row.unpublished > 0) reasons.add("parse_unpublished");
  if ((row.incomplete_coverage ?? 0) > 0) reasons.add("coverage_incomplete");
  if (row.unreported_coverage > 0) reasons.add("coverage_not_recorded");
  if (state === "older-current") reasons.add("newer_capture_not_current");
  if (state === "no-current") reasons.add("no_current_capture");
  if (named.kind !== "latest" && named.value === null) reasons.add("period_unplaced");
  if (row.parser_name !== null && UNCOMPOSED.includes(row.parser_name))
    reasons.add("query_rule_not_composed");
  if (row.latest_producer_run_id !== row.newest_run_id) reasons.add("not_in_latest_run");
  return {
    dataset: row.dataset,
    parser: row.parser_name,
    unitKey: row.fetch_unit_key,
    period: named,
    currentRule: row.current_rule as CurrentRule,
    newest: {
      fetchRunId: row.newest_run_id,
      capturedAt: row.newest_captured_at,
      runSucceeded: row.newest_run_succeeded === 1,
      unitFailed: row.unit_failed === 1,
      unitFailureCode,
      artifacts: row.artifacts,
      observations: row.observations ?? 0,
      unresolvedIdentities: row.unresolved_identities ?? 0,
      rawStored: row.raw_stored,
      parses: {
        published: row.published,
        pending: row.pending,
        failed: row.failed,
        unpublished: row.unpublished,
        notQueued: row.not_queued,
        notEligible: row.not_eligible,
      },
      failureCodes,
      incompleteCoverage: row.incomplete_coverage ?? 0,
      coverageCauses,
    },
    current,
    state,
    reasons: ordered(reasons, CELL_REASONS),
  };
}

/**
 * A cell's freshness: the age of its current capture, explained by what the
 * source waits on, or by the cell's own "a person must act" unit code.
 */
export function cellFreshness(
  value: CollectionQualityCellStates,
  asOfDate: string,
  wait: CollectionWait,
): CollectionQualityCell["freshness"] {
  const own = value.reasons.includes("user_action_required") ? "human-required" : wait;
  return collectionFreshness(value.current?.capturedAt ?? null, asOfDate, own);
}

/** The job sources whose runs register under a CORE source: its collectors and their aliases. */
export function sourceJobSources(sourceId: string): string[] {
  const own = sourceCollectors(sourceId);
  const aliases = Object.entries(SCHEDULE_COLLECTOR_SOURCES)
    .filter(([, collectors]) => collectors.some((collector) => own.includes(collector)))
    .map(([job]) => job);
  return [...new Set([...own, ...aliases])].sort();
}

/** What the jobs of one CORE source wait on, from its stored jobs only (the cells route's read). */
export async function waitOfSource(
  executor: SqlExecutor,
  sourceId: string,
): Promise<CollectionWait> {
  const jobs = await executor.all<SourceJobRow>(SOURCE_JOBS_SQL, [
    JSON.stringify(sourceJobSources(sourceId)),
  ]);
  return sourceWait(
    jobs.map((job) => ({
      kind: job.kind,
      enabled: job.enabled === 1,
      supported: job.supported === 1,
      failureCode: safeCode(job.occurrence_failure_code),
    })),
  );
}

export interface CollectionQualityCellsInput {
  /** A CORE source id. */
  sourceId: string;
  /** Cells to skip, a multiple of the page in practice. */
  offset: number;
  /** The instant ages are counted to. */
  asOf: string;
}

/**
 * `GET /api/collection-quality/<sourceId>`: one page of the source's cells, or
 * null when the source is not a visible CORE source.
 */
export async function queryCollectionQualityCells(
  executor: SqlExecutor,
  input: CollectionQualityCellsInput,
): Promise<CollectionQualityCells | null> {
  const source = await executor.first<SourceQualityRow>(ONE_SOURCE_QUALITY_SQL, [input.sourceId]);
  if (source === null) return null;
  const asOf = freshnessAsOf(input.asOf);
  const wait = await waitOfSource(executor, source.source_id);
  const rows = await executor.all<CellQualityRow>(CELL_QUALITY_SQL, [input.sourceId, input.offset]);
  const truncated = rows.length > COLLECTION_QUALITY_PAGE;
  return {
    apiVersion: COLLECTION_QUALITY_API_VERSION,
    freshnessAsOf: asOf,
    sourceId: source.source_id,
    latestFetchRun: fetchRun(source),
    cells: rows.slice(0, COLLECTION_QUALITY_PAGE).map((row) => {
      const value = cell(row);
      return { ...value, freshness: cellFreshness(value, asOf.date, wait) };
    }),
    coverage: {
      limit: COLLECTION_QUALITY_PAGE,
      truncated,
      nextOffset: truncated ? input.offset + COLLECTION_QUALITY_PAGE : null,
    },
  };
}

// ── accounts (ADR 0088) ───────────────────────────────────────────────────

/** One `accounts_json` entry: `[capture, account id, label, mapping status, kind, observations]`. */
type NamedAccount = [
  capture: "newest" | "current",
  accountId: string,
  label: string,
  status: MappingStatus,
  kind: ObservationKind,
  observations: number,
];

interface AccountBucket {
  label: string;
  statuses: Set<MappingStatus>;
  /** `JSON.stringify([dataset, parser, kind])` → its periods, in cell order. */
  types: Map<string, AccountCoveragePeriod[]>;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A group uses its newest named capture's freshness, independently of standing.
 * Equal capture instants retain the response's stable group/period order.
 */
function newestCaptureFreshness(periods: readonly AccountCoveragePeriod[]): CollectionFreshness {
  let freshest = periods[0]!;
  for (const entry of periods)
    if (Date.parse(entry.capture.capturedAt) > Date.parse(freshest.capture.capturedAt))
      freshest = entry;
  return { ...freshest.freshness };
}

export interface AccountCoverageInput {
  /** A CORE source id. */
  sourceId: string;
  /** The instant ages are counted to. */
  asOf: string;
}

/**
 * `GET /api/collection-quality/<sourceId>/accounts`: every cell of the source,
 * regrouped by the accounts its captures' observations name, then by data
 * type (dataset, parser, observation kind) and period; the cells whose
 * captures' observations name no account are listed apart with their
 * reasons. Null when the source is not a visible CORE source. More cells than
 * `ACCOUNT_COVERAGE_CELL_BOUND`, or more account period entries than
 * `ACCOUNT_COVERAGE_ENTRY_BOUND`, is refused whole
 * (`CollectionQualityLimitError`), never cut.
 *
 * Each entry carries the cell's own state and reasons (`cell` above), so the
 * two views of one store cannot disagree. Nothing is inferred: a unit key is
 * never read as an account, a period no cell has is not listed (and is
 * neither claimed missing nor covered), and an account whose mapping is not
 * `identified` keeps that status.
 *
 * Freshness (`collection-freshness-v1`, ADR 0088's amendment of 2026-11-08):
 * every period uses the capture it names, even when it is not current. A
 * data type and account use their newest named capture's freshness.
 */
export async function queryAccountCoverage(
  executor: SqlExecutor,
  input: AccountCoverageInput,
): Promise<AccountCoverage | null> {
  const source = await executor.first<SourceQualityRow>(ONE_SOURCE_QUALITY_SQL, [input.sourceId]);
  if (source === null) return null;
  const asOf = freshnessAsOf(input.asOf);
  const wait = await waitOfSource(executor, source.source_id);
  const providerTypes = providerDataTypes(source.source_id);
  const rows = await executor.all<AccountCoverageRow>(ACCOUNT_COVERAGE_SQL, [input.sourceId]);
  if (rows.length > ACCOUNT_COVERAGE_CELL_BOUND) throw new CollectionQualityLimitError();
  const accounts = new Map<string, AccountBucket>();
  const unattributed: AccountCoverage["unattributed"] = [];
  let entries = 0;
  for (const row of rows) {
    const value = cell(row);
    // Observations per (account, kind) and capture; mapping statuses per account.
    const counts = new Map<string, { current: number; newest: number }>();
    for (const [capture, accountId, label, status, kind, observations] of JSON.parse(
      row.accounts_json,
    ) as NamedAccount[]) {
      let bucket = accounts.get(accountId);
      if (bucket === undefined) {
        bucket = { label, statuses: new Set(), types: new Map() };
        accounts.set(accountId, bucket);
      }
      bucket.statuses.add(status);
      const key = JSON.stringify([accountId, kind]);
      const seen = counts.get(key) ?? { current: 0, newest: 0 };
      seen[capture] += observations;
      counts.set(key, seen);
    }
    if (counts.size === 0) {
      unattributed.push({
        dataset: value.dataset,
        parser: value.parser,
        unitKey: value.unitKey,
        period: value.period,
        currentRule: value.currentRule,
        state: value.state,
        reasons: value.reasons,
      });
      continue;
    }
    for (const [key, seen] of counts) {
      const [accountId, kind] = JSON.parse(key) as [string, ObservationKind];
      // The current capture names the account when it can; else only the newest does.
      const inCurrent = seen.current > 0 && value.current !== null;
      const standing: AccountStanding = !inCurrent
        ? "newest-not-current"
        : value.state === "current"
          ? "current"
          : "older-current";
      const bucket = accounts.get(accountId)!;
      // Only a cell with a parser has observations, so its parser is named.
      const type = JSON.stringify([value.dataset, value.parser, kind]);
      const periods = bucket.types.get(type) ?? [];
      bucket.types.set(type, periods);
      const capture = inCurrent
        ? value.current!
        : { fetchRunId: value.newest.fetchRunId, capturedAt: value.newest.capturedAt };
      periods.push({
        unitKey: value.unitKey,
        period: value.period,
        currentRule: value.currentRule,
        cellState: value.state,
        standing,
        capture,
        observations: inCurrent ? seen.current : seen.newest,
        reasons: value.reasons,
        freshness: collectionFreshness(
          capture.capturedAt,
          asOf.date,
          value.reasons.includes("user_action_required") ? "human-required" : wait,
        ),
      });
      entries += 1;
    }
  }
  if (entries > ACCOUNT_COVERAGE_ENTRY_BOUND) throw new CollectionQualityLimitError();
  const kindOrder = (kind: ObservationKind): number => OBSERVATION_KINDS.indexOf(kind);
  return {
    apiVersion: ACCOUNT_COVERAGE_API_VERSION,
    freshnessAsOf: asOf,
    dataTypesVersion: PROVIDER_DATA_TYPES_VERSION,
    dataTypes: providerTypes,
    sourceId: source.source_id,
    latestFetchRun: fetchRun(source),
    cells: rows.length,
    accounts: [...accounts.entries()]
      .sort(([a], [b]) => byText(a, b))
      .map(([accountId, bucket]): AccountCoverageAccount => {
        const dataTypes = [...bucket.types.entries()]
          .map(([type, periods]) => {
            const [dataset, parser, kind] = JSON.parse(type) as [
              string | null,
              string,
              ObservationKind,
            ];
            return {
              dataset,
              parser,
              kind,
              providerTypes: (providerTypes ?? [])
                .filter((entry) => entry.parsers.includes(parser))
                .map((entry) => entry.type),
              periods,
              freshness: newestCaptureFreshness(periods),
            };
          })
          .sort(
            (a, b) =>
              byText(a.dataset ?? "", b.dataset ?? "") ||
              byText(a.parser, b.parser) ||
              kindOrder(a.kind) - kindOrder(b.kind),
          );
        return {
          accountId,
          label: bucket.label,
          statuses: MAPPING_STATUSES.filter((status) => bucket.statuses.has(status)),
          dataTypes,
          freshness: newestCaptureFreshness(dataTypes.flatMap((type) => type.periods)),
        };
      }),
    unattributed,
  };
}
