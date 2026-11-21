// The "changes since a time" digest (ADR 0127) on the complete CORE schema:
// what it counts per source and per state against a reference that reads the
// base tables whole, the grant and request refusals before any read, the
// walk and count bounds, the byte bound and its continuation, the handlers'
// capabilities, the plans without table statistics, and that it writes
// nothing. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  CHANGES_SINCE_CAPTURE_BOUND,
  CHANGES_SINCE_EVENT_WALK,
  CHANGES_SINCE_HANDLERS,
  CHANGES_SINCE_MAX_BYTES,
  CHANGES_SINCE_OBSERVATION_BOUND,
  CHANGES_SINCE_OBSERVATION_KINDS,
  CHANGES_SINCE_PARSE_STATES,
  CHANGES_SINCE_PARSE_WALK,
  CHANGES_SINCE_RUN_STATUSES,
  CHANGES_SINCE_RUN_WALK,
  CHANGES_SINCE_SOURCE_BOUND,
  ECONOMIC_EVENT_KINDS,
  type ChangesSince,
  type ChangesSinceSourceLine,
} from "../../domain/src/changes-since.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import { validChangesSince } from "../../observation-shared/src/changes-since-contract.ts";
import { fullGrant, type Grant } from "../src/grants.ts";
import { OPERATION_CATALOGUE, type OperationName } from "../src/operation-path/catalogue.ts";
import {
  CHANGES_SINCE_EVENTS_SQL,
  CHANGES_SINCE_HANDLER_CAPABILITIES,
  CHANGES_SINCE_PARSES_SQL,
  CHANGES_SINCE_RUNS_SQL,
  CHANGES_SINCE_SOURCES_SQL,
  readChangesSince,
  type ChangesSinceRequest,
  type ChangesSinceServed,
} from "../src/query/changes-since.ts";
import { ChangesWorld, type ParseState, type RunState, type Rows } from "./changes-since-world.ts";
import { migratedDatabase } from "./sqlite-store.ts";

const NOW = "2099-03-02T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const SINCE = "2099-03-01T00:00:00.000Z";
const SINCE_MS = Date.parse(SINCE);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const FULL = fullGrant("synthetic-owner");
/** The browser's reader grant: records and evidence over the whole store. */
const READER: Grant = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read", "evidence.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};

function executor(db: Database, seen: string[] = []): SqlExecutor {
  return {
    all: async <T>(text: string, args: readonly unknown[]) => {
      seen.push(text);
      return db.query(text).all(...(args as SQLQueryBindings[])) as T[];
    },
    first: async <T>(text: string, args: readonly unknown[]) => {
      seen.push(text);
      return (db.query(text).get(...(args as SQLQueryBindings[])) as T | null) ?? null;
    },
  };
}

/** An executor that must not be called. */
const untouched: SqlExecutor = {
  all: async () => {
    throw new Error("read before the refusal");
  },
  first: async () => {
    throw new Error("read before the refusal");
  },
};

async function changes(
  sql: SqlExecutor,
  options: {
    grant?: Grant;
    served?: ChangesSinceServed;
    request?: ChangesSinceRequest;
    now?: string;
  } = {},
): Promise<ChangesSince> {
  const outcome = await readChangesSince({
    grant: options.grant ?? FULL,
    sql,
    served: options.served ?? { events: true },
    request: options.request ?? { since: SINCE },
    now: options.now ?? NOW,
  });
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code} ${outcome.error.refs}`);
  const body = { apiVersion: 2, ...outcome.answer };
  // Every answer is one the wire contract admits, under the byte bound.
  expect(validChangesSince(body)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(
    CHANGES_SINCE_MAX_BYTES,
  );
  return outcome.answer;
}

/** Every answer of one walk, following `next.after`. */
async function everyPage(
  sql: SqlExecutor,
): Promise<{ sources: ChangesSinceSourceLine[]; unchanged: string[]; pages: number }> {
  const sources: ChangesSinceSourceLine[] = [];
  const unchanged: string[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const answer = await changes(sql, { request: { since: SINCE, after } });
    sources.push(...answer.sources);
    unchanged.push(...answer.unchanged);
    after = answer.next?.after;
    pages += 1;
  } while (after !== undefined);
  return { sources, unchanged, pages };
}

const lineOf = (answer: ChangesSince, source: string): ChangesSinceSourceLine | undefined =>
  answer.sources.find((entry) => entry.source === source);
const positional = <T extends string>(order: readonly T[], counts: Partial<Record<T, number>>) =>
  order.map((key) => counts[key] ?? 0);

/** Every committed change since the connection opened: a read adds none. */
const changesMade = (db: Database): number =>
  (db.query("SELECT total_changes() AS n").get() as { n: number }).n;

const visibleSources = (db: Database): string[] =>
  (db.query("SELECT id FROM observation_sources ORDER BY id").all() as { id: string }[]).map(
    (row) => row.id,
  );

beforeAll(() => {
  migratedDatabase().close();
}, 60_000);

describe("an empty store", () => {
  test("every visible source is unchanged, the events line counts zero, and nothing is written", async () => {
    const db = migratedDatabase();
    const before = changesMade(db);
    const answer = await changes(executor(db));
    expect(answer.sources).toEqual([]);
    expect(answer.unchanged).toEqual(visibleSources(db));
    expect(answer.next).toBeNull();
    expect(answer.events).toEqual({
      state: "counted",
      reason: null,
      complete: true,
      new: ECONOMIC_EVENT_KINDS.map(() => 0),
      revised: ECONOMIC_EVENT_KINDS.map(() => 0),
      newestAt: null,
    });
    expect(answer.sections).toEqual({
      runs: "counted",
      captures: "counted",
      parses: "counted",
      observations: "counted",
    });
    expect(changesMade(db)).toBe(before);
  });

  test("the events line is not_served where the projection is absent, and its table is not read", async () => {
    const seen: string[] = [];
    const answer = await changes(executor(migratedDatabase(), seen), {
      served: { events: false },
    });
    expect(answer.events).toEqual({
      state: "unavailable",
      reason: "not_served",
      complete: false,
      new: null,
      revised: null,
      newestAt: null,
    });
    expect(seen.some((text) => text.includes("economic_event_revisions"))).toBe(false);
  });
});

describe("the grant and the request", () => {
  const refusal = async (
    options: { grant?: Grant; request?: ChangesSinceRequest; sql?: SqlExecutor } = {},
  ) => {
    const outcome = await readChangesSince({
      grant: options.grant ?? FULL,
      sql: options.sql ?? untouched,
      served: { events: true },
      request: options.request ?? { since: SINCE },
      now: NOW,
    });
    if (outcome.ok) throw new Error("answered");
    return { code: outcome.error.code, refs: outcome.error.refs };
  };

  test("a grant without records.read or over part of the store is refused before any read", async () => {
    expect(
      await refusal({
        grant: { ...READER, capabilities: ["summary.read", "evidence.read"] },
        // Refused before the request is checked as well.
        request: { since: "yesterday" },
      }),
    ).toEqual({ code: "unauthorized", refs: ["capability:records.read"] });
    expect(
      await refusal({ grant: { ...READER, scopes: { sources: ["vpass"], accounts: "*" } } }),
    ).toEqual({ code: "evidence_restricted", refs: ["scope:source"] });
    // What the deployment serves is a schema read: not asked before a refusal.
    for (const [grant, since] of [
      [{ ...READER, capabilities: ["summary.read"] }, SINCE],
      [READER, "yesterday"],
    ] as const) {
      const outcome = await readChangesSince({
        grant,
        sql: untouched,
        served: async () => {
          throw new Error("served asked before the refusal");
        },
        request: { since },
        now: NOW,
      });
      expect(outcome.ok).toBe(false);
    }
    expect(
      await refusal({ grant: { ...READER, scopes: { sources: "*", accounts: ["acct-1"] } } }),
    ).toEqual({ code: "evidence_restricted", refs: ["scope:account"] });
  });

  test("since is an instant with a zone, at most 31 days back and not in the future", async () => {
    for (const since of [
      undefined,
      "",
      "2099-03-01",
      "2099-03-01T00:00:00",
      "2099-03-01 00:00:00Z",
      "2099-02-30T00:00:00Z",
      "2099-03-01T25:00:00Z",
      42,
    ])
      expect(await refusal({ request: { since } })).toEqual({
        code: "invalid_query",
        refs: ["since:format"],
      });
    expect(await refusal({ request: { since: "2099-03-02T00:00:00.001Z" } })).toEqual({
      code: "invalid_query",
      refs: ["since:future"],
    });
    expect(await refusal({ request: { since: iso(NOW_MS - 31 * DAY - 1) } })).toEqual({
      code: "invalid_query",
      refs: ["since:too_old"],
    });
    const db = migratedDatabase();
    // The bounds themselves are allowed, and an offset is read as its instant.
    expect(
      (await changes(executor(db), { request: { since: iso(NOW_MS - 31 * DAY) } })).since,
    ).toBe("2099-01-30T00:00:00.000Z");
    expect((await changes(executor(db), { request: { since: NOW } })).since).toBe(NOW);
    expect(
      (await changes(executor(db), { request: { since: "2099-03-01T09:00+09:00" } })).since,
    ).toBe(SINCE);
  });

  test("after is a source id, and the answer continues past it", async () => {
    for (const after of ["", "Vpass", "a b", 7, "x".repeat(101)])
      expect(await refusal({ request: { since: SINCE, after } })).toEqual({
        code: "invalid_query",
        refs: ["after:format"],
      });
    const db = migratedDatabase();
    const all = visibleSources(db);
    const answer = await changes(executor(db), { request: { since: SINCE, after: "mizuho-bank" } });
    expect(answer.after).toBe("mizuho-bank");
    expect(answer.unchanged).toEqual(all.filter((source) => source > "mizuho-bank"));
    // After the last source, nothing is left.
    expect(
      (await changes(executor(db), { request: { since: SINCE, after: "zzz" } })).unchanged,
    ).toEqual([]);
  });
});

describe("runs and captures", () => {
  test("new runs are counted by their state now, with their captures, the newest time and run", async () => {
    const world = new ChangesWorld();
    world.run("vpass", SINCE_MS - 1, "success", 4);
    const states: RunState[] = [
      "success",
      "success",
      "partial",
      "failed",
      "human_required",
      "cancelled",
      "unknown",
    ];
    const runs = states.map((state, index) =>
      world.run("vpass", SINCE_MS + index * HOUR, state, 2),
    );
    // The newest is still open: counted, but not the run the handler reads.
    world.run("vpass", SINCE_MS + 10 * HOUR, "open", 3);
    // A run recorded exactly at `since` is new.
    world.run("myjcb", SINCE_MS, "success", 1);
    // An excluded run is not a financial run.
    world.run("myjcb", SINCE_MS + HOUR, "success", 5, true);
    const answer = await changes(executor(world.db));
    expect(lineOf(answer, "vpass")).toEqual({
      source: "vpass",
      cut: [],
      runs: positional(CHANGES_SINCE_RUN_STATUSES, {
        success: 2,
        partial: 1,
        failed: 1,
        human_required: 1,
        cancelled: 1,
        unknown: 1,
        open: 1,
      }),
      captures: 17,
      parses: [0, 0, 0, 0, 0],
      observations: [0, 0, 0, 0],
      newestRunAt: iso(SINCE_MS + 10 * HOUR),
      newestSealedRunId: `r_${runs.at(-1)!.run}`,
      newestParsedAt: null,
      newestParsedArtifactId: null,
    });
    expect(lineOf(answer, "myjcb")).toMatchObject({
      runs: positional(CHANGES_SINCE_RUN_STATUSES, { success: 1 }),
      captures: 1,
      newestRunAt: SINCE,
    });
    expect(answer.unchanged).not.toContain("vpass");
  });

  test("more new runs than the walk are a lower bound and say so; exactly the walk is complete", () => {
    const world = new ChangesWorld();
    // Older history the walk never reaches.
    for (let n = 0; n < 3; n += 1) world.run("vpass", SINCE_MS - DAY + n, "success", 0);
    for (let n = 0; n < CHANGES_SINCE_RUN_WALK; n += 1)
      world.run("vpass", SINCE_MS + n * 1000, "success", 0);
    for (let n = 0; n <= CHANGES_SINCE_RUN_WALK; n += 1)
      world.run("myjcb", SINCE_MS + n * 1000, "failed", 0);
    return changes(executor(world.db)).then((answer) => {
      expect(lineOf(answer, "vpass")).toMatchObject({
        cut: [],
        runs: positional(CHANGES_SINCE_RUN_STATUSES, { success: CHANGES_SINCE_RUN_WALK }),
      });
      expect(lineOf(answer, "myjcb")).toMatchObject({
        cut: ["runs", "captures"],
        runs: positional(CHANGES_SINCE_RUN_STATUSES, { failed: CHANGES_SINCE_RUN_WALK }),
      });
    });
  }, 60_000);

  test("without evidence.read the run sections are unauthorized and their tables are not read", async () => {
    const world = new ChangesWorld();
    const { artifacts } = world.run("vpass", SINCE_MS + HOUR, "success", 2);
    world.parse(artifacts[0]!, iso(SINCE_MS + 2 * HOUR), "published", { transaction: 2 });
    world.run("myjcb", SINCE_MS + HOUR, "success", 2);
    const seen: string[] = [];
    const answer = await changes(executor(world.db, seen), {
      grant: { ...READER, capabilities: ["summary.read", "records.read"] },
    });
    expect(answer.sections).toEqual({
      runs: "unauthorized",
      captures: "unauthorized",
      parses: "counted",
      observations: "counted",
    });
    expect(lineOf(answer, "vpass")).toMatchObject({
      runs: null,
      captures: null,
      newestRunAt: null,
      newestSealedRunId: null,
      parses: positional(CHANGES_SINCE_PARSE_STATES, { published: 1 }),
      observations: [2, 0, 0, 0],
    });
    // A run alone is not readable, so its source reads as unchanged.
    expect(answer.unchanged).toContain("myjcb");
    expect(seen.some((text) => text.includes("financial_fetch_runs"))).toBe(false);
  });
});

describe("parses and observations", () => {
  test("new parse runs are counted by state, with the rows a reader may see", async () => {
    const world = new ChangesWorld();
    const old = world.run("sony-bank", SINCE_MS - 2 * DAY, "success", 3);
    world.parse(old.artifacts[0]!, iso(SINCE_MS - DAY), "published", { transaction: 9 });
    const fresh = world.run("sony-bank", SINCE_MS + HOUR, "success", 6);
    const at = (hours: number) => iso(SINCE_MS + hours * HOUR);
    world.parse(fresh.artifacts[0]!, at(2), "published", { transaction: 3, balance: 1 });
    world.parse(fresh.artifacts[1]!, at(3), "superseded", { position: 2, valuation: 2 });
    world.parse(fresh.artifacts[2]!, at(4), "failed", { transaction: 1 });
    // Rows of a pending or unadopted parse are not a result yet.
    world.parse(fresh.artifacts[3]!, at(5), "pending", { transaction: 7 });
    world.parse(fresh.artifacts[4]!, at(6), "unadopted", { balance: 7 });
    // A re-parse of an old capture is new, under the capture's source.
    const reparse = world.parse(old.artifacts[1]!, at(7), "published", { balance: 2 });
    // The parse of an excluded run is not counted.
    const excluded = world.run("sony-bank", SINCE_MS + HOUR, "success", 1, true);
    world.parse(excluded.artifacts[0]!, at(8), "published", { transaction: 50 });
    const answer = await changes(executor(world.db));
    expect(reparse).toBeGreaterThan(0);
    expect(lineOf(answer, "sony-bank")).toMatchObject({
      cut: [],
      // The superseding parse is itself new and unadopted.
      parses: positional(CHANGES_SINCE_PARSE_STATES, {
        published: 2,
        superseded: 1,
        unadopted: 2,
        failed: 1,
        pending: 1,
      }),
      observations: positional(CHANGES_SINCE_OBSERVATION_KINDS, {
        transaction: 4,
        balance: 3,
        position: 2,
        valuation: 2,
      }),
      newestParsedAt: at(7),
      newestParsedArtifactId: old.artifacts[1],
    });
  });

  test("a walk that ends on a new parse run cuts every source's parse and observation counts", () => {
    const world = new ChangesWorld();
    const { artifacts } = world.run("wise", SINCE_MS, "success", 1);
    for (let n = 0; n <= CHANGES_SINCE_PARSE_WALK; n += 1)
      world.parse(artifacts[0]!, iso(SINCE_MS + n), "pending");
    return everyPage(executor(world.db)).then(({ sources, unchanged, pages }) => {
      // Every source may hold more than the walk reached, so none is unchanged,
      // and the lines continue past the first answer.
      expect(unchanged).toEqual([]);
      expect(pages).toBeGreaterThan(1);
      expect(sources.find((entry) => entry.source === "wise")).toMatchObject({
        cut: ["parses", "observations"],
        parses: positional(CHANGES_SINCE_PARSE_STATES, { pending: CHANGES_SINCE_PARSE_WALK }),
      });
      expect(sources.find((entry) => entry.source === "vpass")).toMatchObject({
        cut: ["parses", "observations"],
      });
    });
  }, 120_000);
});

describe("events", () => {
  test("revisions created since are counted per kind, first or later", async () => {
    const world = new ChangesWorld();
    world.event("ev-old", 1, "purchase", iso(SINCE_MS - 1));
    world.event("ev-old", 2, "purchase", iso(SINCE_MS + HOUR));
    world.event("ev-a", 1, "purchase", iso(SINCE_MS + 2 * HOUR));
    world.event("ev-b", 1, "card_settlement", iso(SINCE_MS + 3 * HOUR));
    world.event("ev-b", 2, "card_settlement", iso(SINCE_MS + 4 * HOUR));
    world.event("ev-c", 1, "refund", SINCE);
    const answer = await changes(executor(world.db));
    expect(answer.events).toEqual({
      state: "counted",
      reason: null,
      complete: true,
      new: positional(ECONOMIC_EVENT_KINDS, { purchase: 1, card_settlement: 1, refund: 1 }),
      revised: positional(ECONOMIC_EVENT_KINDS, { purchase: 1, card_settlement: 1 }),
      newestAt: iso(SINCE_MS + 4 * HOUR),
    });
  });

  test("more new revisions than the walk make the line incomplete", () => {
    const world = new ChangesWorld();
    for (let n = 0; n <= CHANGES_SINCE_EVENT_WALK; n += 1)
      world.event(`ev-${n}`, 1, "purchase", iso(SINCE_MS + n));
    return changes(executor(world.db)).then((answer) => {
      expect(answer.events).toMatchObject({
        complete: false,
        new: positional(ECONOMIC_EVENT_KINDS, { purchase: CHANGES_SINCE_EVENT_WALK }),
      });
    });
  }, 60_000);
});

/** An executor that answers each digest query with the rows given, and the registry with `sources`. */
function scripted(
  sources: readonly string[],
  rows: { runs?: unknown[]; parses?: unknown[]; events?: unknown[] },
): SqlExecutor {
  return {
    all: async <T>(text: string, args: readonly unknown[]) => {
      if (text === CHANGES_SINCE_SOURCES_SQL)
        return sources
          .filter((source) => source > (args[0] as string))
          .slice(0, args[1] as number)
          .map((id) => ({ id })) as T[];
      if (text === CHANGES_SINCE_RUNS_SQL) return (rows.runs ?? []) as T[];
      if (text === CHANGES_SINCE_PARSES_SQL) return (rows.parses ?? []) as T[];
      if (text === CHANGES_SINCE_EVENTS_SQL) return (rows.events ?? []) as T[];
      throw new Error("unexpected query");
    },
    first: async () => {
      throw new Error("unexpected query");
    },
  };
}

describe("count bounds", () => {
  test("captures or observation rows past their bound cut every source that has them", async () => {
    const status = (source: string, n: number) => ({
      source_id: source,
      row_kind: "status",
      status: "success",
      n,
      newest_at: SINCE_MS + HOUR,
      newest_id: 7,
    });
    const answer = await changes(
      scripted(["alpha", "beta", "gamma"], {
        runs: [
          status("alpha", 1),
          status("beta", 1),
          {
            source_id: "alpha",
            row_kind: "captures",
            status: null,
            n: CHANGES_SINCE_CAPTURE_BOUND,
          },
          { source_id: "beta", row_kind: "captures", status: null, n: 1 },
        ],
        parses: [
          { source_id: null, row_kind: "cut", state: null, n: 0, newest_at: null, newest_id: null },
          {
            source_id: "beta",
            row_kind: "status",
            state: "published",
            n: 1,
            newest_at: SINCE,
            newest_id: null,
          },
          {
            source_id: "beta",
            row_kind: "newest",
            state: null,
            n: 0,
            newest_at: null,
            newest_id: 9,
          },
          {
            source_id: "beta",
            row_kind: "observations",
            state: "balance",
            n: CHANGES_SINCE_OBSERVATION_BOUND + 1,
            newest_at: null,
            newest_id: null,
          },
        ],
        events: [{ row_kind: "cut", kind: null, change: null, n: 0, newest_at: null }],
      }),
    );
    expect(answer.sources.map((entry) => [entry.source, entry.cut])).toEqual([
      ["alpha", ["captures"]],
      ["beta", ["captures", "observations"]],
    ]);
    expect(answer.unchanged).toEqual(["gamma"]);
  });

  test("more visible sources than the bound are refused, never cut", async () => {
    const many = Array.from({ length: CHANGES_SINCE_SOURCE_BOUND + 1 }, (_, n) => `s-${1000 + n}`);
    const outcome = await readChangesSince({
      grant: FULL,
      sql: scripted(many, {}),
      served: { events: false },
      request: { since: SINCE },
      now: NOW,
    });
    expect(outcome.ok ? null : [outcome.error.code, outcome.error.refs]).toEqual([
      "budget_exceeded",
      ["sources"],
    ]);
  });
});

describe("the byte bound", () => {
  test("twenty sources with many runs a day answer under 8 KB in one call", async () => {
    const world = new ChangesWorld();
    const sources = visibleSources(world.db).slice(0, 20);
    const states: RunState[] = ["success", "success", "success", "partial", "failed", "open"];
    const parses: ParseState[] = ["published", "published", "superseded", "failed", "pending"];
    const rows: Rows = { transaction: 6, balance: 2, position: 1, valuation: 1 };
    // A day before `since` and the day since: a run every hour per source,
    // each with three captures, each parsed once.
    for (let hour = -24; hour < 24; hour += 1)
      for (const [index, source] of sources.entries()) {
        const at = SINCE_MS + hour * HOUR + index * 1000;
        const { artifacts } = world.run(
          source,
          at,
          states[(hour + 24 + index) % states.length]!,
          3,
        );
        for (const [n, artifact] of artifacts.entries())
          world.parse(
            artifact,
            iso(at + 60_000 + n),
            parses[(hour + 24 + n) % parses.length]!,
            rows,
          );
      }
    for (let n = 0; n < 40; n += 1)
      world.event(`ev-${n}`, 1 + (n % 2), ECONOMIC_EVENT_KINDS[n % 8]!, iso(SINCE_MS + n * HOUR));
    const answer = await changes(executor(world.db));
    const size = new TextEncoder().encode(JSON.stringify({ apiVersion: 2, ...answer })).length;
    console.info("changes since: twenty busy sources", { bytes: size });
    expect(answer.next).toBeNull();
    expect(answer.sources.map((entry) => entry.source)).toEqual(sources);
    expect(answer.sources.every((entry) => entry.cut.length === 0)).toBe(true);
    expect(lineOf(answer, sources[0]!)!.runs!.reduce((sum, n) => sum + n, 0)).toBe(24);
    expect(size).toBeLessThan(CHANGES_SINCE_MAX_BYTES);
  }, 120_000);

  test("the largest lines continue across answers, each under the bound, every source once", async () => {
    // The longest source ids the charset allows, every count at its largest.
    const sources = Array.from(
      { length: CHANGES_SINCE_SOURCE_BOUND },
      (_, n) => `${String(n).padStart(3, "0")}-${"x".repeat(96)}`,
    );
    const big = 9_007_199_254_740_991;
    const runs = sources.flatMap((source) => [
      { source_id: source, row_kind: "cut", status: null, n: 1, newest_at: null, newest_id: null },
      ...CHANGES_SINCE_RUN_STATUSES.map((status) => ({
        source_id: source,
        row_kind: "status",
        status,
        n: big,
        newest_at: SINCE_MS + 999,
        newest_id: big,
      })),
      { source_id: source, row_kind: "captures", status: null, n: big },
    ]);
    const parses = [
      { source_id: null, row_kind: "cut", state: null, n: 1, newest_at: null, newest_id: null },
      ...sources.flatMap((source) => [
        ...CHANGES_SINCE_PARSE_STATES.map((state) => ({
          source_id: source,
          row_kind: "status",
          state,
          n: big,
          newest_at: "2099-03-01T23:59:59.999Z",
          newest_id: null,
        })),
        {
          source_id: source,
          row_kind: "newest",
          state: null,
          n: 0,
          newest_at: null,
          newest_id: big,
        },
        ...CHANGES_SINCE_OBSERVATION_KINDS.map((state) => ({
          source_id: source,
          row_kind: "observations",
          state,
          n: big,
          newest_at: null,
          newest_id: null,
        })),
      ]),
    ];
    const sql = scripted(sources, { runs, parses, events: [] });
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const answer = await changes(sql, { request: { since: SINCE, after } });
      expect(answer.sources.length).toBeGreaterThan(0);
      seen.push(...answer.sources.map((entry) => entry.source), ...answer.unchanged);
      after = answer.next?.after;
      pages += 1;
    } while (after !== undefined);
    expect(seen).toEqual(sources);
    expect(pages).toBeGreaterThan(1);
  });
});

/** The digest's per-source counts read from the base tables whole: no walk, no bound. */
function reference(
  db: Database,
  since: string,
): Map<string, Omit<ChangesSinceSourceLine, "source">> {
  const sinceMs = Date.parse(since);
  const out = new Map<string, Omit<ChangesSinceSourceLine, "source">>();
  for (const source of visibleSources(db)) {
    const runs = db
      .query(
        `SELECT r.id, r.first_recorded_at_ms AS at,
          CASE WHEN s.fetch_run_id IS NULL OR t.normalized_outcome IS NULL THEN 'open' ELSE t.normalized_outcome END AS status,
          (SELECT count(*) FROM fetch_artifacts a WHERE a.fetch_run_id = r.id) AS artifacts
         FROM financial_fetch_runs r LEFT JOIN fetch_run_seals s ON s.fetch_run_id = r.id
         LEFT JOIN fetch_run_reports t ON t.fetch_run_id = r.id AND t.report_kind = 'terminal'
         WHERE r.source_id = ? AND r.first_recorded_at_ms >= ?`,
      )
      .all(source, sinceMs) as { id: number; at: number; status: string; artifacts: number }[];
    const parses = db
      .query(
        `SELECT p.id, p.fetch_artifact_id AS artifact, p.parsed_at AS at,
          CASE WHEN p.status = 'pending' THEN 'pending' WHEN p.status = 'error' THEN 'failed'
           WHEN pp.parse_run_id IS NOT NULL THEN 'published'
           WHEN p.superseded_by_parse_run_id IS NOT NULL THEN 'superseded' ELSE 'unadopted' END AS state
         FROM parse_runs p JOIN fetch_artifacts a ON a.id = p.fetch_artifact_id
         JOIN financial_fetch_runs r ON r.id = a.fetch_run_id
         LEFT JOIN published_parse_runs pp ON pp.parse_run_id = p.id
         WHERE a.source_id = ? AND p.parsed_at >= ?`,
      )
      .all(source, since) as { id: number; artifact: number; at: string; state: string }[];
    const recorded = parses.filter((parse) =>
      ["published", "superseded", "failed"].includes(parse.state),
    );
    const observations = CHANGES_SINCE_OBSERVATION_KINDS.map((kind) =>
      recorded.reduce(
        (sum, parse) =>
          sum +
          (
            db
              .query(`SELECT count(*) AS n FROM ${kind}_observations WHERE parse_run_id = ?`)
              .get(parse.id) as { n: number }
          ).n,
        0,
      ),
    );
    const sealed = runs.filter((run) => run.status !== "open");
    const newestRecorded = recorded.reduce<(typeof recorded)[number] | null>(
      (best, parse) => (best === null || parse.id > best.id ? parse : best),
      null,
    );
    out.set(source, {
      cut: [],
      runs: CHANGES_SINCE_RUN_STATUSES.map(
        (status) => runs.filter((run) => run.status === status).length,
      ),
      captures: runs.reduce((sum, run) => sum + run.artifacts, 0),
      parses: CHANGES_SINCE_PARSE_STATES.map(
        (state) => parses.filter((parse) => parse.state === state).length,
      ),
      observations,
      newestRunAt: runs.length ? iso(Math.max(...runs.map((run) => run.at))) : null,
      newestSealedRunId: sealed.length ? `r_${Math.max(...sealed.map((run) => run.id))}` : null,
      newestParsedAt: parses.length
        ? parses
            .map((parse) => parse.at)
            .sort()
            .at(-1)!
        : null,
      newestParsedArtifactId: newestRecorded?.artifact ?? null,
    });
  }
  return out;
}

/** A small deterministic generator, so a failing seed can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("against the base tables on random stores", () => {
  for (const seed of [1, 7, 23, 101]) {
    test(`seed ${seed}: every source's counts and newest values equal a whole read`, async () => {
      const next = random(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
      const world = new ChangesWorld();
      const sources = visibleSources(world.db).filter(() => next() < 0.4);
      // Everything happens in recording order, from three days before `since`.
      type Step = { at: number; act: () => void };
      const artifacts: { id: number; at: number }[] = [];
      const steps: Step[] = [];
      for (const source of sources)
        for (let n = Math.floor(next() * 8); n > 0; n -= 1) {
          const at = SINCE_MS - 3 * DAY + Math.floor(next() * 4 * DAY) - HOUR;
          const state = pick(CHANGES_SINCE_RUN_STATUSES);
          const count = Math.floor(next() * 4);
          const excluded = next() < 0.1;
          steps.push({
            at,
            act: () => {
              const run = world.run(source, at, state, count, excluded);
              for (const id of run.artifacts) artifacts.push({ id, at });
            },
          });
        }
      steps.sort((a, b) => a.at - b.at);
      for (const step of steps) step.act();
      // Parses after their capture, again in recording order.
      const parses = artifacts
        .flatMap((artifact) =>
          Array.from({ length: Math.floor(next() * 3) }, () => ({
            artifact: artifact.id,
            at: Math.min(NOW_MS - 1, artifact.at + Math.floor(next() * DAY)),
            state: pick(CHANGES_SINCE_PARSE_STATES),
            rows: {
              transaction: Math.floor(next() * 3),
              balance: Math.floor(next() * 2),
              position: Math.floor(next() * 2),
              valuation: Math.floor(next() * 2),
            },
          })),
        )
        .sort((a, b) => a.at - b.at);
      for (const parse of parses)
        world.parse(parse.artifact, iso(parse.at), parse.state, parse.rows);
      const answer = await changes(executor(world.db));
      const expected = reference(world.db, SINCE);
      for (const source of visibleSources(world.db)) {
        const line = lineOf(answer, source);
        if (line === undefined) {
          expect(answer.unchanged).toContain(source);
          const want = expected.get(source)!;
          expect(
            [...want.runs!, want.captures!, ...want.parses, ...want.observations].every(
              (n) => n === 0,
            ),
          ).toBe(true);
        } else expect({ source, ...expected.get(source)! }).toEqual(line);
      }
    });
  }
});

describe("handlers", () => {
  test("each handler's capability is its read tool's catalogue capability, and the tool exists", () => {
    for (const [name, handler] of Object.entries(CHANGES_SINCE_HANDLERS)) {
      const operation = handler.tool.slice("kogane.".length) as OperationName;
      expect(Object.hasOwn(OPERATION_CATALOGUE, operation)).toBe(true);
      expect({ name, capability: OPERATION_CATALOGUE[operation].capability }).toEqual({
        name,
        capability: CHANGES_SINCE_HANDLER_CAPABILITIES[name as keyof typeof CHANGES_SINCE_HANDLERS],
      });
    }
    expect(OPERATION_CATALOGUE["changes.since"]).toEqual({
      risk: ["R0"],
      effect: null,
      quiet: "read",
      capability: "records.read",
      paths: ["agent-http", "mcp"],
    });
  });
});

describe("plans without table statistics", () => {
  /**
   * The only relations a plan may scan whole: its own CTEs and subqueries,
   * the request's source list, and the two rowid walks (`p`, the newest parse
   * runs; `e`, the newest event revisions), each under its LIMIT.
   */
  const ALLOWED = new Set([
    "b",
    "f",
    "c",
    "w",
    "r",
    "o",
    "s",
    "fresh",
    "recorded",
    "json_each",
    "CONSTANT",
    "p",
    "e",
  ]);
  test("every table is reached by key or by one index range, and no table statistics exist", () => {
    const db = migratedDatabase();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    for (const [name, text, binds, required] of [
      ["sources", CHANGES_SINCE_SOURCES_SQL, ["", 201], ["sqlite_autoindex_sources_1"]],
      [
        "runs",
        CHANGES_SINCE_RUNS_SQL,
        ['["vpass"]', SINCE_MS, 500, 20_001],
        [
          "idx_fetch_runs_source (source_id=?)",
          "idx_fetch_runs_source (source_id=? AND id>?)",
          "idx_fetch_artifacts_run_role",
          "idx_fetch_run_reports_one_terminal",
        ],
      ],
      [
        "parses",
        CHANGES_SINCE_PARSES_SQL,
        ['["vpass"]', SINCE, 5000, 50_001],
        [
          "SEARCH a USING INTEGER PRIMARY KEY",
          "published_parse_runs_run",
          "idx_txn_obs_parse_run",
          "idx_bal_obs_parse_run",
          "idx_pos_obs_parse_run",
          "idx_val_obs_parse_run",
        ],
      ],
      ["events", CHANGES_SINCE_EVENTS_SQL, [SINCE, 2000], []],
    ] as const) {
      const steps = explain(db, text, binds).map((step) => step.detail);
      const scans = steps
        .filter((detail) => detail.startsWith("SCAN "))
        .map((detail) => detail.slice(5).split(" ")[0]!)
        // A subquery of the text (its numbering follows the text) is its own relation.
        .filter((target) => !ALLOWED.has(target) && !target.startsWith("(subquery-"));
      expect({ name, scans }).toEqual({ name, scans: [] });
      for (const index of required)
        expect({ name, index, used: steps.some((detail) => detail.includes(index)) }).toEqual({
          name,
          index,
          used: true,
        });
      // A walk reads in its table's own order: no sort of a whole table.
      expect({
        name,
        sorted: steps.filter((detail) => detail.includes("TEMP B-TREE FOR ORDER BY")).length,
      }).toEqual({ name, sorted: name === "parses" ? 1 : 0 });
    }
  });

  test("the two whole-table scans are the rowid walks, each under its LIMIT", () => {
    // `p` and `e` scan in rowid order and stop at the walk's LIMIT or OFFSET.
    expect(CHANGES_SINCE_PARSES_SQL).toContain("FROM parse_runs p ORDER BY p.id DESC LIMIT ?3");
    expect(CHANGES_SINCE_PARSES_SQL).toContain(
      "FROM parse_runs p ORDER BY p.id DESC LIMIT 1 OFFSET ?3",
    );
    expect(CHANGES_SINCE_EVENTS_SQL).toContain(
      "FROM economic_event_revisions e ORDER BY e.rowid DESC LIMIT ?2",
    );
    expect(CHANGES_SINCE_EVENTS_SQL).toContain(
      "FROM economic_event_revisions e ORDER BY e.rowid DESC LIMIT 1 OFFSET ?2",
    );
  });
});
