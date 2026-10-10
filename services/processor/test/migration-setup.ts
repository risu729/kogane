// Test-only D1 schema installation. Each migration keeps its own boundary;
// production still applies migrations through Wrangler. Avoid a proxy request
// per SQL statement as the schema grows toward the unchanged hook deadlines.
import {
  READ_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";

/** Apply complete SQL statements in order, with triggers kept intact. */
export async function applyTestSql(db: D1Database, sql: string): Promise<void> {
  const statements = splitSqlStatements(sql).map((statement) => db.prepare(statement));
  if (statements.length > 0) await db.batch(statements);
}

/** Keep READ migration file boundaries just like the CORE setup. */
export async function applyTestReadMigrations(db: D1Database): Promise<void> {
  for (const name of migrationFiles(READ_MIGRATIONS_URL))
    await applyTestSql(db, migrationSql(READ_MIGRATIONS_URL, name));
}
