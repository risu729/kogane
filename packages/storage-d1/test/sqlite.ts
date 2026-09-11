// A `D1Like` over `bun:sqlite`, so the guarded batches of `src/atomic/` can be
// exercised against the real CORE schema — triggers, CHECK constraints, views
// and all — instead of against a fake that agrees with them by construction.
//
// `batch` matches D1's contract in the way these tests depend on: the
// statements run in one transaction, an SQL error rolls the whole thing back,
// and a conditional statement that matched nothing reports `changes: 0`
// *without* stopping the rest — which is exactly why every statement of an
// atomic command carries its own guard (unified plan 09 §2).
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CORE_MIGRATIONS_URL } from "../src/migrations.ts";
import type { D1Like, D1RunResultLike, D1StatementLike } from "../src/d1.ts";

/** The Layer A tables the later migrations reference, as the pipeline harness
 * declares them. Synthetic only; no provider ever appears here. */
const LAYER_A = `CREATE TABLE sources(id TEXT PRIMARY KEY,provider TEXT);
CREATE TABLE producers(id TEXT PRIMARY KEY);
CREATE TABLE fetch_runs(id INTEGER PRIMARY KEY,source_id TEXT,acquisition_session_id INTEGER,producer_id TEXT,first_recorded_at_ms INTEGER,source_run_key TEXT DEFAULT 'default');
CREATE TABLE fetch_run_annotations(fetch_run_id INTEGER,annotation_kind TEXT);
CREATE VIEW financial_fetch_runs AS SELECT * FROM fetch_runs WHERE source_id<>'kogane-synthetic' AND NOT EXISTS(SELECT 1 FROM fetch_run_annotations a WHERE a.fetch_run_id=fetch_runs.id AND a.annotation_kind='exclude_from_financial_views');
CREATE TABLE acquisition_sessions(id INTEGER PRIMARY KEY,external_session_id TEXT,producer_id TEXT,external_id_namespace TEXT);
CREATE TABLE fetch_run_seals(fetch_run_id INTEGER,sealed_at_ms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE fetch_run_reports(fetch_run_id INTEGER,report_kind TEXT,normalized_outcome TEXT,started_at_ms INTEGER,completed_at_ms INTEGER);
CREATE TABLE fetch_units(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,unit_key TEXT,unit_kind TEXT DEFAULT 'card');
CREATE TABLE fetch_unit_reports(fetch_unit_id INTEGER,report_kind TEXT,normalized_outcome TEXT,safe_failure_code TEXT);
CREATE TABLE fetch_artifacts(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,source_id TEXT,dataset TEXT,artifact_key TEXT,fetch_unit_id INTEGER,declared_media_type TEXT,fetched_at_ms INTEGER,recorded_at_ms INTEGER,sha256 TEXT,artifact_role TEXT,format_id TEXT,format_version TEXT);
CREATE TABLE raw_objects(sha256 TEXT PRIMARY KEY,byte_size INTEGER,blob_key TEXT);
CREATE TABLE fetch_run_ranges(id INTEGER PRIMARY KEY,fetch_run_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);
CREATE TABLE artifact_ranges(id INTEGER PRIMARY KEY,fetch_artifact_id INTEGER,range_kind TEXT,start_value TEXT,end_value TEXT);`;

/** CORE from migration `from` onwards, applied in order over the Layer A stub. */
export function coreDatabase(from = "0017"): Database {
  const directory = fileURLToPath(CORE_MIGRATIONS_URL);
  const db = new Database(":memory:");
  db.exec(LAYER_A);
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".sql") && entry >= from)
    .sort())
    db.exec(readFileSync(join(directory, name), "utf8"));
  return db;
}

/**
 * The whole of CORE from 0001, on a database that enforces foreign keys the
 * way D1 does: for the commands whose guards restate Layer A columns (the
 * seal), the real registry, run and artifact tables with all their triggers.
 */
export function fullCoreDatabase(): Database {
  const directory = fileURLToPath(CORE_MIGRATIONS_URL);
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(directory, name), "utf8"));
  return db;
}

class SqliteStatement implements D1StatementLike {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly binds: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    return new SqliteStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.query(this.sql).get(...(this.binds as never[])) as T | null) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql).all(...(this.binds as never[])) as T[] };
  }

  async run(): Promise<D1RunResultLike> {
    return this.execute();
  }

  /**
   * Runs the statement and reports what D1 reports: the rows it changed —
   * counted with `total_changes()`, so trigger writes are included exactly as
   * workerd includes them — and the rows a `RETURNING` clause produced.
   */
  execute(): D1RunResultLike {
    const before = this.db.query("SELECT total_changes() AS n").get() as { n: number };
    const results = this.db.query(this.sql).all(...(this.binds as never[])) as Record<
      string,
      unknown
    >[];
    const after = this.db.query("SELECT total_changes() AS n").get() as { n: number };
    return { meta: { changes: after.n - before.n }, results };
  }
}

export function sqliteD1(db: Database): D1Like {
  return {
    prepare(sql: string): D1StatementLike {
      return new SqliteStatement(db, sql);
    },
    async batch(statements: D1StatementLike[]): Promise<D1RunResultLike[]> {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => (statement as SqliteStatement).execute());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
