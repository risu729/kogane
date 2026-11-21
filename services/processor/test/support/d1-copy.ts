// Copies a CORE store built with `bun:sqlite` (every migration, all triggers,
// e.g. `packages/read-model/test/card-usage-scale-fixture.ts`) into a
// Miniflare D1 database, so that a read can be measured with workerd's own
// `meta.rows_read` on exactly the rows the fixture wrote.
//
// The target is migrated with the same CORE migrations first, so its schema,
// views, indexes and triggers are the shipped ones. The fixture's rows are
// then copied as they are: the triggers are dropped for the copy (they guard
// writes the fixture already made through them, and an append-only guard
// would refuse clearing the rows the migrations seeded), every table is
// emptied and refilled with its rows in rowid order, and the triggers are
// recreated verbatim from the target's own schema before anything is read.
// D1 enforces foreign keys and cannot turn them off, so the copy runs in one
// batch with `defer_foreign_keys`, checked once at its end; a statement stays
// under D1's 100 KB limit. Nothing here changes a production path.
import type { Database } from "bun:sqlite";

const STATEMENT_BYTES = 90_000;

interface Column {
  name: string;
  hidden: number;
}

/** Every user table of `source`, in creation order. */
function tables(source: Database): string[] {
  return (
    source
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** INSERT statements holding every row of `table`, each under the D1 statement limit. */
function insertsOf(source: Database, table: string): string[] {
  const columns = (source.query(`PRAGMA table_xinfo(${quoted(table)})`).all() as Column[])
    .filter((column) => column.hidden === 0)
    .map((column) => column.name);
  if (columns.length === 0) return [];
  const head = `INSERT INTO ${quoted(table)}(${columns.map(quoted).join(",")}) VALUES`;
  const literal = columns.map((column) => `quote(${quoted(column)})`).join("||','||");
  const order = (
    source.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
      sql: string;
    }
  ).sql.includes("WITHOUT ROWID")
    ? ""
    : " ORDER BY rowid";
  const rows = source
    .query(`SELECT '('||${literal}||')' AS v FROM ${quoted(table)}${order}`)
    .all() as { v: string }[];
  const statements: string[] = [];
  let values: string[] = [];
  let bytes = head.length;
  for (const { v } of rows) {
    if (values.length > 0 && bytes + v.length + 1 > STATEMENT_BYTES) {
      statements.push(`${head}${values.join(",")}`);
      values = [];
      bytes = head.length;
    }
    values.push(v);
    bytes += v.length + 1;
  }
  if (values.length > 0) statements.push(`${head}${values.join(",")}`);
  return statements;
}

/** Replaces every row of the migrated `target` with the rows of `source`. */
export async function copyIntoD1(source: Database, target: D1Database): Promise<number> {
  const triggers = (
    await target
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY rowid")
      .all<{ name: string; sql: string }>()
  ).results;
  const names = tables(source);
  const statements = [
    "PRAGMA defer_foreign_keys=ON",
    ...triggers.map((trigger) => `DROP TRIGGER ${quoted(trigger.name)}`),
    ...names.map((table) => `DELETE FROM ${quoted(table)}`),
    ...names.flatMap((table) => insertsOf(source, table)),
  ];
  await target.batch(statements.map((sql) => target.prepare(sql)));
  await target.batch(triggers.map((trigger) => target.prepare(trigger.sql)));
  let copied = 0;
  for (const table of names) {
    const expected = (
      source.query(`SELECT count(*) AS n FROM ${quoted(table)}`).get() as {
        n: number;
      }
    ).n;
    const actual = (await target
      .prepare(`SELECT count(*) AS n FROM ${quoted(table)}`)
      .first<{ n: number }>())!.n;
    if (actual !== expected) throw new Error(`d1_copy_mismatch:${table}:${expected}:${actual}`);
    copied += actual;
  }
  return copied;
}
