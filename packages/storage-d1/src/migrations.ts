// Where the two migration directories are, named once so no consumer has to
// spell a relative path to somebody else's package (unified plan 06 §2,
// decision D3).
//
// CORE is the existing database: the files moved here from
// `services/raw-evidence/migrations/` byte for byte, keeping their numbers and
// their applied history. READ is the second database (U11), built from its
// final schema rather than migrated forward from CORE, and starting at
// `0001_read_baseline.sql`.
//
// Two directories, two `migrations_dir` settings, and no code path that can
// apply one set to the other: a wrangler configuration names exactly one, and
// the helpers below name the READ one explicitly.
//
// Only CD applies a migration to production. The readers here take the files
// from disk, which is why they use `node:fs` and are imported by tests and
// generators, never by a Worker.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Absolute URL of the CORE migration directory (trailing slash). */
export const CORE_MIGRATIONS_URL = new URL("../migrations/core/", import.meta.url);

/** Absolute URL of the READ migration directory (trailing slash). */
export const READ_MIGRATIONS_URL = new URL("../migrations/read/", import.meta.url);

/** Repository-relative path of the CORE directory, for wrangler configs and docs. */
export const CORE_MIGRATIONS_PATH = "packages/storage-d1/migrations/core";
/** Repository-relative path of the READ directory. */
export const READ_MIGRATIONS_PATH = "packages/storage-d1/migrations/read";

/** `NNNN_snake_name.sql`: the only shape wrangler's migration ordering accepts. */
export const MIGRATION_FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/u;

/** The migration number a filename declares, or null if it is not a migration. */
export function migrationNumber(filename: string): number | null {
  const match = MIGRATION_FILENAME.exec(filename);
  return match ? Number.parseInt(match[1] as string, 10) : null;
}

/** The migration files of one directory, in application order. */
export function migrationFiles(directory: URL): string[] {
  return readdirSync(fileURLToPath(directory))
    .filter((name) => MIGRATION_FILENAME.test(name))
    .sort();
}

/** The text of one migration file. */
export function migrationSql(directory: URL, file: string): string {
  return readFileSync(join(fileURLToPath(directory), file), "utf8");
}

/**
 * Split a migration into top-level statements.
 *
 * The only subtlety is `CREATE TRIGGER … BEGIN … END;`: the semicolons inside a
 * trigger body do not end the statement, and `END` also closes a `CASE`, so the
 * body runs until the `END` that balances `BEGIN`. Comments and quoted text are
 * skipped, so a `;` or `--` inside a string never splits anything.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  const closers: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const character = sql[index] as string;
    const closer = closers[character];
    if (closer !== undefined) {
      const start = index;
      index += 1;
      while (index < sql.length && sql[index] !== closer) index += 1;
      index += 1;
      current += sql.slice(start, Math.min(index, sql.length));
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (character === ";") {
      if (insideTriggerBody(current)) {
        current += character;
        index += 1;
        continue;
      }
      if (current.trim() !== "") statements.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  if (current.trim() !== "") statements.push(current.trim());
  return statements;
}

function insideTriggerBody(statement: string): boolean {
  if (!/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/iu.test(statement)) return false;
  const bare = statement.replaceAll(/'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\]/gu, " ");
  const words = (bare.match(/[A-Za-z_]+/gu) ?? []).map((word) => word.toUpperCase());
  const begin = words.indexOf("BEGIN");
  if (begin === -1) return true;
  let openCases = 0;
  for (const word of words.slice(begin + 1)) {
    if (word === "CASE") openCases += 1;
    else if (word === "END") {
      if (openCases === 0) return false;
      openCases -= 1;
    }
  }
  return true;
}

/** Every statement of the READ migrations, in application order. */
export function readMigrationStatements(): string[] {
  return migrationFiles(READ_MIGRATIONS_URL).flatMap((file) =>
    splitSqlStatements(migrationSql(READ_MIGRATIONS_URL, file)),
  );
}

/** The minimum a test database has to offer: run one statement at a time. */
export interface StatementRunner {
  prepare(sql: string): { run(): Promise<unknown> };
}

/**
 * Apply the READ migrations to a test database (D1 under Miniflare, or any
 * `bun:sqlite` wrapper with the same two methods). Production migrations are
 * applied by CD through `wrangler d1 migrations apply` against the READ
 * configuration, never by this helper.
 */
export async function applyReadMigrations(db: StatementRunner): Promise<number> {
  const statements = readMigrationStatements();
  for (const statement of statements) await db.prepare(statement).run();
  return statements.length;
}
