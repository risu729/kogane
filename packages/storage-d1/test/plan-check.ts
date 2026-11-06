// Query plan checks without table statistics, for statements that had none.
//
// D1 never runs `ANALYZE`, so its planner never has `sqlite_stat*` tables to
// go on; `fullCoreDatabase()` (every CORE migration) and the READ baseline
// have none either. A statement whose plan is keyed here is keyed on D1.
//
// The plan checked is the plan of the SQL that ran: `preparedStatements`
// remembers every statement a function under test prepared, without running
// any of them, so a caller checks a write's guards and a read's access path
// without building the rows either needs.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { D1Like, D1RunResultLike, D1StatementLike } from "../src/d1.ts";

/**
 * A `D1Like` that runs nothing: every statement prepared on it is remembered,
 * reads answer no row and writes report one change. A function under test
 * takes its "nothing there" path, which for a single-statement accessor is the
 * only path.
 */
export function preparedStatements(): { db: D1Like; prepared: string[] } {
  const prepared: string[] = [];
  const statement = (): D1StatementLike => ({
    bind: () => statement(),
    first: async <T>(): Promise<T | null> => null,
    all: async <T>(): Promise<{ results: T[] }> => ({ results: [] }),
    raw: async <T>(): Promise<T[]> => [],
    run: async (): Promise<D1RunResultLike> => ({ meta: { changes: 1 }, results: [] }),
  });
  return {
    prepared,
    db: {
      prepare: (sql: string) => {
        prepared.push(sql);
        return statement();
      },
      batch: async (statements: D1StatementLike[]) =>
        statements.map(() => ({ meta: { changes: 1 }, results: [] })),
    },
  };
}

/** An `INSERT` that cannot delete a row: no `OR REPLACE`, no `REPLACE INTO`. */
const PLAIN_INSERT = /^\s*INSERT\s+(?:OR\s+(?:IGNORE|ABORT|FAIL|ROLLBACK)\s+)?INTO\b/iu;

/**
 * The plan's details, as SQLite explains the statement on `db`.
 *
 * For a plain `INSERT`, foreign keys are switched off for the explanation
 * only. With them on, an insert into a table that other tables reference
 * compiles a scan of each referencing table that runs only while a deferred
 * violation is outstanding (`OP_FkIfZero`); it is not the statement's own
 * access path. Every other statement is explained with foreign keys as `db`
 * has them: a `DELETE`, a `REPLACE` or an `UPDATE` of a referenced key does
 * read the referencing rows each time, and a missing child index shows.
 */
export function planOf(db: Database, sql: string, binds: readonly unknown[] = []): string[] {
  const enforced = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  if (PLAIN_INSERT.test(sql)) db.exec("PRAGMA foreign_keys=OFF");
  try {
    return (
      db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as SQLQueryBindings[])) as {
        detail: string;
      }[]
    ).map((row) => row.detail);
  } finally {
    if (enforced) db.exec("PRAGMA foreign_keys=ON");
  }
}

const KEYWORDS = new Set(
  `AS ON USING WHERE JOIN LEFT RIGHT FULL INNER OUTER CROSS NATURAL INDEXED NOT GROUP ORDER
  LIMIT SET VALUES SELECT WINDOW UNION EXCEPT INTERSECT HAVING RETURNING DEFAULT`
    .split(/\s+/u)
    .filter(Boolean),
);

interface SchemaNames {
  tables: Set<string>;
  /** Index name → its table. */
  indexes: Map<string, string>;
  /** Alias or table name → the base tables it names, across every view. */
  viewAliases: Map<string, Set<string>>;
  viewCtes: Set<string>;
}
const schemaNames = new WeakMap<Database, SchemaNames>();

function aliasesIn(text: string, tables: Set<string>, into: Map<string, Set<string>>): void {
  const pattern =
    /\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/giu;
  for (const match of text.matchAll(pattern)) {
    const table = match[1]!.toLowerCase();
    if (!tables.has(table)) continue;
    const alias = match[2]?.toLowerCase();
    for (const name of [table, ...(alias && !KEYWORDS.has(alias.toUpperCase()) ? [alias] : [])]) {
      const named = into.get(name) ?? new Set<string>();
      named.add(table);
      into.set(name, named);
    }
  }
}

/** CTE names declared in `text`, and the aliases it reads them under. */
function ctesIn(text: string): Set<string> {
  const pattern =
    /(?:\bWITH|,)\s*(?:RECURSIVE\s+)?([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/giu;
  const ctes = new Set([...text.matchAll(pattern)].map((match) => match[1]!.toLowerCase()));
  const aliases = new Map<string, Set<string>>();
  aliasesIn(text, ctes, aliases);
  for (const name of aliases.keys()) ctes.add(name);
  return ctes;
}

function namesOf(db: Database): SchemaNames {
  let names = schemaNames.get(db);
  if (names !== undefined) return names;
  const rows = db.query("SELECT type, name, tbl_name, sql FROM sqlite_master").all() as {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }[];
  const tables = new Set(rows.filter((row) => row.type === "table").map((row) => row.name));
  const indexes = new Map(
    rows.filter((row) => row.type === "index").map((row) => [row.name, row.tbl_name]),
  );
  const viewAliases = new Map<string, Set<string>>();
  const viewCtes = new Set<string>();
  for (const row of rows)
    if (row.type === "view" && row.sql !== null) {
      aliasesIn(row.sql, tables, viewAliases);
      for (const cte of ctesIn(row.sql)) viewCtes.add(cte);
    }
  names = { tables, indexes, viewAliases, viewCtes };
  schemaNames.set(db, names);
  return names;
}

export interface TableScan {
  /** The plan step, as SQLite prints it. */
  step: string;
  /** The base tables the scanned name can stand for, here or in a view. */
  tables: string[];
}

/**
 * The `SCAN` steps of `plan` that read a base table (or one of its indexes)
 * from end to end. A scan of a CTE, a subquery, a `json_each` or a constant
 * row is not one: what fills a CTE is planned, and reported, on its own. The
 * scanned name is resolved against the statement and every view of `db`; a
 * name that stands for different tables in different places resolves to all
 * of them.
 */
export function tableScans(db: Database, sql: string, plan: readonly string[]): TableScan[] {
  const { tables, indexes, viewAliases, viewCtes } = namesOf(db);
  const aliases = new Map<string, Set<string>>();
  aliasesIn(sql, tables, aliases);
  const ctes = new Set([...viewCtes, ...ctesIn(sql)]);
  const scans: TableScan[] = [];
  for (const step of plan) {
    if (!step.startsWith("SCAN ") || step.includes(" VIRTUAL TABLE INDEX ")) continue;
    const name = step.slice(5).split(" ")[0]!.toLowerCase();
    // A name the statement also uses for a base table stays a table scan: the
    // plan alone cannot tell the two apart, so the caller decides.
    if (ctes.has(name) && !tables.has(name) && !aliases.has(name)) continue;
    // An index names its table exactly; a bare alias is looked up in the
    // statement first, then in the views it may come from.
    const index = /USING (?:COVERING )?INDEX (\S+)/u.exec(step)?.[1];
    const named = new Set<string>();
    if (index !== undefined && indexes.has(index)) named.add(indexes.get(index)!);
    else if (tables.has(name)) named.add(name);
    else for (const table of aliases.get(name) ?? viewAliases.get(name) ?? []) named.add(table);
    if (named.size === 0) continue;
    scans.push({ step, tables: [...named].sort() });
  }
  return scans;
}

/**
 * Every step that reads a relation from end to end: `SCAN x`, with or without
 * an index, except the ones that are bounded by construction — a `json_each`
 * of the bound values, a constant row, a materialized subquery — and the
 * names in `bounded`, which a caller lists with the reason each is bounded
 * (its own CTEs, a handful of configuration rows).
 */
export function unboundedScans(plan: readonly string[], bounded: readonly string[] = []): string[] {
  return plan.filter((detail) => {
    if (!detail.startsWith("SCAN ")) return false;
    const name = detail.slice(5).split(" ")[0]!;
    if (name === "CONSTANT" || /^\(subquery-\d+\)$/u.test(name)) return false;
    if (detail.includes(" VIRTUAL TABLE INDEX ")) return false;
    return !bounded.includes(name);
  });
}
