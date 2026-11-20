// What a filtered activity page costs on D1 (ADR 0081, amendment of
// 2026-11-20), measured with workerd's own `rows_read` on the complete CORE
// schema with no table statistics: two stores hold the same recent events
// before an older history of different sizes, both longer than the walk. The
// first page of each filter answers the same on both and reads the same rows
// on both, so a page costs its walk, not the store. D1 plans the walk as one
// range of `economic_event_revisions_current` and every filter by key, and the
// answer on D1 equals the answer on bun:sqlite for the same rows. Every value
// is synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  ACTIVITY_FILTER_WALK,
  createEventsReader,
  filteredActivityEventsSql,
  type ActivityFilters,
  type FilteredActivityPage,
} from "../../../packages/read-model/src/index.ts";
import type { SqlExecutor } from "../../../packages/read-model/src/reader.ts";
import {
  EventsWorld,
  transactionRef,
} from "../../../packages/read-model/test/events-filter-world.ts";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";

const NONE: ActivityFilters = { since: null, before: null, account: null, source: null };
const SINCE = "2099-03-01T00:00:00.000Z";
const FILTERS: Record<string, ActivityFilters> = {
  since: { ...NONE, since: SINCE },
  window: { ...NONE, since: SINCE, before: "2099-03-02T00:00:00.000Z" },
  account: { ...NONE, account: "account_recent" },
  source: { ...NONE, source: "sony-bank" },
  all: {
    since: SINCE,
    before: "2099-04-01T00:00:00.000Z",
    account: "account_recent",
    source: "sony-bank",
  },
};

let mf: Miniflare;
beforeAll(() => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('local')}}",
      compatibilityDate: "2026-09-07",
      d1Databases: ["SMALL", "LARGE", "PLANS"],
    }),
  );
});
afterAll(async () => {
  await mf?.dispose();
});

/** Five recent events, which sort before the history (`ev-` < `history-`); answers the history's parse run. */
function world(): { world: EventsWorld; historyParse: number } {
  const events = new EventsWorld({ record: true, firstId: 1_000_000 });
  const sony = events.capture("sony-bank");
  const vpass = events.capture("vpass");
  for (let n = 1; n <= 5; n += 1)
    events.event({
      eventId: `ev-recent-${n}`,
      revision: 1,
      createdAt: `2099-03-0${n}T00:00:00.000Z`,
      evidence: [transactionRef(n, n % 2 === 0 ? vpass : sony)],
      legs: [
        {
          subjectRef: n % 3 === 0 ? "account_recent" : "account:account_recent",
          basis: "cash-movement",
        },
        { subjectRef: "claim:cost", basis: "purchase-recognition", role: "increase" },
      ],
    });
  return { world: events, historyParse: vpass };
}

/**
 * `size` older events of another account, cited from a vpass capture, each
 * with its decision and one cash leg, in one statement per table; the ids are
 * zero-padded so the walk meets the same ones first in every store.
 */
function history(size: number, parse: number): string[] {
  const series = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${size})`;
  const id = "'history-'||printf('%08d',i)";
  return [
    `${series} INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     SELECT 'dr_'||${id},'relation','event:'||${id},1,'accept','rule','rule:synthetic',NULL,'synthetic','[]',NULL,NULL,'2099-01-01T00:00:00.000Z' FROM n`,
    `${series} INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
     SELECT ${id},1,'purchase','captured',NULL,'{"kind":"local-date","value":"2099-01-01","zone":null,"basis":"provider"}','purchase-recognition',
      '[{"kind":"transaction","id":"transaction:1","revision":"parse_run:${parse}"}]','dr_'||${id},NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ',4070908800+i,'unixepoch') FROM n`,
    `${series} INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
     SELECT ${id},1,0,'account:account_history','XXX','exact','1',0,NULL,'decrease','cash-movement' FROM n`,
  ];
}

async function migrated(binding: string): Promise<D1Database> {
  const db = await mf.getD1Database(binding);
  for (const file of migrationFiles(CORE_MIGRATIONS_URL)) {
    const statements = splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file));
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  return db;
}

async function store(binding: string, size: number) {
  const db = await migrated(binding);
  const built = world();
  const statements = built.world.statements;
  for (let offset = 0; offset < statements.length; offset += 80)
    await db.batch(
      statements
        .slice(offset, offset + 80)
        .map(({ sql, values }) =>
          values.length ? db.prepare(sql).bind(...values) : db.prepare(sql),
        ),
    );
  for (const sql of history(size, built.historyParse)) {
    await db.prepare(sql).run();
    built.world.db.exec(sql);
  }
  return { db, local: built.world.db };
}

/** A D1 executor that keeps each statement's `rows_read`. */
function measured(db: D1Database, reads: number[]): SqlExecutor {
  const all = async <T>(text: string, args: readonly unknown[]) => {
    const result = await db
      .prepare(text)
      .bind(...args)
      .all<T>();
    reads.push(result.meta.rows_read);
    return result.results;
  };
  return {
    all,
    first: async <T>(text: string, args: readonly unknown[]) =>
      (await all<T>(text, args))[0] ?? null,
  };
}

test("a first filtered page reads the same rows over a history three times larger, and answers the same", async () => {
  const small = ACTIVITY_FILTER_WALK + 100;
  const answers: Record<string, FilteredActivityPage[]> = {};
  const costs: Record<string, number[][]> = {};
  for (const [binding, size] of [
    ["SMALL", small],
    ["LARGE", small * 3],
  ] as const) {
    const { db, local } = await store(binding, size);
    for (const [name, filters] of Object.entries(FILTERS)) {
      const reads: number[] = [];
      const begun = performance.now();
      const page = await createEventsReader(measured(db, reads), {
        pageSize: 200,
      }).filteredActivity({
        basis: "cash-movement",
        filters,
        after: null,
      });
      console.info("events filters: D1 first page", {
        binding,
        name,
        rowsRead: reads,
        ms: Math.round(performance.now() - begun),
      });
      (answers[name] ??= []).push(page);
      (costs[name] ??= []).push(reads);
      // D1 answers what bun:sqlite answers for the same rows.
      if (binding === "SMALL") {
        const sqlite: SqlExecutor = {
          all: async <T>(text: string, args: readonly unknown[]) =>
            local.query(text).all(...(args as never[])) as T[],
          first: async <T>(text: string, args: readonly unknown[]) =>
            (local.query(text).get(...(args as never[])) ?? null) as T | null,
        };
        expect(
          await createEventsReader(sqlite, { pageSize: 200 }).filteredActivity({
            basis: "cash-movement",
            filters,
            after: null,
          }),
        ).toEqual(page);
      }
    }
    local.close();
  }
  for (const name of Object.keys(FILTERS)) {
    const [onSmall, onLarge] = answers[name]!;
    expect({ name, page: onLarge }).toEqual({ name, page: onSmall });
    expect({ name, reads: costs[name]![1] }).toEqual({ name, reads: costs[name]![0] });
    // The walk stopped at its bound inside the history and continues after it.
    expect(onSmall).toMatchObject({
      walked: ACTIVITY_FILTER_WALK,
      next: {
        eventId: `history-${String(ACTIVITY_FILTER_WALK - 5).padStart(8, "0")}`,
        revision: 1,
      },
    });
  }
  expect(answers["since"]![0]!.items.map((item) => item.eventId)).toEqual([
    "ev-recent-1",
    "ev-recent-2",
    "ev-recent-3",
    "ev-recent-4",
    "ev-recent-5",
  ]);
  expect(answers["window"]![0]!.items.map((item) => item.eventId)).toEqual(["ev-recent-1"]);
  expect(answers["source"]![0]!.items.map((item) => item.eventId)).toEqual([
    "ev-recent-1",
    "ev-recent-3",
    "ev-recent-5",
  ]);
  expect(answers["all"]![0]!.items.map((item) => item.eventId)).toEqual(
    answers["source"]![0]!.items.map((item) => item.eventId),
  );
}, 600_000);

test("D1 plans the walk as one index range and every filter by key, with no table statistics", async () => {
  const db = await migrated("PLANS");
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
      .first<number>("n"),
  ).toBe(0);
  const steps = (
    await db
      .prepare(`EXPLAIN QUERY PLAN ${filteredActivityEventsSql}`)
      .bind(
        "cash-movement",
        "",
        0,
        ACTIVITY_FILTER_WALK,
        201,
        SINCE,
        null,
        "account_recent",
        "sony-bank",
      )
      .all<{ detail: string }>()
  ).results.map((row) => row.detail);
  for (const step of [
    "SEARCH e USING INDEX economic_event_revisions_current ((event_id,revision)>(?,?))",
    "SEARCH l USING INDEX sqlite_autoindex_economic_legs_1 (event_id=? AND revision=?)",
    "SEARCH a USING INDEX sqlite_autoindex_economic_legs_1 (event_id=? AND revision=?)",
    "SEARCH p USING INTEGER PRIMARY KEY (rowid=?)",
    "SEARCH f USING INTEGER PRIMARY KEY (rowid=?)",
    "SEARCH e USING INDEX sqlite_autoindex_economic_event_revisions_1 (event_id=? AND revision=?)",
  ])
    expect({ step, used: steps.includes(step) }).toEqual({ step, used: true });
  // Only the walk's own rows are scanned: the CTE and what is drawn from it,
  // and each revision's evidence array (a virtual table).
  const scans = steps
    .filter((detail) => detail.startsWith("SCAN ") && !detail.includes(" VIRTUAL TABLE "))
    .map((detail) => detail.slice(5).split(" ")[0]!);
  expect(scans.filter((name) => !["w", "walked", "x", "t"].includes(name))).toEqual([]);
}, 120_000);
