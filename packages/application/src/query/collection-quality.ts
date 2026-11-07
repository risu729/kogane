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
  ACCOUNT_COVERAGE_SQL,
  CELL_QUALITY_SQL,
  COLLECTION_QUALITY_ROW_BOUND,
  COLLECTION_QUALITY_TABLES,
  COLLECTION_QUALITY_TABLES_SQL,
  ONE_SOURCE_QUALITY_SQL,
  SCHEDULE_QUALITY_SQL,
  SOURCE_QUALITY_SQL,
  TERMINAL_QUALITY_SQL,
  UNCOMPOSED_QUERY_RULE_PARSERS,
  UNREGISTERED_QUALITY_SQL,
  type AccountCoverageRow,
  type CellQualityRow,
  type ScheduleQualityRow,
  type SourceQualityRow,
  type TerminalQualityRow,
  type UnregisteredQualityRow,
} from "../../../read-model/src/collection-quality.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { type Grant, grantAllows } from "../grants.ts";
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
  validCollectionQualityAlarms,
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
 * reads `unclassified`.
 */
export function safeCode(value: string | null): string | null {
  if (value === null) return null;
  return SAFE_CODE.test(value) ? value : "unclassified";
}

/**
 * A collector's own "a person must act" codes: `HUMAN_REQUIRED_CODE`, MyJCB's
 * `human_required`, and SBI VC's `manual_agreement_required` (the provider's
 * terms wait for the owner's agreement; owner, 2026-11-07 06:28 UTC).
 */
const userActionRequired = (code: string | null): boolean =>
  code !== null && (code.startsWith("human_required") || code === "manual_agreement_required");

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

function sourceReasons(source: Omit<CollectionQualitySource, "reasons">): SourceReason[] {
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

/** `GET /api/collection-quality`: every configured job and every visible source. */
export async function queryCollectionQualitySummary(
  executor: SqlExecutor,
): Promise<CollectionQualitySummary> {
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
    return { ...entry, reasons: sourceReasons(entry) };
  });
  return {
    apiVersion: COLLECTION_QUALITY_API_VERSION,
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

/** One cell as the contract carries it, with the reasons its stored states give. */
export function cell(row: CellQualityRow): CollectionQualityCell {
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

export interface CollectionQualityCellsInput {
  /** A CORE source id. */
  sourceId: string;
  /** Cells to skip, a multiple of the page in practice. */
  offset: number;
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
  const rows = await executor.all<CellQualityRow>(CELL_QUALITY_SQL, [input.sourceId, input.offset]);
  const truncated = rows.length > COLLECTION_QUALITY_PAGE;
  return {
    apiVersion: COLLECTION_QUALITY_API_VERSION,
    sourceId: source.source_id,
    latestFetchRun: fetchRun(source),
    cells: rows.slice(0, COLLECTION_QUALITY_PAGE).map(cell),
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
 */
export async function queryAccountCoverage(
  executor: SqlExecutor,
  input: { sourceId: string },
): Promise<AccountCoverage | null> {
  const source = await executor.first<SourceQualityRow>(ONE_SOURCE_QUALITY_SQL, [input.sourceId]);
  if (source === null) return null;
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
      periods.push({
        unitKey: value.unitKey,
        period: value.period,
        currentRule: value.currentRule,
        cellState: value.state,
        standing,
        capture: inCurrent
          ? value.current!
          : { fetchRunId: value.newest.fetchRunId, capturedAt: value.newest.capturedAt },
        observations: inCurrent ? seen.current : seen.newest,
        reasons: value.reasons,
      });
      entries += 1;
    }
  }
  if (entries > ACCOUNT_COVERAGE_ENTRY_BOUND) throw new CollectionQualityLimitError();
  const kindOrder = (kind: ObservationKind): number => OBSERVATION_KINDS.indexOf(kind);
  return {
    apiVersion: ACCOUNT_COVERAGE_API_VERSION,
    sourceId: source.source_id,
    latestFetchRun: fetchRun(source),
    cells: rows.length,
    accounts: [...accounts.entries()]
      .sort(([a], [b]) => byText(a, b))
      .map(([accountId, bucket]): AccountCoverageAccount => ({
        accountId,
        label: bucket.label,
        statuses: MAPPING_STATUSES.filter((status) => bucket.statuses.has(status)),
        dataTypes: [...bucket.types.entries()]
          .map(([type, periods]) => {
            const [dataset, parser, kind] = JSON.parse(type) as [
              string | null,
              string,
              ObservationKind,
            ];
            return { dataset, parser, kind, periods };
          })
          .sort(
            (a, b) =>
              byText(a.dataset ?? "", b.dataset ?? "") ||
              byText(a.parser, b.parser) ||
              kindOrder(a.kind) - kindOrder(b.kind),
          ),
      })),
    unattributed,
  };
}

// ── the three reads under a grant (ADR 0081) ──────────────────────────────

/** A CORE source id as the collection quality routes accept one. */
export const COLLECTION_QUALITY_SOURCE = /^[a-z0-9][a-z0-9-]{0,99}$/u;
/** The largest cell offset: seven digits, as the route's query has always accepted. */
export const COLLECTION_QUALITY_MAX_OFFSET = 9_999_999;

/**
 * Why a collection quality read was refused, in closed codes. Every transport
 * answers a refusal with the same HTTP status and closed code, the ones the
 * page's route has always answered (`services/app/src/collection-quality-api.ts`).
 */
export type CollectionQualityRefusal =
  /** The grant lacks `evidence.read`. */
  | "unauthorized"
  /** The grant is narrowed to sources or accounts. */
  | "scope_restricted"
  /** The store lacks a table of `COLLECTION_QUALITY_TABLES` (before CORE 0065). */
  | "unavailable"
  /** A malformed source id, or one that is not a visible CORE source. */
  | "unknown_source"
  /** A request key the read does not take. */
  | "invalid_query"
  /** An offset that is not an integer from 0 to `COLLECTION_QUALITY_MAX_OFFSET`. */
  | "invalid_offset"
  /** More rows than the read's bound: refused whole, never cut. */
  | "limit_exceeded";

export type CollectionQualityOutcome<T> =
  | { ok: true; value: T }
  /** `refs` names the checks that refused (`scope:account`, `budget:cells=2000`, …); no transport answers them. */
  | { ok: false; refusal: CollectionQualityRefusal; refs: readonly string[] };

/** A refusal; it fits every read's outcome. */
type Refused = Extract<CollectionQualityOutcome<never>, { ok: false }>;

function refuse(refusal: CollectionQualityRefusal, refs: readonly string[]): Refused {
  return { ok: false, refusal, refs };
}

/** Whether the store has every table of `COLLECTION_QUALITY_TABLES`. */
export async function collectionQualityServed(sql: SqlExecutor): Promise<boolean> {
  const row = await sql.first<{ present: number }>(COLLECTION_QUALITY_TABLES_SQL, []);
  return row?.present === COLLECTION_QUALITY_TABLES.length;
}

/**
 * What every collection quality read decides first, in this order:
 * `evidence.read`, then sources and accounts both `"*"` (the aggregation
 * cannot answer a narrowed grant, even for one known source), both before
 * anything is read; then whether the store has the scheduling tables.
 */
async function gate(grant: Grant, sql: SqlExecutor): Promise<Refused | null> {
  if (!grantAllows(grant, "evidence.read"))
    return refuse("unauthorized", ["capability:evidence.read"]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return refuse("scope_restricted", narrowed);
  if (!(await collectionQualityServed(sql)))
    return refuse("unavailable", ["store:collection-scheduling"]);
  return null;
}

/** The request as a record: absent is `{}`; anything but a plain object has no keys to read. */
function record(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A refusal when the request has a key other than `keys`, or is not an object. */
function closed(value: unknown, keys: readonly string[]): Refused | null {
  const request = record(value);
  return request === null || Object.keys(request).some((key) => !keys.includes(key))
    ? refuse("invalid_query", ["query"])
    : null;
}

/** The request's `source`, or `unknown_source` when it is not a source id. */
function sourceOf(value: unknown): string | Refused {
  const source = record(value)?.["source"];
  return typeof source === "string" && COLLECTION_QUALITY_SOURCE.test(source)
    ? source
    : refuse("unknown_source", ["source"]);
}

/** Runs a read, refusing a `CollectionQualityLimitError` whole as `limit_exceeded`. */
async function bounded<T>(
  budget: readonly string[],
  run: () => Promise<CollectionQualityOutcome<T>>,
): Promise<CollectionQualityOutcome<T>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CollectionQualityLimitError) return refuse("limit_exceeded", budget);
    throw error;
  }
}

/**
 * Overlay the actual Alarm reservations a relay reports onto the summary's
 * jobs, only where the job's stored settings match the reply exactly. A relay
 * that throws or answers off-contract leaves every job `unavailable`: no
 * reservation is inferred from stored settings.
 */
async function overlayAlarms(
  summary: CollectionQualitySummary,
  alarms: () => Promise<unknown>,
): Promise<void> {
  let value: unknown;
  try {
    value = await alarms();
  } catch {
    return;
  }
  if (!validCollectionQualityAlarms(value)) return;
  for (const job of [
    ...summary.sources.flatMap((source) => source.schedules),
    ...summary.otherSchedules,
  ]) {
    const found = value.alarms.find((alarm) => alarm.id === job.id);
    if (
      found &&
      found.enabled === job.enabled &&
      found.nextRunAt === job.nextRunAt &&
      found.nextNominalAt === job.nextNominalAt
    )
      job.alarm = found.alarm;
  }
}

/**
 * `queryCollectionQualitySummary` under a grant: the one service both
 * `GET /api/collection-quality` and `kogane.collection-quality.summary` call
 * (ADR 0081). The request takes no key. `alarms`, when given, reads the
 * actual Alarm reservations (the App's relay to the Observation Pipeline);
 * without it every job's alarm stays `unavailable`. More jobs or sources than
 * `COLLECTION_QUALITY_ROW_BOUND` is `limit_exceeded`, never a cut answer.
 */
export async function readCollectionQualitySummaryForGrant(input: {
  grant: Grant;
  sql: SqlExecutor;
  request?: unknown;
  alarms?: (() => Promise<unknown>) | undefined;
}): Promise<CollectionQualityOutcome<CollectionQualitySummary>> {
  const refused = (await gate(input.grant, input.sql)) ?? closed(input.request, []);
  if (refused) return refused;
  const budget = [
    `budget:jobs=${String(COLLECTION_QUALITY_ROW_BOUND)}`,
    `budget:sources=${String(COLLECTION_QUALITY_ROW_BOUND)}`,
  ];
  return bounded(budget, async () => {
    const summary = await queryCollectionQualitySummary(input.sql);
    if (input.alarms) await overlayAlarms(summary, input.alarms);
    return { ok: true, value: summary };
  });
}

/**
 * `queryCollectionQualityCells` under a grant: the one service both
 * `GET /api/collection-quality/<source>` and `kogane.collection-quality.cells`
 * call (ADR 0081). The request is `{ source, offset? }`, checked in this
 * order: the source id, then the keys, then the offset (an integer from 0 to
 * `COLLECTION_QUALITY_MAX_OFFSET`, 0 when absent), then whether the source is
 * a visible CORE source. One page of `COLLECTION_QUALITY_PAGE` cells.
 */
export async function readCollectionQualityCellsForGrant(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: unknown;
}): Promise<CollectionQualityOutcome<CollectionQualityCells>> {
  const refused = await gate(input.grant, input.sql);
  if (refused) return refused;
  const sourceId = sourceOf(input.request);
  if (typeof sourceId !== "string") return sourceId;
  const extra = closed(input.request, ["source", "offset"]);
  if (extra) return extra;
  const keys = record(input.request)!;
  const offset = Object.hasOwn(keys, "offset") ? keys["offset"] : 0;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > COLLECTION_QUALITY_MAX_OFFSET
  )
    return refuse("invalid_offset", ["offset"]);
  // Paged, so never over a bound: the page says whether more cells follow.
  const cells = await queryCollectionQualityCells(input.sql, { sourceId, offset });
  return cells === null ? refuse("unknown_source", ["source"]) : { ok: true, value: cells };
}

/**
 * `queryAccountCoverage` under a grant: the one service both
 * `GET /api/collection-quality/<source>/accounts` and
 * `kogane.collection-quality.accounts` call (ADR 0081, ADR 0088). The request
 * is `{ source }`, checked in this order: the source id, then the keys, then
 * whether the source is a visible CORE source. More cells or account periods
 * than the bounds is `limit_exceeded`, never a cut answer.
 */
export async function readAccountCoverageForGrant(input: {
  grant: Grant;
  sql: SqlExecutor;
  request: unknown;
}): Promise<CollectionQualityOutcome<AccountCoverage>> {
  const refused = await gate(input.grant, input.sql);
  if (refused) return refused;
  const sourceId = sourceOf(input.request);
  if (typeof sourceId !== "string") return sourceId;
  const extra = closed(input.request, ["source"]);
  if (extra) return extra;
  const budget = [
    `budget:cells=${String(ACCOUNT_COVERAGE_CELL_BOUND)}`,
    `budget:periods=${String(ACCOUNT_COVERAGE_ENTRY_BOUND)}`,
  ];
  return bounded(budget, async () => {
    const coverage = await queryAccountCoverage(input.sql, { sourceId });
    return coverage === null ? refuse("unknown_source", ["source"]) : { ok: true, value: coverage };
  });
}
