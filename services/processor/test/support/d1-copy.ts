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
// emptied and refilled with its rows and rowids in rowid order, and the
// triggers are recreated verbatim from the target's own schema before
// anything is read. Every row, rowid included, and every trigger is then read
// back and compared with the source.
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

/** The copied columns of `table`, its rowid first where it has one of its own. */
function columnsOf(source: Database, table: string): { columns: string[]; rowid: boolean } {
  const columns = (source.query(`PRAGMA table_xinfo(${quoted(table)})`).all() as Column[])
    .filter((column) => column.hidden === 0)
    .map((column) => quoted(column.name));
  const rowid = !(
    source.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
      sql: string;
    }
  ).sql.includes("WITHOUT ROWID");
  // An INTEGER PRIMARY KEY column is the rowid, and its own value wins when
  // both are given; any other rowid table keeps its gaps only if the rowid is
  // copied too (a row a migration deleted leaves one in `sources`).
  return { columns: rowid ? ["rowid", ...columns] : columns, rowid };
}

/** Each row of `table` as one list of SQL literals, its rowid first where it has one, in a stable order. */
function rowsOf(source: Database, table: string): string {
  const { columns, rowid } = columnsOf(source, table);
  const literals = columns.map((column) => `quote(${column})`).join("||','||");
  return `SELECT ${literals} AS v FROM ${quoted(table)} ORDER BY ${rowid ? "rowid" : "v"}`;
}

/** INSERT statements holding every row of `table`, each under the D1 statement limit. */
function insertsOf(source: Database, table: string): string[] {
  const { columns } = columnsOf(source, table);
  const head = `INSERT INTO ${quoted(table)}(${columns.join(",")}) VALUES`;
  const rows = (source.query(rowsOf(source, table)).all() as { v: string }[]).map(
    (row) => `(${row.v})`,
  );
  const statements: string[] = [];
  let values: string[] = [];
  let bytes = head.length;
  for (const v of rows) {
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
  const recreated = (
    await target
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY rowid")
      .all<{ name: string; sql: string }>()
  ).results;
  if (JSON.stringify(recreated) !== JSON.stringify(triggers))
    throw new Error(`d1_copy_triggers:${triggers.length}:${recreated.length}`);
  // Every row, rowid and value, must read back as the source holds it.
  let copied = 0;
  for (const table of names) {
    const sql = rowsOf(source, table);
    const expected = (source.query(sql).all() as { v: string }[]).map((row) => row.v);
    const actual = (await target.prepare(sql).all<{ v: string }>()).results.map((row) => row.v);
    const differs = expected.findIndex((value, index) => actual[index] !== value);
    if (actual.length !== expected.length || differs !== -1)
      throw new Error(
        `d1_copy_mismatch:${table}:${expected.length}:${actual.length}:${differs === -1 ? "" : `row ${differs}`}`,
      );
    copied += actual.length;
  }
  return copied;
}
