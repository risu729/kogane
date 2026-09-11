// The D1 surface this package binds against, typed structurally so nothing
// here needs the Cloudflare Worker types: a real `D1Database` satisfies
// `D1Like` and a real `D1PreparedStatement` satisfies `D1StatementLike`. The
// same trick already keeps `packages/read-model` and `packages/application`
// free of `@cloudflare/workers-types`; this module is the shared definition
// they and the CORE adapters below now share.
//
// Only the four operations the adapters use are declared. In particular
// `batch` is kept, because a guarded batch — not a SELECT followed by a write
// — is how every atomic command in `src/atomic/` keeps its guard (09 §2).

/** A prepared statement, bound or not. `bind` returns the same shape so a
 * statement can be handed to `batch` after binding. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1RunResultLike>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  /**
   * Rows as positional arrays, in the order of the select list. A real
   * `D1PreparedStatement` has had this since D1 shipped; it is declared here
   * because the Drizzle pilot's row mapper reads results positionally rather
   * than by key (`src/drizzle/`, decision D11). Nothing in `src/core/` or
   * `src/atomic/` uses it.
   */
  raw<T = unknown[]>(): Promise<T[]>;
}

/**
 * What a write reports back. `changes` is the guard signal: a conditional
 * INSERT/UPDATE that matched nothing reports 0 and writes nothing.
 *
 * `changes` is **not** a count of the rows the statement itself wrote: D1
 * counts rows written by triggers too, and since migration 0038 every write to
 * a dependency-ledger table also bumps the CORE revision. A count that has to
 * mean "the rows this statement wrote" therefore reads `results` from a
 * `RETURNING` clause instead (docs/projection-input.md).
 */
export interface D1RunResultLike {
  meta: { changes: number };
  /** Rows a `RETURNING` clause produced; absent when there is no such clause. */
  results?: Record<string, unknown>[];
}

export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1RunResultLike[]>;
}

/** An untyped row as D1 returns it. */
export type Row = Record<string, unknown>;

export async function first<T>(
  db: D1Like,
  sql: string,
  binds: readonly unknown[] = [],
): Promise<T | null> {
  return await db
    .prepare(sql)
    .bind(...binds)
    .first<T>();
}

export async function all<T>(
  db: D1Like,
  sql: string,
  binds: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return result.results;
}

export async function run(
  db: D1Like,
  sql: string,
  binds: readonly unknown[] = [],
): Promise<D1RunResultLike> {
  return await db
    .prepare(sql)
    .bind(...binds)
    .run();
}

/** Executes one guarded batch. Callers that hold a real `D1Database` use this
 * rather than `db.batch(...)` directly, because the statements a command
 * builds are typed as this package's structural statement. */
export async function runBatch(
  db: D1Like,
  statements: readonly D1StatementLike[],
): Promise<D1RunResultLike[]> {
  return await db.batch([...statements]);
}

export function statement(
  db: D1Like,
  sql: string,
  binds: readonly unknown[] = [],
): D1StatementLike {
  return db.prepare(sql).bind(...binds);
}
