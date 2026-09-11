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
}

/** What a write reports back. `changes` is the guard signal: a conditional
 * INSERT/UPDATE that matched nothing reports 0 and writes nothing. */
export interface D1RunResultLike {
  meta: { changes: number };
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

export function statement(
  db: D1Like,
  sql: string,
  binds: readonly unknown[] = [],
): D1StatementLike {
  return db.prepare(sql).bind(...binds);
}
