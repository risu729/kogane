// The lease row's first write on the real CORE table
// (`collection_execution_leases`, CORE 0065 and 0082): a source that has its
// row keeps it, and a row the schema refuses raises. The insert used `INSERT
// OR IGNORE`, which SQLite also applies to CHECK and NOT NULL failures: the
// row was skipped with no error, the claim then found nothing to claim, and
// the call answered `collection_busy_or_uncertain`. Every value is synthetic.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { withCollectionLease, type ScheduleLeaseDatabase } from "../src/schedule-lease";

const migration = (name: string) =>
  readFileSync(new URL(`../../storage-d1/migrations/core/${name}`, import.meta.url), "utf8");
/** The table as the two migrations that shape it leave it, and nothing else. */
function leaseDatabase(): Database {
  const create = /CREATE TABLE collection_execution_leases \([^;]*\) STRICT;/u.exec(
    migration("0065_alarm_schedules.sql"),
  );
  if (!create) throw new Error("fixture_lease_table_missing");
  const sqlite = new Database(":memory:");
  sqlite.exec(create[0]);
  sqlite.exec(migration("0082_collection_lease_heartbeat.sql"));
  return sqlite;
}
/** The two calls the lease makes of D1: `run` with its `changes`, and `first`. */
function d1(sqlite: Database): ScheduleLeaseDatabase {
  return {
    prepare: (sql) => ({
      bind: (...values) => ({
        run: async () => ({
          meta: { changes: sqlite.query(sql).run(...(values as never[])).changes },
        }),
        first: async <T>() => (sqlite.query(sql).get(...(values as never[])) as T | null) ?? null,
      }),
    }),
  };
}

const leaseRows = (sqlite: Database, source: string | null) =>
  sqlite
    .query("SELECT lease_ref,started_at FROM collection_execution_leases WHERE source IS ?")
    .all(source);
const environment = (sqlite: Database) => ({ SCHEDULE_DB: d1(sqlite) });

test("a source's lease row is written once and reused by every later call", async () => {
  const sqlite = leaseDatabase();
  try {
    const env = environment(sqlite);
    let calls = 0;
    for (let round = 0; round < 2; round++)
      await withCollectionLease(env, "synthetic-source", async () => {
        calls++;
        expect(leaseRows(sqlite, "synthetic-source")).toEqual([
          { lease_ref: expect.any(String), started_at: expect.any(String) },
        ]);
      });
    expect(calls).toBe(2);
    expect(leaseRows(sqlite, "synthetic-source")).toEqual([{ lease_ref: null, started_at: null }]);
  } finally {
    sqlite.close();
  }
});

test("a lease row the schema refuses raises instead of answering a busy lease", async () => {
  const sqlite = leaseDatabase();
  try {
    const env = environment(sqlite);
    let calls = 0;
    // The table's primary key is NOT NULL (STRICT). A caller passes a typed
    // source; this one does not.
    await expect(
      withCollectionLease(env, null as unknown as string, async () => {
        calls++;
      }),
    ).rejects.toThrow(/NOT NULL constraint failed/u);
    expect(leaseRows(sqlite, null)).toEqual([]);
    // One more CHECK, refusing a synthetic source: the shape a migration that
    // tightens the table would leave.
    sqlite.exec(
      "ALTER TABLE collection_execution_leases ADD COLUMN refusal_probe INTEGER CHECK(source<>'synthetic-refused')",
    );
    await expect(
      withCollectionLease(env, "synthetic-refused", async () => {
        calls++;
      }),
    ).rejects.toThrow(/CHECK constraint failed/u);
    expect(leaseRows(sqlite, "synthetic-refused")).toEqual([]);
    expect(calls).toBe(0);
  } finally {
    sqlite.close();
  }
});
