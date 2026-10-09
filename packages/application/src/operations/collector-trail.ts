// What happened to one accepted collection or session-refresh request, read
// from CORE (issue #544, ADR 0048).
//
// The request id leads to the execution row (`ops_collector_dispatches`,
// migration 0068), the execution to the runs the collector reported, each run
// to its registration (`collection_runs` → the fetch run, i.e. the 取得記録
// `r_<id>`), its artifacts, their parse jobs and parse runs, and the CORE
// publication pointer (`published_parse_runs`). Every step is a stored fact;
// nothing here asks a collector or a provider anything, and a step nobody has
// reached reads as not reached — never as an empty success.
//
// Counts, identifiers, timestamps and closed codes only: no artifact key, no
// parse error text, no amount.
//
// Pure: a `CommandStore` and nothing else, so the App's read route and the
// Processor's tracker compute the same trail from the same rows.
import type { CommandStore } from "../command/contract.ts";

export const COLLECTOR_ACTIONS = ["collect", "refresh-session"] as const;
export type CollectorAction = (typeof COLLECTOR_ACTIONS)[number];

/** The stored execution states (the 0068 CHECK, in lifecycle order). */
export const COLLECTOR_DISPATCH_STATES = [
  "waiting",
  "started",
  "collected",
  "refreshed",
  "published",
  "unpublished",
  "failed",
  "uncertain",
  "expired",
  "unsupported",
] as const;
export type CollectorDispatchState = (typeof COLLECTOR_DISPATCH_STATES)[number];

/**
 * What a reader is told. `accepted` is a request no executor has looked at
 * yet; `waiting_for_human` is a refresh the source policy hands to a person
 * (本人操作待ち) — nothing is dispatched and nothing retries a login. Both are
 * derived from the request row; the rest are the stored states.
 */
export const COLLECTOR_EXECUTION_STATES = [
  "accepted",
  "waiting_for_human",
  ...COLLECTOR_DISPATCH_STATES,
] as const;
export type CollectorExecutionState = (typeof COLLECTOR_EXECUTION_STATES)[number];

/** A request that has not started this long after acceptance expires. */
export const COLLECTOR_START_TTL_MS = 24 * 3_600_000;
/** A collected request whose runs have not settled this long after collection stops being watched. */
export const PUBLICATION_HORIZON_MS = 48 * 3_600_000;

export const RUN_TRAIL_STATES = [
  "not_registered",
  "registering",
  "blocked",
  "parsing",
  "published",
  "unpublished",
] as const;
export type RunTrailState = (typeof RUN_TRAIL_STATES)[number];

/** Per-run artifact counts. `notPublished` = selected by a parser, settled, not adopted. */
export interface CollectorRunArtifacts {
  total: number;
  parseSelected: number;
  published: number;
  pending: number;
  parseFailed: number;
  notPublished: number;
}

export interface CollectorRunTrail {
  runId: string;
  state: RunTrailState;
  /** Why a settled run published nothing (closed code), or null. */
  reasonCode: string | null;
  /** The registration's own safe block code when `state` is `blocked`. */
  blockedCode: string | null;
  providerOutcome: string | null;
  /** The fetch-history id the evidence browser links (`r_<fetch run>`), once registered. */
  evidenceRunId: string | null;
  registeredAt: string | null;
  artifacts: CollectorRunArtifacts | null;
}

export interface CollectorExecutionReport {
  action: CollectorAction;
  state: CollectorExecutionState;
  /** The named collector connection (alarm job id) the request was bound to. */
  connectionId: string | null;
  /** Why it waits, or why it ended without a result; a closed code. */
  reasonCode: string | null;
  /**
   * What a collection run covers. The collectors run their connection's daily
   * scope; a requested window is stored with the request and is not applied
   * (ADR 0048). Null for a session refresh.
   */
  scope: "collector_default" | null;
  waits: number;
  /** When an unstarted request expires (acceptance + 24 h); null while a person is the next step. */
  expiresAt: string | null;
  startedAt: string | null;
  collectedAt: string | null;
  publishedAt: string | null;
  finishedAt: string | null;
  runs: CollectorRunTrail[];
}

export interface CollectorDispatchRow {
  operation_id: string;
  connection_id: string | null;
  action: CollectorAction;
  terminal_source: string | null;
  state: CollectorDispatchState;
  reason_code: string | null;
  waits: number;
  starts: number;
  run_ids_json: string;
  accepted_at: string;
  expires_at: string;
  started_at: string | null;
  collected_at: string | null;
  published_at: string | null;
  finished_at: string | null;
  next_check_at_ms: number;
  updated_at: string;
}

export const DISPATCH_COLUMNS = `operation_id,connection_id,action,terminal_source,state,reason_code,
 waits,starts,run_ids_json,accepted_at,expires_at,started_at,collected_at,published_at,finished_at,
 next_check_at_ms,updated_at`;

export async function readCollectorDispatch(
  store: CommandStore,
  operationId: string,
): Promise<CollectorDispatchRow | null> {
  return store.first<CollectorDispatchRow>(
    `SELECT ${DISPATCH_COLUMNS} FROM ops_collector_dispatches WHERE operation_id=?1`,
    [operationId],
  );
}

/** The run ids a collected execution stored (written once, at most 100). */
export function storedRunIds(row: Pick<CollectorDispatchRow, "run_ids_json">): string[] {
  try {
    const value: unknown = JSON.parse(row.run_ids_json);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** The action an operation kind asks of a collector, or null for the other kinds. */
export function collectorActionForKind(kind: string): CollectorAction | null {
  if (kind === "collection") return "collect";
  if (kind === "session-refresh") return "refresh-session";
  return null;
}

export function expiresAtFor(acceptedAt: string): string {
  return new Date(Date.parse(acceptedAt) + COLLECTOR_START_TTL_MS).toISOString();
}

// ── the trail ───────────────────────────────────────────────────────────

/**
 * One row per reported run, in the order the collector reported them. Of
 * several registrations of one run (a contract revision), the registered one
 * wins, then the newest. The work item is the sealed run's parse scheduling:
 * until it is processed, "no parse job yet" means "not looked at yet", not
 * "nothing to parse".
 */
const RUN_ROWS = `SELECT r.value AS run_id, c.blocked_code, c.provider_outcome, c.fetch_run_id,
  c.registered_at, w.processed_at_ms
 FROM json_each(?2) r
 LEFT JOIN collection_runs c ON c.id=(
   SELECT x.id FROM collection_runs x WHERE x.source=?1 AND x.run_id=r.value
    ORDER BY x.fetch_run_id IS NULL, x.id DESC LIMIT 1)
 LEFT JOIN observation_work_items w ON w.fetch_run_id=c.fetch_run_id AND w.kind='sealed_run'
 ORDER BY r.key`;

/**
 * Artifact counts per registered fetch run. Each flag is a keyed lookup
 * (the job and publication primary keys, `idx_parse_runs_artifact`); counts
 * only, so no artifact key, parse error or value leaves CORE through here.
 */
const ARTIFACT_COUNTS = `SELECT fetch_run_id, count(*) AS total,
  coalesce(sum(selected),0) AS parse_selected,
  coalesce(sum(selected AND published),0) AS published,
  coalesce(sum(selected AND NOT published AND pending),0) AS pending,
  coalesce(sum(selected AND NOT published AND NOT pending AND errored),0) AS parse_failed
 FROM (SELECT a.fetch_run_id,
   (EXISTS(SELECT 1 FROM observation_parse_jobs j WHERE j.fetch_artifact_id=a.id)
    OR EXISTS(SELECT 1 FROM parse_runs p WHERE p.fetch_artifact_id=a.id)) AS selected,
   EXISTS(SELECT 1 FROM published_parse_runs u WHERE u.fetch_artifact_id=a.id) AS published,
   (EXISTS(SELECT 1 FROM observation_parse_jobs j WHERE j.fetch_artifact_id=a.id
            AND j.status IN ('pending','running'))
    OR EXISTS(SELECT 1 FROM parse_runs p WHERE p.fetch_artifact_id=a.id AND p.status='pending'))
     AS pending,
   EXISTS(SELECT 1 FROM parse_runs p WHERE p.fetch_artifact_id=a.id AND p.status='error')
     AS errored
  FROM fetch_artifacts a WHERE a.fetch_run_id IN (SELECT value FROM json_each(?1)))
 GROUP BY fetch_run_id`;

interface RunRow {
  run_id: string;
  blocked_code: string | null;
  provider_outcome: string | null;
  fetch_run_id: number | null;
  registered_at: string | null;
  processed_at_ms: number | null;
}
interface CountRow {
  fetch_run_id: number;
  total: number;
  parse_selected: number;
  published: number;
  pending: number;
  parse_failed: number;
}

export async function collectorRunTrails(
  store: CommandStore,
  terminalSource: string,
  runIds: readonly string[],
): Promise<CollectorRunTrail[]> {
  if (runIds.length === 0) return [];
  const runs = await store.all<RunRow>(RUN_ROWS, [terminalSource, JSON.stringify(runIds)]);
  const fetchRunIds = runs.map((row) => row.fetch_run_id).filter((id): id is number => id !== null);
  const counts =
    fetchRunIds.length === 0
      ? []
      : await store.all<CountRow>(ARTIFACT_COUNTS, [JSON.stringify(fetchRunIds)]);
  const byRun = new Map(counts.map((row) => [row.fetch_run_id, row]));
  return runs.map((row) =>
    runTrail(row, row.fetch_run_id === null ? undefined : byRun.get(row.fetch_run_id)),
  );
}

function runTrail(row: RunRow, counts: CountRow | undefined): CollectorRunTrail {
  const base = {
    runId: row.run_id,
    blockedCode: null,
    providerOutcome: row.provider_outcome,
    evidenceRunId: row.fetch_run_id === null ? null : `r_${row.fetch_run_id}`,
    registeredAt: row.registered_at,
  };
  if (row.blocked_code === null && row.provider_outcome === null && row.fetch_run_id === null)
    return { ...base, state: "not_registered", reasonCode: null, artifacts: null };
  if (row.fetch_run_id === null) {
    if (row.blocked_code !== null)
      return {
        ...base,
        state: "blocked",
        reasonCode: "registration_blocked",
        blockedCode: row.blocked_code,
        artifacts: null,
      };
    return { ...base, state: "registering", reasonCode: null, artifacts: null };
  }
  const total = counts?.total ?? 0;
  const parseSelected = counts?.parse_selected ?? 0;
  const published = counts?.published ?? 0;
  const pending = counts?.pending ?? 0;
  const parseFailed = counts?.parse_failed ?? 0;
  const artifacts: CollectorRunArtifacts = {
    total,
    parseSelected,
    published,
    pending,
    parseFailed,
    notPublished: parseSelected - published - pending,
  };
  // Until the sealed run's work item is processed, the parse lanes have not
  // looked at it: no job yet is "not yet", never "nothing to parse".
  if (row.processed_at_ms === null || pending > 0)
    return { ...base, state: "parsing", reasonCode: null, artifacts };
  if (published > 0) return { ...base, state: "published", reasonCode: null, artifacts };
  const reasonCode =
    row.provider_outcome === "failed"
      ? "provider_failed"
      : parseSelected === 0
        ? "no_parser_selected"
        : parseFailed > 0
          ? "parse_failed"
          : "not_adopted";
  return { ...base, state: "unpublished", reasonCode, artifacts };
}

export type StageVerdict =
  | { state: "pending" }
  | { state: "completed"; evidenceRef: string }
  | { state: "blocked"; failureCode: string };

export interface TrailOutcome {
  /** Every reported run reached publication or a closed reason. */
  settled: boolean;
  /** At least one reported run has a published parse. */
  published: boolean;
  /** Why a settled trail published nothing, or null. */
  reasonCode: string | null;
  registered: StageVerdict;
  parsed: StageVerdict;
  adopted: StageVerdict;
}

const SETTLED: readonly RunTrailState[] = ["blocked", "published", "unpublished"];

/**
 * The stage ladder a set of runs supports. `completed` is written only from
 * the rows above (contracts/stages.json): registration is complete when every
 * run is registered, parsing when no selected artifact is still pending, and
 * adoption when a parse is published. `projected` (READ) is not traced here.
 */
export function trailOutcome(runs: readonly CollectorRunTrail[]): TrailOutcome {
  if (runs.length === 0)
    return {
      settled: true,
      published: false,
      reasonCode: "run_not_reported",
      registered: { state: "blocked", failureCode: "run_not_reported" },
      parsed: { state: "pending" },
      adopted: { state: "pending" },
    };
  const settled = runs.every((run) => SETTLED.includes(run.state));
  const published = runs.some((run) => run.state === "published");
  const registeredRuns = runs.filter((run) => run.evidenceRunId !== null);
  const reasonCode =
    settled && !published
      ? (runs.find((run) => run.reasonCode !== null)?.reasonCode ?? null)
      : null;
  const registered: StageVerdict =
    registeredRuns.length === runs.length
      ? { state: "completed", evidenceRef: evidenceRef(registeredRuns) }
      : settled
        ? { state: "blocked", failureCode: "registration_blocked" }
        : { state: "pending" };
  const selected = registeredRuns.reduce(
    (sum, run) => sum + (run.artifacts?.parseSelected ?? 0),
    0,
  );
  const parsingDone =
    registeredRuns.length > 0 && registeredRuns.every((run) => SETTLED.includes(run.state));
  const parsed: StageVerdict = !parsingDone
    ? { state: "pending" }
    : selected > 0
      ? { state: "completed", evidenceRef: evidenceRef(registeredRuns) }
      : { state: "blocked", failureCode: reasonCode ?? "no_parser_selected" };
  const adopted: StageVerdict = !settled
    ? { state: "pending" }
    : published
      ? {
          state: "completed",
          evidenceRef: evidenceRef(runs.filter((run) => run.state === "published")),
        }
      : { state: "blocked", failureCode: reasonCode ?? "not_adopted" };
  return { settled, published, reasonCode, registered, parsed, adopted };
}

function evidenceRef(runs: readonly CollectorRunTrail[]): string {
  return runs.length === 1 && runs[0]!.evidenceRunId !== null
    ? runs[0]!.evidenceRunId
    : `runs:${runs.length}`;
}

// ── the report a reader gets ────────────────────────────────────────────

/**
 * The `execution` block of an operation record, or null for a kind no
 * collector executes. Live from CORE: the run trail is computed at read time,
 * while the state and its timestamps are what the Processor recorded.
 */
export async function collectorExecution(
  store: CommandStore,
  operation: { operationId: string; kind: string; status: string; acceptedAt: string },
): Promise<CollectorExecutionReport | null> {
  const action = collectorActionForKind(operation.kind);
  if (action === null) return null;
  const row = await readCollectorDispatch(store, operation.operationId);
  const scope = action === "collect" ? "collector_default" : null;
  if (row === null) {
    const human = operation.status === "waiting_for_human";
    return {
      action,
      state: human ? "waiting_for_human" : "accepted",
      connectionId: null,
      reasonCode: null,
      scope,
      waits: 0,
      // A request handed to a person is not dispatched, so nothing expires it.
      expiresAt: human ? null : expiresAtFor(operation.acceptedAt),
      startedAt: null,
      collectedAt: null,
      publishedAt: null,
      finishedAt: null,
      runs: [],
    };
  }
  const runIds = storedRunIds(row);
  const runs =
    row.terminal_source === null || runIds.length === 0
      ? []
      : await collectorRunTrails(store, row.terminal_source, runIds);
  return {
    action,
    state: row.state,
    connectionId: row.connection_id,
    reasonCode: row.reason_code,
    scope,
    waits: row.waits,
    expiresAt: row.expires_at,
    startedAt: row.started_at,
    collectedAt: row.collected_at,
    publishedAt: row.published_at,
    finishedAt: row.finished_at,
    runs,
  };
}
