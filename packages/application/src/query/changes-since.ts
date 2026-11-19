// What changed since a time (issue #1414, gap G3 of the MCP everyday-questions
// audit, ADR 0127): per visible source, how many fetch runs, captures, parse
// runs and observation rows were recorded in the store at or after `since`,
// by closed state, with the newest times and the ids the existing reads take,
// and the event revisions recorded since. `GET /api/v2/changes` and
// `kogane.changes.since` both call `readChangesSince` and nothing else, so a
// route and an agent read one answer (ADR 0081 point 2).
//
// It reads, and nothing else (INV07). Closed codes, counts, times and ids
// only: no amount, label or provider text. A count that reached its bound is
// a lower bound and says so (`cut`); a section the grant cannot read is null,
// never zero (INV05).
//
// - The grant decides first: `records.read` over the whole store, refused
//   before the request is checked or anything is read. `runs` and `captures`
//   also need `evidence.read`, the capability of their handler
//   (`kogane.evidence.read`); without it those sections are `unauthorized`
//   and their tables are not read.
// - "New" is "recorded at or after `since`": a fetch run by its first
//   recording, a capture with its run, a parse run by its parse time, an
//   observation with its parse run, an event revision by its creation. Each
//   table is walked newest first by its insertion order (a run by its
//   source's `idx_fetch_runs_source`, parse runs and event revisions by
//   rowid), which is recording order: the writers stamp the time when they
//   insert, and nothing is deleted.
// - Bounded whatever the store holds: at most `CHANGES_SINCE_RUN_WALK` runs
//   per source, `CHANGES_SINCE_PARSE_WALK` parse runs and
//   `CHANGES_SINCE_EVENT_WALK` event revisions are read, each with its keys;
//   captures and observation rows are counted up to their bounds. The answer
//   is cut between sources at `CHANGES_SINCE_MAX_BYTES` and continues with
//   `after`.
import type { FinancialError, FinancialErrorCode } from "../../../domain/src/result.ts";
import {
  CHANGES_SINCE_CAPTURE_BOUND,
  CHANGES_SINCE_EVENT_WALK,
  CHANGES_SINCE_HANDLERS,
  CHANGES_SINCE_MAX_BYTES,
  CHANGES_SINCE_MAX_DAYS,
  CHANGES_SINCE_NOT_COVERED,
  CHANGES_SINCE_OBSERVATION_BOUND,
  CHANGES_SINCE_OBSERVATION_KINDS,
  CHANGES_SINCE_PARSE_STATES,
  CHANGES_SINCE_PARSE_WALK,
  CHANGES_SINCE_RUN_STATUSES,
  CHANGES_SINCE_RUN_WALK,
  CHANGES_SINCE_SECTIONS,
  CHANGES_SINCE_SOURCE_BOUND,
  ECONOMIC_EVENT_KINDS,
  type ChangesSince,
  type ChangesSinceEvents,
  type ChangesSinceHandlerName,
  type ChangesSinceSection,
  type ChangesSinceSourceLine,
} from "../../../domain/src/changes-since.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { financialError } from "../errors.ts";
import { type AgentCapability, type Grant, grantAllows } from "../grants.ts";

const REQUEST_ID = "changes.since";

/**
 * The capability each handler's read tool needs: the catalogue capability of
 * `CHANGES_SINCE_HANDLERS[name].tool` (a test holds the two equal). A section
 * whose handler the grant cannot call is `unauthorized` and not read.
 */
export const CHANGES_SINCE_HANDLER_CAPABILITIES: Record<ChangesSinceHandlerName, AgentCapability> =
  {
    runs: "evidence.read",
    captures: "evidence.read",
    parses: "records.read",
    observations: "records.read",
    events: "records.read",
    unchanged: "evidence.read",
  };

/** An instant with a date, a time and a zone (`Z` or an offset): no bare date, no local time. */
const CHANGES_SINCE_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
/** A source id, in the evidence browser's charset. */
const CHANGES_SINCE_SOURCE = /^[a-z0-9][a-z0-9-]{0,99}$/u;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The ISO form every compared time is normalized to (`toISOString`). */
const ISO = `'%Y-%m-%dT%H:%M:%fZ'`;

/**
 * The visible sources after `?1` (`''` for the first), in id order, one past
 * the bound (`?2`) so a larger registry is refused rather than cut.
 */
export const CHANGES_SINCE_SOURCES_SQL = `SELECT id FROM observation_sources WHERE id > ?1 ORDER BY id LIMIT ?2`;

/**
 * Fetch runs of the sources in `?1` (a JSON array) first recorded at or
 * after `?2` (epoch milliseconds), among each source's newest `?3` financial
 * runs (`financial_fetch_runs`, through `idx_fetch_runs_source`). Rows:
 * per source one `cut` row (`n` 1 when the run past the walk is also new),
 * per (source, status) one `status` row with the count, the newest recording
 * time and the newest sealed run, and per source one `captures` row counting
 * the artifacts of its new runs among the first `?4` artifact rows read.
 */
export const CHANGES_SINCE_RUNS_SQL = `WITH bound AS MATERIALIZED (
 SELECT s.value AS source_id,
  (SELECT x.id FROM financial_fetch_runs x WHERE x.source_id = s.value ORDER BY x.id DESC LIMIT 1 OFFSET ?3) AS beyond_id
 FROM json_each(?1) s
), fresh AS MATERIALIZED (
 SELECT r.id, r.source_id, r.first_recorded_at_ms AS at,
  CASE WHEN NOT EXISTS(SELECT 1 FROM fetch_run_seals seal WHERE seal.fetch_run_id = r.id) THEN 'open'
   ELSE coalesce((SELECT t.normalized_outcome FROM fetch_run_reports t
    WHERE t.fetch_run_id = r.id AND t.report_kind = 'terminal'), 'open') END AS status
 FROM bound b CROSS JOIN financial_fetch_runs r ON r.source_id = b.source_id AND r.id > coalesce(b.beyond_id, 0)
 WHERE r.first_recorded_at_ms >= ?2
)
SELECT b.source_id, 'cut' AS row_kind, NULL AS status,
 CASE WHEN (SELECT x.first_recorded_at_ms FROM fetch_runs x WHERE x.id = b.beyond_id) >= ?2 THEN 1 ELSE 0 END AS n,
 NULL AS newest_at, NULL AS newest_id
FROM bound b
UNION ALL
SELECT f.source_id, 'status', f.status, count(*), max(f.at), max(CASE WHEN f.status <> 'open' THEN f.id END)
FROM fresh f GROUP BY f.source_id, f.status
UNION ALL
SELECT c.source_id, 'captures', NULL, count(*), NULL, NULL
FROM (SELECT f.source_id FROM fresh f JOIN fetch_artifacts a ON a.fetch_run_id = f.id LIMIT ?4) c
GROUP BY c.source_id`;

/** One observation table's rows of the recorded new parse runs, the first `?4` read. */
const observationTerm = (kind: string, table: string): string =>
  `SELECT * FROM (SELECT r.source_id, '${kind}' AS kind FROM recorded r JOIN ${table} t ON t.parse_run_id = r.id LIMIT ?4)`;

/**
 * Parse runs recorded at or after `?2` (an ISO instant) among the newest `?3`
 * store-wide (by rowid), on artifacts of the sources in `?1` that no
 * annotation excludes from the financial views. Rows: one `cut` row (`n` 1
 * when the parse run past the walk is also new), per (source, state) one
 * `status` row with the count and the newest parse time, per source one
 * `newest` row with the artifact of its newest recorded parse (published,
 * superseded or failed: the parses a reader may see), and per (source, kind)
 * one `observations` row counting those parses' rows among the first `?4`
 * read of that kind. D1 allows at most five terms in one compound SELECT, so
 * the four kinds are one term of the outer compound, a compound of their own.
 */
export const CHANGES_SINCE_PARSES_SQL = `WITH walked AS MATERIALIZED (
 SELECT p.id, p.fetch_artifact_id, strftime(${ISO}, p.parsed_at) AS at, p.status, p.superseded_by_parse_run_id
 FROM parse_runs p ORDER BY p.id DESC LIMIT ?3
), fresh AS MATERIALIZED (
 SELECT w.id, w.fetch_artifact_id, w.at, a.source_id,
  CASE WHEN w.status = 'pending' THEN 'pending' WHEN w.status = 'error' THEN 'failed'
   WHEN EXISTS(SELECT 1 FROM published_parse_runs pp WHERE pp.parse_run_id = w.id) THEN 'published'
   WHEN w.superseded_by_parse_run_id IS NOT NULL THEN 'superseded' ELSE 'unadopted' END AS state
 FROM walked w CROSS JOIN fetch_artifacts a ON a.id = w.fetch_artifact_id
 WHERE w.at >= ?2 AND a.source_id IN (SELECT value FROM json_each(?1))
  AND NOT EXISTS(SELECT 1 FROM fetch_run_annotations n WHERE n.fetch_run_id = a.fetch_run_id
   AND n.annotation_kind = 'exclude_from_financial_views')
), recorded AS MATERIALIZED (
 SELECT id, source_id, fetch_artifact_id FROM fresh WHERE state IN ('published', 'superseded', 'failed')
)
SELECT NULL AS source_id, 'cut' AS row_kind, NULL AS state,
 CASE WHEN (SELECT strftime(${ISO}, p.parsed_at) FROM parse_runs p ORDER BY p.id DESC LIMIT 1 OFFSET ?3) >= ?2
  THEN 1 ELSE 0 END AS n,
 NULL AS newest_at, NULL AS newest_id
UNION ALL
SELECT f.source_id, 'status', f.state, count(*), max(f.at), NULL FROM fresh f GROUP BY f.source_id, f.state
UNION ALL
SELECT r.source_id, 'newest', NULL, 0, NULL, r.fetch_artifact_id FROM (
 SELECT source_id, fetch_artifact_id, row_number() OVER (PARTITION BY source_id ORDER BY id DESC) AS position
 FROM recorded
) r WHERE r.position = 1
UNION ALL
SELECT o.source_id, 'observations', o.kind, count(*), NULL, NULL FROM (
 ${observationTerm("transaction", "transaction_observations")}
 UNION ALL ${observationTerm("balance", "balance_observations")}
 UNION ALL ${observationTerm("position", "position_observations")}
 UNION ALL ${observationTerm("valuation", "valuation_observations")}
) o GROUP BY o.source_id, o.kind`;

/**
 * Event revisions created at or after `?1` (an ISO instant) among the newest
 * `?2` (by rowid): one `cut` row (`n` 1 when the revision past the walk is
 * also new), and per (kind, change) one `kind` row with the count and the
 * newest creation time; `change` is `new` for a first revision, else
 * `revised`.
 */
export const CHANGES_SINCE_EVENTS_SQL = `WITH walked AS MATERIALIZED (
 SELECT e.kind, e.revision, strftime(${ISO}, e.created_at) AS at
 FROM economic_event_revisions e ORDER BY e.rowid DESC LIMIT ?2
)
SELECT 'cut' AS row_kind, NULL AS kind, NULL AS change,
 CASE WHEN (SELECT strftime(${ISO}, e.created_at) FROM economic_event_revisions e ORDER BY e.rowid DESC LIMIT 1 OFFSET ?2) >= ?1
  THEN 1 ELSE 0 END AS n,
 NULL AS newest_at
UNION ALL
SELECT 'kind', w.kind, CASE WHEN w.revision = 1 THEN 'new' ELSE 'revised' END, count(*), max(w.at)
FROM walked w WHERE w.at >= ?1 GROUP BY 2, 3`;

interface SourceRow {
  id: string;
}
interface RunRow {
  source_id: string;
  row_kind: "cut" | "status" | "captures";
  status: string | null;
  n: number;
  newest_at: number | null;
  newest_id: number | null;
}
interface ParseRow {
  source_id: string | null;
  row_kind: "cut" | "status" | "newest" | "observations";
  state: string | null;
  n: number;
  newest_at: string | null;
  newest_id: number | null;
}
interface EventRow {
  row_kind: "cut" | "kind";
  kind: string | null;
  change: "new" | "revised" | null;
  n: number;
  newest_at: string | null;
}

export type ChangesSinceOutcome =
  | { ok: true; answer: ChangesSince }
  | { ok: false; error: FinancialError };

/** What this deployment serves: the events line is `not_served` where the projection is absent. */
export interface ChangesSinceServed {
  /** The A10 event projection (`eventsV2Available`). */
  events: boolean;
}

/** The request as the route's query or the tool's body gives it; the service checks it. */
export interface ChangesSinceRequest {
  since?: unknown;
  after?: unknown;
}

/** The ISO form of `since`, or the closed ref of why it is refused. */
function checkedSince(value: unknown, now: number): { since: string } | { refusal: string } {
  if (typeof value !== "string" || !CHANGES_SINCE_INSTANT.test(value))
    return { refusal: "since:format" };
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return { refusal: "since:format" };
  // A real calendar time: a parser that rolls `02-30` or `24:00` over to
  // another instant is not trusted with it.
  const [, year, month, day, hour, minute, second = "0"] =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/u.exec(value)!;
  const civil = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  if (
    civil.getUTCFullYear() !== Number(year) ||
    civil.getUTCMonth() !== Number(month) - 1 ||
    civil.getUTCDate() !== Number(day) ||
    civil.getUTCHours() !== Number(hour) ||
    civil.getUTCMinutes() !== Number(minute) ||
    civil.getUTCSeconds() !== Number(second)
  )
    return { refusal: "since:format" };
  if (at > now) return { refusal: "since:future" };
  if (at < now - CHANGES_SINCE_MAX_DAYS * DAY_MS) return { refusal: "since:too_old" };
  return { since: new Date(at).toISOString() };
}

/** The positions of the parse states whose observations a reader may see. */
const RECORDED_STATES = (["published", "superseded", "failed"] as const).map((state) =>
  CHANGES_SINCE_PARSE_STATES.indexOf(state),
);

const zeros = (length: number): number[] => Array.from({ length }, () => 0);
const later = <T extends string | number>(left: T | null, right: T | null): T | null =>
  left === null ? right : right === null ? left : right > left ? right : left;

/** A source's line while it is assembled. */
interface Draft {
  cut: Set<ChangesSinceSection>;
  runs: number[];
  captures: number;
  parses: number[];
  observations: number[];
  newestRunAtMs: number | null;
  newestSealedRun: number | null;
  newestParsedAt: string | null;
  newestParsedArtifactId: number | null;
}

function draft(): Draft {
  return {
    cut: new Set(),
    runs: zeros(CHANGES_SINCE_RUN_STATUSES.length),
    captures: 0,
    parses: zeros(CHANGES_SINCE_PARSE_STATES.length),
    observations: zeros(CHANGES_SINCE_OBSERVATION_KINDS.length),
    newestRunAtMs: null,
    newestSealedRun: null,
    newestParsedAt: null,
    newestParsedArtifactId: null,
  };
}

/** A position in a closed list, or a thrown error for a value the store cannot hold. */
function position(list: readonly string[], value: string | null, what: string): number {
  const index = value === null ? -1 : list.indexOf(value);
  if (index < 0) throw new RangeError(`unexpected ${what}`);
  return index;
}

async function readRuns(
  sql: SqlExecutor,
  drafts: Map<string, Draft>,
  sourcesJson: string,
  sinceMs: number,
): Promise<void> {
  const rows = await sql.all<RunRow>(CHANGES_SINCE_RUNS_SQL, [
    sourcesJson,
    sinceMs,
    CHANGES_SINCE_RUN_WALK,
    CHANGES_SINCE_CAPTURE_BOUND + 1,
  ]);
  let captures = 0;
  for (const row of rows) {
    const line = drafts.get(row.source_id);
    if (!line) continue;
    if (row.row_kind === "cut") {
      if (row.n === 1) line.cut.add("runs").add("captures");
    } else if (row.row_kind === "status") {
      line.runs[position(CHANGES_SINCE_RUN_STATUSES, row.status, "run status")]! += row.n;
      line.newestRunAtMs = later(line.newestRunAtMs, row.newest_at);
      line.newestSealedRun = later(line.newestSealedRun, row.newest_id);
    } else {
      line.captures += row.n;
      captures += row.n;
    }
  }
  // More artifact rows than the bound: every source with a new run may hold
  // more than it shows.
  if (captures > CHANGES_SINCE_CAPTURE_BOUND)
    for (const line of drafts.values()) if (line.runs.some((n) => n > 0)) line.cut.add("captures");
}

async function readParses(
  sql: SqlExecutor,
  drafts: Map<string, Draft>,
  sourcesJson: string,
  since: string,
): Promise<void> {
  const rows = await sql.all<ParseRow>(CHANGES_SINCE_PARSES_SQL, [
    sourcesJson,
    since,
    CHANGES_SINCE_PARSE_WALK,
    CHANGES_SINCE_OBSERVATION_BOUND + 1,
  ]);
  const observed = zeros(CHANGES_SINCE_OBSERVATION_KINDS.length);
  let walkCut = false;
  for (const row of rows) {
    if (row.row_kind === "cut") {
      walkCut = row.n === 1;
      continue;
    }
    const line = row.source_id === null ? undefined : drafts.get(row.source_id);
    if (!line) continue;
    if (row.row_kind === "status") {
      line.parses[position(CHANGES_SINCE_PARSE_STATES, row.state, "parse state")]! += row.n;
      line.newestParsedAt = later(line.newestParsedAt, row.newest_at);
    } else if (row.row_kind === "newest") {
      line.newestParsedArtifactId = row.newest_id;
    } else {
      const kind = position(CHANGES_SINCE_OBSERVATION_KINDS, row.state, "observation kind");
      line.observations[kind]! += row.n;
      observed[kind]! += row.n;
    }
  }
  // The walk ended on a new parse run: any source may have more, older ones.
  if (walkCut) for (const line of drafts.values()) line.cut.add("parses").add("observations");
  // A kind's rows reached the bound: every source with a recorded new parse
  // may hold more rows than it shows.
  if (observed.some((n) => n > CHANGES_SINCE_OBSERVATION_BOUND))
    for (const line of drafts.values())
      if (RECORDED_STATES.some((state) => line.parses[state]! > 0)) line.cut.add("observations");
}

async function readEvents(
  sql: SqlExecutor,
  since: string,
  served: ChangesSinceServed,
): Promise<ChangesSinceEvents> {
  if (!served.events)
    return {
      state: "unavailable",
      reason: "not_served",
      complete: false,
      new: null,
      revised: null,
      newestAt: null,
    };
  const rows = await sql.all<EventRow>(CHANGES_SINCE_EVENTS_SQL, [since, CHANGES_SINCE_EVENT_WALK]);
  const first = zeros(ECONOMIC_EVENT_KINDS.length);
  const revised = zeros(ECONOMIC_EVENT_KINDS.length);
  let complete = true;
  let newestAt: string | null = null;
  for (const row of rows) {
    if (row.row_kind === "cut") {
      complete = row.n !== 1;
      continue;
    }
    const kind = position(ECONOMIC_EVENT_KINDS, row.kind, "event kind");
    (row.change === "new" ? first : revised)[kind]! += row.n;
    newestAt = later(newestAt, row.newest_at);
  }
  return { state: "counted", reason: null, complete, new: first, revised, newestAt };
}

/** A source's line, with the sections the grant cannot read as null. */
function line(source: string, entry: Draft, evidence: boolean): ChangesSinceSourceLine {
  return {
    source,
    cut: CHANGES_SINCE_SECTIONS.filter((section) => entry.cut.has(section)),
    runs: evidence ? entry.runs : null,
    captures: evidence ? entry.captures : null,
    parses: entry.parses,
    observations: entry.observations,
    newestRunAt:
      evidence && entry.newestRunAtMs !== null ? new Date(entry.newestRunAtMs).toISOString() : null,
    newestSealedRunId:
      evidence && entry.newestSealedRun !== null ? `r_${entry.newestSealedRun}` : null,
    newestParsedAt: entry.newestParsedAt,
    newestParsedArtifactId: entry.newestParsedArtifactId,
  };
}

/** Nothing new in any counted section, and no count cut. */
function unchanged(entry: ChangesSinceSourceLine): boolean {
  const none = (counts: readonly number[] | null) =>
    counts === null || counts.every((n) => n === 0);
  return (
    entry.cut.length === 0 &&
    none(entry.runs) &&
    (entry.captures === null || entry.captures === 0) &&
    none(entry.parses) &&
    none(entry.observations)
  );
}

const bytes = (answer: ChangesSince): number =>
  new TextEncoder().encode(JSON.stringify({ apiVersion: 2, ...answer })).length;

/**
 * The digest for one grant and request, or the typed refusal. The grant is
 * decided before the request is checked, and both before the store is read.
 */
export async function readChangesSince(input: {
  grant: Grant;
  sql: SqlExecutor;
  served: ChangesSinceServed;
  request: ChangesSinceRequest;
  /** An ISO instant; `since` may be at most `CHANGES_SINCE_MAX_DAYS` before it, never after. */
  now: string;
}): Promise<ChangesSinceOutcome> {
  const { grant, sql, served, request, now } = input;
  const fail = (code: FinancialErrorCode, refs: string[]): ChangesSinceOutcome => ({
    ok: false,
    error: financialError(code, REQUEST_ID, refs),
  });
  if (!grantAllows(grant, "records.read")) return fail("unauthorized", ["capability:records.read"]);
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  if (narrowed.length > 0) return fail("evidence_restricted", narrowed);
  const instant = Date.parse(now);
  if (!Number.isFinite(instant)) throw new RangeError("now is not an instant");
  const checked = checkedSince(request.since, instant);
  if ("refusal" in checked) return fail("invalid_query", [checked.refusal]);
  const after = request.after ?? null;
  if (after !== null && (typeof after !== "string" || !CHANGES_SINCE_SOURCE.test(after)))
    return fail("invalid_query", ["after:format"]);
  const since = checked.since;
  const evidence = grantAllows(grant, CHANGES_SINCE_HANDLER_CAPABILITIES.runs);

  const sources = (
    await sql.all<SourceRow>(CHANGES_SINCE_SOURCES_SQL, [
      after ?? "",
      CHANGES_SINCE_SOURCE_BOUND + 1,
    ])
  ).map((row) => row.id);
  if (sources.length > CHANGES_SINCE_SOURCE_BOUND) return fail("budget_exceeded", ["sources"]);
  const drafts = new Map(sources.map((source) => [source, draft()]));
  const sourcesJson = JSON.stringify(sources);
  if (sources.length > 0) {
    if (evidence) await readRuns(sql, drafts, sourcesJson, Date.parse(since));
    await readParses(sql, drafts, sourcesJson, since);
  }
  const events = await readEvents(sql, since, served);

  const answer: ChangesSince = {
    schemaVersion: "kogane-changes-since-v1",
    since,
    asOf: new Date(instant).toISOString(),
    after,
    basis: "recorded",
    bounds: {
      maxDays: CHANGES_SINCE_MAX_DAYS,
      sources: CHANGES_SINCE_SOURCE_BOUND,
      runWalk: CHANGES_SINCE_RUN_WALK,
      captures: CHANGES_SINCE_CAPTURE_BOUND,
      parseWalk: CHANGES_SINCE_PARSE_WALK,
      observations: CHANGES_SINCE_OBSERVATION_BOUND,
      eventWalk: CHANGES_SINCE_EVENT_WALK,
      maxBytes: CHANGES_SINCE_MAX_BYTES,
    },
    order: {
      runs: CHANGES_SINCE_RUN_STATUSES,
      parses: CHANGES_SINCE_PARSE_STATES,
      observations: CHANGES_SINCE_OBSERVATION_KINDS,
      events: ECONOMIC_EVENT_KINDS,
    },
    sections: {
      runs: evidence ? "counted" : "unauthorized",
      captures: evidence ? "counted" : "unauthorized",
      parses: "counted",
      observations: "counted",
    },
    sources: [],
    unchanged: [],
    next: null,
    events,
    handlers: CHANGES_SINCE_HANDLERS,
    notCovered: CHANGES_SINCE_NOT_COVERED,
  };
  // Sources in id order until the next one would pass the byte bound, which
  // is measured with the continuation the answer would then carry.
  let last: string | null = null;
  for (const source of sources) {
    const entry = line(source, drafts.get(source)!, evidence);
    const quiet = unchanged(entry);
    if (quiet) answer.unchanged.push(source);
    else answer.sources.push(entry);
    if (bytes({ ...answer, next: { after: source } }) <= CHANGES_SINCE_MAX_BYTES) {
      last = source;
      continue;
    }
    if (quiet) answer.unchanged.pop();
    else answer.sources.pop();
    // One line is far below the bound; an answer that cannot hold one is a defect.
    if (last === null) throw new RangeError("changes digest header exceeds its byte bound");
    answer.next = { after: last };
    break;
  }
  return { ok: true, answer };
}
