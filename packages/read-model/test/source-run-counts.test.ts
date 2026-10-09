// The `coverage` intent's per-source run counts (`fetchRunCounts`,
// `SOURCE_FETCH_RUN_COUNTS_SQL`) against the read that intent used before:
// the overview's newest-runs window (`OVERVIEW_FETCH_RUNS_SQL`, frozen below
// as shipped and still the operator overview's read), counted per in-scope
// source the way `executeQuery` counted it. On complete-CORE stores with no
// table statistics (D1 never runs `ANALYZE`):
//   * the plan reaches runs through `idx_fetch_runs_source` for the listed
//     sources only and scans no table;
//   * on random stores whose visible runs fit the window, the two reads give
//     the same count for every source and every scope;
//   * past the window, the scoped count stays the exact count and a run of an
//     unlisted source never moves it, while the window drops a quiet source's
//     runs out of its count (the out-of-scope side channel this read closes).
// Every source id is a registered one; every key, run and time is invented.
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createObservationReader, PAGE_LIMIT, type SqlExecutor } from "../src/index";
import * as sql from "../src/sql";
import { explain } from "./card-usage-plan";
import { fullCoreSchema } from "./card-usage-scale-fixture";

/** `OVERVIEW_FETCH_RUNS_SQL` as #239's read model shipped it; never edit by hand. */
const LEGACY_OVERVIEW_FETCH_RUNS_SQL = `SELECT id, source_id, tool, external_run_id, status, started_at, completed_at
  FROM observation_fetch_runs ORDER BY id DESC LIMIT 501`;

const DAY_MS = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00Z");

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

interface Statement {
  text: string;
  args: readonly unknown[];
}

/** A bun:sqlite executor that records every statement the reader sends. */
function recording(db: Database): SqlExecutor & { statements: Statement[] } {
  const statements: Statement[] = [];
  return {
    statements,
    all: async <T>(text: string, args: readonly unknown[]) => {
      statements.push({ text, args });
      return db.query(text).all(...(args as never[])) as T[];
    },
    first: async <T>(text: string, args: readonly unknown[]) => {
      statements.push({ text, args });
      return (db.query(text).get(...(args as never[])) as T | null) ?? null;
    },
  };
}

function random(seed: number): () => number {
  let state = (seed * 2_654_435_761) >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function registeredSources(db: Database): string[] {
  return (
    db.query("SELECT id FROM sources WHERE id <> 'kogane-synthetic' ORDER BY id").all() as {
      id: string;
    }[]
  ).map((row) => row.id);
}

const CLIENT = "synthetic-run-counts";
const PRODUCER = "collector-r2-importer";

type RunKind = "visible" | "partial" | "excluded" | "unsealed";

/**
 * A complete-CORE store (foreign keys on, never analyzed) written the way the
 * ingest Worker writes a run: session, run, inventory, terminal report and
 * seal. Statements are prepared once, so a scaled store costs milliseconds.
 */
class RunStore {
  readonly db: Database = fullCoreSchema();
  private next = 0;
  private readonly routed = new Set<string>();
  private readonly session;
  private readonly fetchRun;
  private readonly inventory;
  private readonly report;
  private readonly seal;
  private readonly annotation;

  constructor() {
    this.db.run("INSERT INTO ingest_clients(id,display_name,active) VALUES(?,'Run counts',1)", [
      CLIENT,
    ]);
    this.db.run("INSERT OR IGNORE INTO producers(id) VALUES(?)", [PRODUCER]);
    this.db.run(
      "INSERT OR IGNORE INTO ingest_client_producers(ingest_client_id,producer_id) VALUES(?,?)",
      [CLIENT, PRODUCER],
    );
    this.session = this.db.prepare(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       VALUES(?1,'${PRODUCER}','${CLIENT}','synthetic-run-counts','session-' || ?1,?2)`,
    );
    this.fetchRun = this.db.prepare(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       VALUES(?1,?2,'${PRODUCER}',?3,'${CLIENT}','default',?4)`,
    );
    this.inventory = this.db.prepare(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
       VALUES(?1,?2,printf('%064x',?1),0,'operator',?3,'${CLIENT}')`,
    );
    this.report = this.db.prepare(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,
        started_at_ms,started_at_basis,completed_at_ms,completed_at_basis,recorded_at_ms)
       VALUES(?1,'terminal','terminal','${CLIENT}',?2,?3,'manifest',?3,'manifest',?3)`,
    );
    this.seal = this.db.prepare(
      `INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id) VALUES(?1,?2,?3,'${CLIENT}')`,
    );
    this.annotation = this.db.prepare(
      "INSERT INTO fetch_run_annotations(fetch_run_id,annotation_kind,reason_code,recorded_at_ms) VALUES(?1,'exclude_from_financial_views','synthetic',0)",
    );
  }

  private route(source: string): void {
    if (this.routed.has(source)) return;
    this.routed.add(source);
    this.db.run("INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES(?,?)", [
      PRODUCER,
      source,
    ]);
    this.db.run(
      "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES(?,?,?)",
      [CLIENT, PRODUCER, source],
    );
  }

  /**
   * `count` runs of `source`, each newer than every run before it. Visible
   * unless `kind` says otherwise: `partial` is visible with a partial
   * outcome, `excluded` is annotated out of financial views, and `unsealed`
   * has neither a terminal report nor a seal.
   */
  add(source: string, kind: RunKind = "visible", count = 1): void {
    this.route(source);
    this.db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const at = START + (this.next += 1) * DAY_MS;
        const session = (this.next += 1);
        const run = (this.next += 1);
        this.session.run(session, at);
        this.fetchRun.run(run, session, source, at);
        if (kind === "unsealed") continue;
        const inventory = (this.next += 1);
        this.inventory.run(inventory, run, at);
        this.report.run(run, kind === "partial" ? "partial" : "success", at);
        this.seal.run(inventory, run, at);
        if (kind === "excluded") this.annotation.run(run);
      }
    })();
  }
}

/** The exact count of visible runs per source, read whole and counted here. */
function exactCounts(db: Database): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db.query("SELECT source_id FROM observation_fetch_runs").all() as {
    source_id: string;
  }[])
    counts.set(row.source_id, (counts.get(row.source_id) ?? 0) + 1);
  return counts;
}

/** The scoped read, as a source → count map with every listed source present. */
async function scopedCounts(db: Database, scope: readonly string[]): Promise<Map<string, number>> {
  const rows = await createObservationReader(recording(db)).fetchRunCounts(scope);
  const counts = new Map(scope.map((source) => [source, 0]));
  for (const row of rows) {
    expect(scope).toContain(row.source_id);
    counts.set(row.source_id, row.run_count);
  }
  return counts;
}

/** What `executeQuery` counted before: the overview's window, filtered to the scope. */
async function windowCounts(db: Database, scope: readonly string[]): Promise<Map<string, number>> {
  const overview = await createObservationReader(recording(db)).overview();
  const counts = new Map(scope.map((source) => [source, 0]));
  for (const run of overview.fetchRuns)
    if (counts.has(run.source_id)) counts.set(run.source_id, counts.get(run.source_id)! + 1);
  return counts;
}

describe("the scoped run count read", () => {
  test("the operator overview still reads the shipped window text", () => {
    expect(sql.OVERVIEW_FETCH_RUNS_SQL).toBe(LEGACY_OVERVIEW_FETCH_RUNS_SQL);
    expect(PAGE_LIMIT).toBe(501);
  });

  test("binds the listed sources as one JSON array and reads nothing for an empty list", async () => {
    const store = new RunStore();
    store.add("sony-bank");
    const executor = recording(store.db);
    const reader = createObservationReader(executor);
    expect(await reader.fetchRunCounts([])).toEqual([]);
    expect(executor.statements).toEqual([]);
    expect(await reader.fetchRunCounts(["sony-bank", "myjcb", "sony-bank"])).toEqual([
      { source_id: "sony-bank", run_count: 1 },
    ]);
    expect(executor.statements).toEqual([
      {
        text: `SELECT * FROM (${sql.SOURCE_FETCH_RUN_COUNTS_SQL}) LIMIT 5001`,
        args: ['["myjcb","sony-bank"]'],
      },
    ]);
  });

  test("its plan reaches runs by idx_fetch_runs_source and scans no table, without statistics", async () => {
    const store = new RunStore();
    for (let index = 0; index < 40; index += 1) store.add(index % 3 === 0 ? "sony-bank" : "myjcb");
    expect(
      store.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").all(),
    ).toEqual([]);
    const executor = recording(store.db);
    await createObservationReader(executor).fetchRunCounts(["sony-bank", "vpass"]);
    const [statement] = executor.statements;
    const plan = explain(store.db, statement!.text, statement!.args);
    const details = plan.map((step) => step.detail);
    expect(details).toContain("SEARCH run USING INDEX idx_fetch_runs_source (source_id=?)");
    // Each run's seal, terminal report, session and exclusion are reached by key.
    for (const keyed of [
      /^SEARCH seal USING (?:COVERING )?INDEX /u,
      /^SEARCH t USING (?:COVERING )?INDEX idx_fetch_run_reports_one_terminal /u,
      /^SEARCH s USING INTEGER PRIMARY KEY /u,
      /^SEARCH annotation USING PRIMARY KEY /u,
    ])
      expect(details.some((detail) => keyed.test(detail))).toBe(true);
    // The only scans are the bound list and the bounded wrapper's own subquery.
    expect(
      details.filter(
        (detail) =>
          detail.startsWith("SCAN ") &&
          !detail.startsWith("SCAN json_each VIRTUAL TABLE") &&
          !/^SCAN \(subquery-\d+\)$/u.test(detail),
      ),
    ).toEqual([]);
    expect(details.some((detail) => detail.includes("AUTOMATIC"))).toBe(false);
    expect(details.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false);
  });
});

const KINDS = ["visible", "visible", "visible", "partial", "excluded", "unsealed"] as const;

/**
 * A random store: 2–6 registered sources, runs of every kind in random order
 * until `visibleTarget` visible runs are written (or a random early stop when
 * `mayStop`), and the scopes a coverage call could ask for: every source, one
 * source, a random subset, and lists naming a registered source with no run.
 */
function randomStore(seed: number, visibleTarget: number, mayStop: boolean) {
  const next = random(seed);
  const store = new RunStore();
  const registered = registeredSources(store.db);
  const sources = registered.filter(() => next() < 0.35).slice(0, 6);
  if (sources.length < 2)
    sources.push(...registered.filter((id) => !sources.includes(id)).slice(0, 2));
  let visible = 0;
  while (visible < visibleTarget) {
    const source = sources[Math.floor(next() * sources.length)]!;
    const kind = KINDS[Math.floor(next() * KINDS.length)]!;
    // Runs of one kind arrive in short bursts, as a collector's retries do.
    const burst = 1 + Math.floor(next() * 4);
    store.add(source, kind, burst);
    drawn.add(kind);
    if (kind === "visible" || kind === "partial") visible += burst;
    if (mayStop && next() < 0.01) break;
  }
  const absent = registered.find((source) => !sources.includes(source))!;
  const scopes = [
    sources,
    [sources[0]!],
    sources.filter(() => next() < 0.5),
    [...sources.slice(1), absent],
    [absent],
  ];
  return { store, scopes };
}

/** What the seeds drew, for the coverage check. */
const drawn = new Set<string>();

describe("differential against the overview window it replaces for coverage", () => {
  /** CI draws seeds 1–8 of each shape. */
  const SEEDS = Array.from({ length: 8 }, (_, index) => index + 1);

  for (const seed of SEEDS)
    test(`seed ${String(seed)}: inside the window both reads count every scope alike`, async () => {
      // At most 470 visible runs: always inside the 501-run window.
      const { store, scopes } = randomStore(seed, 467, true);
      const exact = exactCounts(store.db);
      const total = [...exact.values()].reduce((sum, count) => sum + count, 0);
      expect(total).toBeLessThanOrEqual(PAGE_LIMIT);
      drawn.add(total > 400 ? "window-nearly-full" : "window-sparse");
      for (const scope of scopes) {
        const scoped = await scopedCounts(store.db, scope);
        expect(scoped).toEqual(await windowCounts(store.db, scope));
        expect(scoped).toEqual(new Map(scope.map((source) => [source, exact.get(source) ?? 0])));
      }
    });

  for (const seed of SEEDS)
    test(`seed ${String(seed)}: past the window the scoped read stays the exact count`, async () => {
      const { store, scopes } = randomStore(100 + seed, PAGE_LIMIT + 1 + seed * 60, false);
      const exact = exactCounts(store.db);
      const total = [...exact.values()].reduce((sum, count) => sum + count, 0);
      expect(total).toBeGreaterThan(PAGE_LIMIT);
      for (const scope of scopes) {
        const scoped = await scopedCounts(store.db, scope);
        expect(scoped).toEqual(new Map(scope.map((source) => [source, exact.get(source) ?? 0])));
        const window = await windowCounts(store.db, scope);
        // The window never counts more than there is, and is short somewhere.
        for (const [source, count] of window)
          expect(count).toBeLessThanOrEqual(scoped.get(source)!);
        if ([...window].some(([source, count]) => count !== scoped.get(source)))
          drawn.add("window-short");
      }
    });

  test("the seeds drew every run kind, both window shapes and a short window", () => {
    for (const state of [...new Set(KINDS), "window-nearly-full", "window-sparse", "window-short"])
      expect(drawn).toContain(state);
  });

  test("past the window the scoped count stays exact and an unlisted source cannot move it", async () => {
    const store = new RunStore();
    const quiet = "sony-bank";
    const busy = "myjcb";
    store.add(quiet, "visible", 3);
    store.add(busy, "visible", PAGE_LIMIT + 99);
    const before = await scopedCounts(store.db, [quiet]);
    expect(before).toEqual(new Map([[quiet, 3]]));
    // The window the intent used to count in is now all the busy source's.
    expect(await windowCounts(store.db, [quiet])).toEqual(new Map([[quiet, 0]]));
    store.add(busy, "visible", 100);
    expect(await scopedCounts(store.db, [quiet])).toEqual(before);
    expect(await scopedCounts(store.db, [quiet, busy])).toEqual(
      new Map([
        [quiet, 3],
        [busy, PAGE_LIMIT + 199],
      ]),
    );
    expect(exactCounts(store.db).get(busy)).toBe(PAGE_LIMIT + 199);
  });
});
