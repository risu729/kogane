// CORE 0048: the Processor's per-lane tick records. What the schema accepts is
// counts, flags and closed codes — never text — and what the writer keeps is
// the latest day per lane. Synthetic rows only.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  LANE_TICK_RETENTION,
  latestLaneTicks,
  recordLaneTick,
  type LaneTick,
} from "../src/core/lane-ticks.ts";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../src/migrations.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

const MIGRATION_0048 = "0048_processor_lane_ticks.sql";

function schema(db: Database): string[] {
  return (
    db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all() as {
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }[]
  ).map((row) => JSON.stringify(row));
}

function insert(
  db: Database,
  row: Partial<{
    lane: string;
    started: number;
    finished: number;
    outcome: string;
    code: string | null;
    counts: string;
  }> = {},
): void {
  db.run(
    `INSERT INTO processor_lane_ticks(lane,started_at_ms,finished_at_ms,outcome,error_code,counts_json)
     VALUES(?,?,?,?,?,?)`,
    [
      row.lane ?? "purchase_recognition",
      row.started ?? 1_000,
      row.finished ?? 1_250,
      row.outcome ?? "ran",
      row.code ?? null,
      row.counts ?? "{}",
    ],
  );
}

test("0048 is additive: one table, its index and two triggers, nothing else touched", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL).filter((name) => name < MIGRATION_0048))
    db.exec(migrationSql(CORE_MIGRATIONS_URL, file));
  const before = schema(db);
  const revision = db.query("SELECT * FROM core_source_revision").get();
  db.transaction(() => {
    for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, MIGRATION_0048)))
      db.run(sql);
  })();
  const after = schema(db);
  expect(after.filter((row) => before.includes(row))).toEqual(before);
  expect(
    after
      .filter((row) => !before.includes(row))
      .map((row) => JSON.parse(row) as { type: string; name: string })
      .map((row) => `${row.type}:${row.name}`),
  ).toEqual([
    "index:processor_lane_ticks_lane",
    "table:processor_lane_ticks",
    "trigger:processor_lane_ticks_counts",
    "trigger:processor_lane_ticks_no_update",
  ]);
  expect(
    db.query("SELECT strict FROM pragma_table_list WHERE name='processor_lane_ticks'").get(),
  ).toEqual({ strict: 1 });
  // Recording a tick moves no revision: nothing a projection reads changed.
  insert(db);
  expect(db.query("SELECT * FROM core_source_revision").get()).toEqual(revision);
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
}, 30_000);

test("counts hold counts, flags and one level of closed codes — never text", () => {
  const db = fullCoreDatabase();
  for (const counts of [
    "{}",
    '{"scanned":0,"deferred":false,"groupsSkipped":3}',
    '{"skipped":{"payment_type_unsupported":1,"amount_not_exact":0},"merged":1}',
  ])
    expect(() => insert(db, { counts })).not.toThrow();
  for (const counts of [
    // Text of any kind: an amount, a merchant, a label, a code as a value.
    '{"amount":"98,765"}',
    '{"merchant":"架空店舗"}',
    '{"status":"skipped"}',
    // Numbers that are not counts.
    '{"scanned":-1}',
    '{"amount":987.65}',
    '{"scanned":null}',
    '{"rows":[1,2]}',
    // Nesting beyond one level, or a nested value that is not a count.
    '{"skipped":{"payment_type_unsupported":{"n":1}}}',
    '{"skipped":{"payment_type_unsupported":"1"}}',
    '{"skipped":{"payment_type_unsupported":-1}}',
    '{"skipped":{"payment_type_unsupported":true}}',
    // Keys that are not identifiers: provider text used as a key.
    '{"架空店舗":1}',
    '{"card 001":1}',
    '{"skipped":{"Card-001":1}}',
    '{"skipped":{"merchant name":1}}',
  ])
    expect(() => insert(db, { counts })).toThrow("processor_lane_tick_counts_invalid");
  // Not an object at all, or too long to be a count summary.
  expect(() => insert(db, { counts: "[1]" })).toThrow();
  expect(() => insert(db, { counts: "not json" })).toThrow();
  expect(() =>
    insert(db, {
      counts: JSON.stringify(
        Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i])),
      ),
    }),
  ).toThrow();
}, 30_000);

test("the outcome, code, lane and times are closed", () => {
  const db = fullCoreDatabase();
  expect(() => insert(db, { outcome: "failed", code: "TypeError" })).not.toThrow();
  expect(() => insert(db, { outcome: "failed", code: "parse_lease_expired" })).not.toThrow();
  expect(() => insert(db, { outcome: "skipped-by-flag" })).not.toThrow();
  for (const row of [
    { outcome: "succeeded" },
    // A failure always has a code, and only a failure has one.
    { outcome: "failed" },
    { outcome: "ran", code: "Error" },
    { outcome: "skipped-by-flag", code: "Error" },
    // A code is a code, not an exception message.
    { outcome: "failed", code: "synthetic D1 outage: amount=999999" },
    { outcome: "failed", code: "_leading" },
    { outcome: "failed", code: "x".repeat(65) },
    // Only a tick that ran has counts.
    { outcome: "skipped-by-flag", counts: '{"scanned":0}' },
    { outcome: "failed", code: "Error", counts: '{"scanned":0}' },
    { lane: "Purchase_Recognition" },
    { lane: "purchase-recognition" },
    { lane: "" },
    { started: -1 },
    { started: 2_000, finished: 1_999 },
  ])
    expect(() => insert(db, row)).toThrow();
  // Written once: a tick is never rewritten, only pruned.
  expect(() => db.run("UPDATE processor_lane_ticks SET outcome='ran'")).toThrow(
    "processor lane ticks are written once",
  );
  expect(() => db.run("DELETE FROM processor_lane_ticks")).not.toThrow();
}, 30_000);

const tick = (lane: string, at: number, counts: LaneTick["counts"] = {}): LaneTick => ({
  lane,
  startedAtMs: at,
  finishedAtMs: at + 10,
  outcome: "ran",
  errorCode: null,
  counts,
});

test("each write keeps the latest 288 ticks of its own lane and no more", async () => {
  const db = fullCoreDatabase();
  const d1 = sqliteD1(db);
  expect(LANE_TICK_RETENTION).toBe(288);
  for (let at = 1; at <= 5; at++) await recordLaneTick(d1, tick("reconciliation_sweep", at));
  for (let at = 1; at <= LANE_TICK_RETENTION + 12; at++)
    await recordLaneTick(d1, tick("purchase_recognition", at, { scanned: at }));
  const kept = db
    .query(
      "SELECT min(started_at_ms) AS oldest,max(started_at_ms) AS newest,count(*) AS n FROM processor_lane_ticks WHERE lane=?",
    )
    .get("purchase_recognition");
  expect(kept).toEqual({ oldest: 13, newest: LANE_TICK_RETENTION + 12, n: LANE_TICK_RETENTION });
  // The other lane is untouched by this lane's prune.
  expect(
    db
      .query("SELECT count(*) AS n FROM processor_lane_ticks WHERE lane='reconciliation_sweep'")
      .get(),
  ).toEqual({ n: 5 });
  // A smaller bound prunes on the very next write, atomically with it.
  await recordLaneTick(d1, tick("reconciliation_sweep", 6), 2);
  expect(
    db
      .query(
        "SELECT started_at_ms FROM processor_lane_ticks WHERE lane='reconciliation_sweep' ORDER BY id",
      )
      .all(),
  ).toEqual([{ started_at_ms: 5 }, { started_at_ms: 6 }]);
  await expect(recordLaneTick(d1, tick("reconciliation_sweep", 7), 0)).rejects.toThrow(
    "lane_tick_retention_invalid",
  );
  // A refused insert rolls the prune back with it.
  await expect(
    recordLaneTick(d1, { ...tick("reconciliation_sweep", 8), outcome: "failed" }, 1),
  ).rejects.toThrow();
  expect(
    db
      .query("SELECT count(*) AS n FROM processor_lane_ticks WHERE lane='reconciliation_sweep'")
      .get(),
  ).toEqual({ n: 2 });
}, 30_000);

test("the latest tick of every lane reads back as it was written", async () => {
  const db = fullCoreDatabase();
  const d1 = sqliteD1(db);
  expect(await latestLaneTicks(d1)).toEqual([]);
  await recordLaneTick(d1, tick("purchase_recognition", 1, { scanned: 1 }));
  await recordLaneTick(d1, {
    lane: "purchase_recognition",
    startedAtMs: 2,
    finishedAtMs: 3,
    outcome: "failed",
    errorCode: "TypeError",
    counts: {},
  });
  await recordLaneTick(
    d1,
    tick("identity_sweep", 4, { processedRuns: 2, skipped: { amount_zero: 1 }, deferred: true }),
  );
  expect(await latestLaneTicks(d1)).toEqual([
    {
      lane: "identity_sweep",
      startedAtMs: 4,
      finishedAtMs: 14,
      outcome: "ran",
      errorCode: null,
      counts: { processedRuns: 2, skipped: { amount_zero: 1 }, deferred: true },
    },
    {
      lane: "purchase_recognition",
      startedAtMs: 2,
      finishedAtMs: 3,
      outcome: "failed",
      errorCode: "TypeError",
      counts: {},
    },
  ]);
}, 30_000);
