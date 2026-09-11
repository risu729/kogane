// A READ database on `bun:sqlite`, for the tests that only need SQLite
// semantics: the schema, its triggers, the identity rules and the guarded
// statements.
//
// It reuses `sqliteD1` from `test/sqlite.ts`, the same `D1Like` double the CORE
// commands are tested against, so both sides of this package agree on what a
// batch does: the statements run in one transaction, an SQL error rolls the
// whole thing back, and a conditional statement that matched nothing reports
// `changes: 0` without stopping the rest. The same adapters run against real D1
// under Miniflare in `services/observation-pipeline/test/read-projection.test.ts`;
// this double exists so the package can prove its own SQL without a Worker
// runtime, never as the only evidence that a batch behaves.
import { Database } from "bun:sqlite";
import { migrationFiles, migrationSql, READ_MIGRATIONS_URL } from "../src/migrations.ts";
import type { D1Like } from "../src/d1.ts";
import { sqliteD1 } from "./sqlite.ts";

export interface SqliteReadDatabase {
  /** The D1 surface the adapters take. */
  d1: D1Like;
  /** The underlying database, for assertions a statement cannot make. */
  sqlite: Database;
}

/** An empty READ database with its baseline applied. */
export function createSqliteReadDatabase(): SqliteReadDatabase {
  const sqlite = new Database(":memory:");
  for (const file of migrationFiles(READ_MIGRATIONS_URL))
    sqlite.exec(migrationSql(READ_MIGRATIONS_URL, file));
  return { d1: sqliteD1(sqlite), sqlite };
}
