// G2-17 (basis): the Drizzle table declarations and the SQL that actually
// creates the database say the same thing.
//
// `src/drizzle/schema/core.ts` is a hand-written mirror of immutable
// migrations. A mirror drifts: someone adds a column in SQL and not here, or
// renames a property here and the ORM silently selects a column nobody has.
// Neither mistake shows up as a type error, and the second one shows up in
// production as "no such column".
//
// So on every CI run this test builds the real schema — all of
// `migrations/core/`, applied in order to `bun:sqlite`, exactly as wrangler
// applies it — reads it back with `PRAGMA table_info`, and compares it with
// what `getTableConfig` says each declaration means. Both directions are
// checked: a column in SQL that the mirror does not declare fails, and a
// column the mirror declares that SQL does not have fails.
//
// What is compared is what a table declaration can express: the table exists
// and is a table, its column names, each column's storage class as SQLite's
// affinity rules resolve it, NOT NULL, the primary key and its order, and the
// declared default. Everything else about these tables — `STRICT`, the CHECK
// constraints, the triggers, the partial and unique indexes, the foreign keys
// — a declaration cannot express, so it is left to SQL and proved by
// behaviour (`drizzle-immutability.test.ts`, `seal.test.ts`).
import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../src/drizzle/schema/core.ts";
import { fullCoreDatabase } from "./sqlite.ts";

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

/**
 * SQLite's five affinities, from the declared type (sqlite.org/datatype3,
 * §3.1). Comparing affinities rather than spellings is the honest comparison:
 * "INTEGER" and "int" are the same column, and a declaration that produced
 * TEXT affinity where SQL produces INTEGER is a real difference.
 */
function affinity(declared: string): string {
  const type = declared.toUpperCase();
  if (type.includes("INT")) return "INTEGER";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "TEXT";
  if (type === "" || type.includes("BLOB")) return "BLOB";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** A default as SQL spells it, so it can be compared with `dflt_value`. */
function literal(value: unknown): string {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value === null) return "NULL";
  throw new Error(`unsupported default: ${String(value)}`);
}

/**
 * Every `sqliteTable` the schema module exports, by table name. The module is
 * enumerated rather than listed, so a declaration that is added and forgotten
 * is still compared — and `is(value, Table)` keeps a future non-table export
 * from being read as one.
 */
const declared = new Map(
  Object.values(schema)
    .filter((value) => is(value, Table))
    .map((table) => [getTableConfig(table).name, table] as const),
);

let db: Database;
let tables: Set<string>;

beforeAll(() => {
  db = fullCoreDatabase();
  tables = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
});

describe("the Drizzle schema mirrors the SQL migrations (G2-17)", () => {
  test("the mirror is not empty and covers the pilot's tables", () => {
    // A parity test that compares nothing passes. These are the tables the
    // pilot reads, writes or asserts immutability on; the list is here so
    // deleting a declaration is a failure rather than a silent narrowing.
    expect([...declared.keys()].sort()).toEqual([
      "acquisition_sessions",
      "fetch_artifacts",
      "fetch_run_reports",
      "fetch_runs",
      "ingest_clients",
      "observation_decimal_values",
      "observation_replay_plans",
      "ops_request_stages",
      "ops_requests",
      "parse_runs",
      "parser_releases",
      "published_parse_runs",
      "raw_object_verification_events",
      "raw_objects",
      "sources",
    ]);
  });

  for (const [name, table] of declared) {
    describe(name, () => {
      test("is a table in the schema the migrations create", () => {
        expect(tables.has(name)).toBe(true);
      });

      test("declares exactly the columns SQL has", () => {
        const info = db.query(`PRAGMA table_info(${name})`).all() as ColumnInfo[];
        const config = getTableConfig(table);
        expect(info.map((column) => column.name).sort()).toEqual(
          config.columns.map((column) => column.name).sort(),
        );
      });

      test("agrees on affinity, NOT NULL and default for every column", () => {
        const info = db.query(`PRAGMA table_info(${name})`).all() as ColumnInfo[];
        const config = getTableConfig(table);
        const sql = new Map(info.map((column) => [column.name, column]));
        for (const column of config.columns) {
          const actual = sql.get(column.name);
          expect(actual, `${name}.${column.name} exists in SQL`).toBeDefined();
          if (!actual) continue;
          expect(affinity(column.getSQLType()), `${name}.${column.name} affinity`).toBe(
            affinity(actual.type),
          );
          // `INTEGER PRIMARY KEY` is the rowid alias: SQLite reports it as
          // nullable because inserting NULL asks for the next id, yet no row
          // ever holds NULL there. Drizzle declares it not-null, which is what
          // a reader needs; every other column must match exactly.
          const rowidAlias =
            actual.pk === 1 &&
            affinity(actual.type) === "INTEGER" &&
            info.filter((other) => other.pk > 0).length === 1;
          expect(column.notNull, `${name}.${column.name} NOT NULL`).toBe(
            rowidAlias ? true : actual.notnull === 1,
          );
          // A rowid alias also carries Drizzle's `hasDefault` — its "the
          // database assigns this" marker, not a declared default — so the
          // default comparison applies to every other column.
          if (rowidAlias) continue;
          expect(
            column.hasDefault ? literal(column.mapToDriverValue(column.default)) : null,
            `${name}.${column.name} default`,
          ).toBe(actual.dflt_value);
        }
      });

      test("agrees on the primary key and its column order", () => {
        const info = db.query(`PRAGMA table_info(${name})`).all() as ColumnInfo[];
        const config = getTableConfig(table);
        const sqlKey = info
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name);
        const composite = config.primaryKeys[0];
        const drizzleKey = composite
          ? composite.columns.map((column) => column.name)
          : config.columns.filter((column) => column.primary).map((column) => column.name);
        expect(drizzleKey).toEqual(sqlKey);
      });
    });
  }
});
