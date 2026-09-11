// A `CommandStore` over `bun:sqlite` with the real CORE migrations applied, so
// the SQL half of an application service can be exercised — including the
// interleavings a D1 batch cannot be made to show on demand — without a
// Workers runtime. Synthetic only: the migrations seed a registry and nothing
// else, and no test here inserts an amount, a credential or a provider string.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BatchOutcome, CommandStore, PreparedWrite } from "../src/command/contract.ts";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../services/raw-evidence/migrations",
);

/** Every migration, in order, on a fresh in-memory database with FKs on (as D1 has). */
export function migratedDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  return db;
}

type Bind = string | number | bigint | boolean | null | Uint8Array;

export function sqliteCommandStore(db: Database): CommandStore {
  const run = db.transaction((writes: readonly PreparedWrite[]): BatchOutcome[] =>
    writes.map((write) => ({
      changes: db.run(write.sql, write.binds as Bind[]).changes,
    })),
  );
  return {
    first: async <T>(sql: string, binds: readonly unknown[] = []) =>
      (db.query(sql).get(...(binds as Bind[])) as T | null) ?? null,
    all: async <T>(sql: string, binds: readonly unknown[] = []) =>
      db.query(sql).all(...(binds as Bind[])) as T[],
    // One transaction, like a D1 batch: a statement that raises aborts all of it.
    batch: async (writes) => run(writes),
  };
}
