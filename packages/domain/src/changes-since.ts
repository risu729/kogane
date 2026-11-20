// The closed vocabulary of the "changes since a time" digest (ADR 0127,
// packages/application/src/query/changes-since.ts): what it counts per
// source, the order of its positional counts, its bounds, the existing read
// tools that show the items behind each count, and the answer's shape. The
// wire contract (packages/observation-shared/src/changes-since-contract.ts)
// reads the same lists, so a client never sees a code the digest cannot
// produce.
import { ECONOMIC_EVENT_KINDS } from "./events.ts";

export { ECONOMIC_EVENT_KINDS };

/**
 * A new fetch run's state now: its terminal report's outcome once the run is
 * sealed (the evidence browser's `outcome`), else `open` (no seal or no
 * terminal report yet). `runs` counts are listed in this order.
 */
export const CHANGES_SINCE_RUN_STATUSES = [
  "success",
  "partial",
  "failed",
  "human_required",
  "cancelled",
  "unknown",
  "open",
] as const;

/**
 * A new parse run's state now: `published` (adopted), `superseded` (replaced
 * by a later publication), `unadopted` (a successful run neither published
 * nor superseded: a candidate no normal read shows), `failed` and `pending`.
 * `parses` counts are listed in this order.
 */
export const CHANGES_SINCE_PARSE_STATES = [
  "published",
  "superseded",
  "unadopted",
  "failed",
  "pending",
] as const;

/**
 * The observation kinds counted: the store overview's four (rows of the new
 * parse runs a reader may see: published, superseded or failed). `observations`
 * counts are listed in this order.
 */
export const CHANGES_SINCE_OBSERVATION_KINDS = [
  "transaction",
  "balance",
  "position",
  "valuation",
] as const;

/** The per-source sections; each is counted, or null when the grant cannot read its handler. */
export const CHANGES_SINCE_SECTIONS = ["runs", "captures", "parses", "observations"] as const;
export type ChangesSinceSection = (typeof CHANGES_SINCE_SECTIONS)[number];

/** Why a section or the events line has no count. */
export const CHANGES_SINCE_UNAVAILABLE = ["unauthorized", "not_served"] as const;
type ChangesSinceUnavailable = (typeof CHANGES_SINCE_UNAVAILABLE)[number];

/** How far back `since` may be (days of 24 hours before the read). */
export const CHANGES_SINCE_MAX_DAYS = 31;
/** Visible sources read at most; more is refused (`budget_exceeded`), never cut. */
export const CHANGES_SINCE_SOURCE_BOUND = 200;
/** The newest financial fetch runs read per source; more new ones cut `runs` and `captures`. */
export const CHANGES_SINCE_RUN_WALK = 500;
/** Artifact rows of the new runs counted across the sources of one answer; more cut `captures`. */
export const CHANGES_SINCE_CAPTURE_BOUND = 20_000;
/** The newest parse runs read store-wide; more new ones cut `parses` and `observations`. */
export const CHANGES_SINCE_PARSE_WALK = 5_000;
/** Observation rows counted per kind across the sources of one answer; more cut `observations`. */
export const CHANGES_SINCE_OBSERVATION_BOUND = 50_000;
/** The newest event revisions read; more new ones make the events line incomplete. */
export const CHANGES_SINCE_EVENT_WALK = 2_000;
/** The answer's size bound (an MCP client shows the first 8 KB); lines past it continue with `after`. */
export const CHANGES_SINCE_MAX_BYTES = 8_192;

/**
 * Queues and changes the digest does not count, each with the closed reason
 * why (ADR 0127). A kind is added to the digest with its bounded read, or
 * listed here.
 */
export const CHANGES_SINCE_NOT_COVERED = [
  // Terminals that never registered as fetch runs (`collection_runs`): the
  // table has no index by time; collection-quality reads them per source.
  { kind: "collection.unregistered-terminal", reason: "no_time_index" },
  // Scheduled payment, identity and price observations: other pipelines,
  // not part of the store overview's four kinds.
  { kind: "observation.other-kinds", reason: "not_counted" },
  // What a value changed to: the digest counts rows, it never compares
  // amounts; reported-holdings-change.read does.
  { kind: "value.change", reason: "amounts_not_compared" },
] as const;

/**
 * Where the items behind a count are read: the existing read `tool` with its
 * fixed `arguments`. A line's `source` goes in `sourceArgument`; the answer's
 * `since` goes in `sinceArgument`; the value of the line field
 * `idArgument.field` goes in the argument `idArgument.name`; for
 * observations, the value at a kind's position in `kindArgument.values` goes
 * in `kindArgument.name`. A key is absent where it does not apply.
 */
export interface ChangesSinceHandler {
  tool: string;
  arguments: Readonly<Record<string, string>>;
  sourceArgument?: string;
  sinceArgument?: string;
  idArgument?: { name: string; field: "newestSealedRunId" | "newestParsedArtifactId" };
  kindArgument?: { name: string; values: readonly string[] };
}

/** The handler of each section, of the events line and of an unchanged source. */
export const CHANGES_SINCE_HANDLERS = {
  // A source's sealed runs, newest first.
  runs: { tool: "kogane.evidence.read", arguments: { page: "runs" }, sourceArgument: "source" },
  // The newest sealed new run's artifacts.
  captures: {
    tool: "kogane.evidence.read",
    arguments: { page: "artifacts" },
    idArgument: { name: "runId", field: "newestSealedRunId" },
  },
  // The artifact of the newest new parse a reader may see, with its parse runs.
  parses: {
    tool: "kogane.observations.get",
    arguments: { kind: "artifact" },
    idArgument: { name: "id", field: "newestParsedArtifactId" },
  },
  // The source's lists; valuations are listed with their positions.
  observations: {
    tool: "kogane.observations.list",
    arguments: {},
    sourceArgument: "source",
    kindArgument: { name: "kind", values: ["transactions", "balances", "positions", "positions"] },
  },
  // The current revisions recorded since, one basis a call (ADR 0081,
  // amendment of 2026-11-20).
  events: {
    tool: "kogane.events.read",
    arguments: { collection: "activity" },
    sinceArgument: "since",
  },
  // Why a source has nothing new: its jobs, latest runs and failures.
  unchanged: { tool: "kogane.collection-quality.read", arguments: {}, sourceArgument: "source" },
} as const satisfies Record<string, ChangesSinceHandler>;
export type ChangesSinceHandlerName = keyof typeof CHANGES_SINCE_HANDLERS;

/** One source with something new, or with a count cut at its bound. */
export interface ChangesSinceSourceLine {
  source: string;
  /** Sections whose counts are lower bounds (a walk or a count reached its bound). */
  cut: ChangesSinceSection[];
  /** New fetch runs per `CHANGES_SINCE_RUN_STATUSES`; null when the section is unauthorized. */
  runs: number[] | null;
  /** Artifacts of the new runs; null when the section is unauthorized. */
  captures: number | null;
  /** New parse runs per `CHANGES_SINCE_PARSE_STATES`. */
  parses: number[];
  /** Observation rows of the new parse runs per `CHANGES_SINCE_OBSERVATION_KINDS`. */
  observations: number[];
  /** When the newest new run was first recorded; null when none is new or `runs` is unauthorized. */
  newestRunAt: string | null;
  /** The newest sealed new run, as the evidence browser names it (`r_<id>`). */
  newestSealedRunId: string | null;
  /** When the newest new parse run was recorded; null when none is new. */
  newestParsedAt: string | null;
  /** The artifact of the newest new parse run a reader may see (published, superseded or failed). */
  newestParsedArtifactId: number | null;
}

export interface ChangesSinceEvents {
  state: "counted" | "unavailable";
  /** Null when counted. */
  reason: ChangesSinceUnavailable | null;
  /** False when more new revisions exist than the walk reads, or the line is unavailable. */
  complete: boolean;
  /** First revisions recorded since, per `ECONOMIC_EVENT_KINDS`; null when unavailable. */
  new: number[] | null;
  /** Later revisions recorded since (an event changed), per `ECONOMIC_EVENT_KINDS`. */
  revised: number[] | null;
  newestAt: string | null;
}

export interface ChangesSince {
  schemaVersion: "kogane-changes-since-v1";
  /** The instant asked, canonical (ISO 8601, UTC, milliseconds). */
  since: string;
  /** The instant the bounds on `since` were judged at. */
  asOf: string;
  /** The source the answer continues after; null on a first page. */
  after: string | null;
  /** What "new" means: recorded in the store at or after `since`, in recording order. */
  basis: "recorded";
  bounds: {
    maxDays: number;
    sources: number;
    runWalk: number;
    captures: number;
    parseWalk: number;
    observations: number;
    eventWalk: number;
    maxBytes: number;
  };
  /** The order of the positional counts. */
  order: {
    runs: typeof CHANGES_SINCE_RUN_STATUSES;
    parses: typeof CHANGES_SINCE_PARSE_STATES;
    observations: typeof CHANGES_SINCE_OBSERVATION_KINDS;
    events: typeof ECONOMIC_EVENT_KINDS;
  };
  /** Each section counted, or not read because the grant cannot read its handler's tool. */
  sections: Record<ChangesSinceSection, "counted" | "unauthorized">;
  /** Sources with something new or cut, in source order. */
  sources: ChangesSinceSourceLine[];
  /** Sources with nothing new in any counted section and no count cut, in source order. */
  unchanged: string[];
  /** Where the next answer starts, when the byte bound stopped this one; null when every source is listed. */
  next: { after: string } | null;
  events: ChangesSinceEvents;
  handlers: typeof CHANGES_SINCE_HANDLERS;
  notCovered: typeof CHANGES_SINCE_NOT_COVERED;
}
