// A READ database over `bun:sqlite` with every READ migration, and an
// executor over it, for the tests that derive an operation's `projected`
// stage (ADR 0048, amended) — here and in apps/web, which may not import the
// read model or packages/storage-d1 itself. Synthetic only: one instance, one
// complete snapshot with no rows, and the pointer.
import { Database } from "bun:sqlite";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import {
  migrationFiles,
  migrationSql,
  READ_MIGRATIONS_URL,
} from "../../storage-d1/src/migrations.ts";

type Bind = string | number | null;

/** A `SqlExecutor` over a `bun:sqlite` database. */
export function sqliteExecutor(db: Database): SqlExecutor {
  return {
    first: async <T>(sql: string, args: readonly unknown[] = []) =>
      (db.query(sql).get(...(args as Bind[])) as T | null) ?? null,
    all: async <T>(sql: string, args: readonly unknown[] = []) =>
      db.query(sql).all(...(args as Bind[])) as T[],
  };
}

/**
 * A READ database with every READ migration and, unless `contract` is null,
 * one published snapshot whose pointer was verified at `revision` of `epoch`.
 */
export function publishedReadDatabase(
  revision: number,
  epoch: string,
  contract: string | null = "read-baseline-v1",
): Database {
  const read = new Database(":memory:");
  for (const file of migrationFiles(READ_MIGRATIONS_URL))
    read.exec(migrationSql(READ_MIGRATIONS_URL, file));
  if (contract === null) return read;
  const snapshot = "b".repeat(64);
  const instance = "instance-synthetic";
  const at = "2026-09-11T00:30:00Z";
  read.run(
    `INSERT INTO read_instance(id,read_instance_id,created_at,contract_version) VALUES(1,?,?,?)`,
    [instance, at, contract],
  );
  read.run(
    `INSERT INTO balance_read_snapshots(snapshot_id,content_key,attempt,input_digest,build_digest,
       contract_version,read_instance_id,source_revision,visibility_revision,core_epoch,status,
       row_count,output_digest,input_manifest_json,projection_release,created_at,completed_at)
     VALUES(?1,?1,1,?1,?1,?2,?3,?4,1,?5,'complete',0,?1,'{}','balance-projection-v1',?6,?6)`,
    [snapshot, contract, instance, revision, epoch, at],
  );
  read.run(
    `INSERT INTO balance_snapshot_pointer(id,snapshot_id,source_revision,visibility_revision,
       core_epoch,read_instance_id,output_digest,switched_at) VALUES(1,?1,?2,1,?3,?4,?1,?5)`,
    [snapshot, revision, epoch, instance, at],
  );
  return read;
}
