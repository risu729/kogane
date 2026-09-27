// A `CommandStore` over `bun:sqlite` with the real CORE migrations applied, so
// the SQL half of an application service can be exercised — including the
// interleavings a D1 batch cannot be made to show on demand — without a
// Workers runtime. Synthetic only: the migrations seed a registry and nothing
// else, and no test here inserts an amount, a credential or a provider string.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_MIGRATIONS_URL } from "../../storage-d1/src/migrations.ts";
import type { BatchOutcome, CommandStore, PreparedWrite } from "../src/command/contract.ts";

// The CORE directory is named once, in packages/storage-d1 (U05, decision D3).
const MIGRATIONS = fileURLToPath(CORE_MIGRATIONS_URL);

/** Every migration, in order, on a fresh in-memory database with FKs on (as D1 has). */
export function migratedDatabase(): Database {
  // Every migration runs once per process and each call gets its own copy of
  // the resulting file image, as `fullCoreDatabase` does in packages/storage-d1.
  // Replaying CORE per call (about 0.6 s locally) took most of a test's 5 s
  // budget on a loaded CI runner.
  migratedImage ??= migrate();
  const db = Database.deserialize(migratedImage);
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}
let migratedImage: Uint8Array | undefined;
function migrate(): Uint8Array {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  const image = db.serialize();
  db.close();
  return image;
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
