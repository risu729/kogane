// D1 adapter for the command store: the one place a `{sql, binds}` write list
// becomes a real D1 batch. Typed structurally so this package needs no
// Cloudflare types — a real `D1Database` satisfies `D1Like`.
//
// Moved here from `packages/application/src/operations/store.ts` by U05: the
// driver is storage, the lifecycle that produces the writes is application.
import type { D1Like, D1StatementLike } from "../d1.ts";
import type { SqlWrite } from "./operations.ts";

/** What one statement of a batch reports back; `changes` is the guard signal. */
export interface BatchOutcome {
  changes: number;
}

/** Statement execution, as the command lifecycle needs it. */
export interface CommandStore {
  first<T>(sql: string, binds?: readonly unknown[]): Promise<T | null>;
  all<T>(sql: string, binds?: readonly unknown[]): Promise<T[]>;
  /** One transaction. Every statement after the first is guarded on its effect. */
  batch(writes: readonly SqlWrite[]): Promise<readonly BatchOutcome[]>;
}

export function d1CommandStore(db: D1Like): CommandStore {
  return {
    async first<T>(sql: string, binds: readonly unknown[] = []): Promise<T | null> {
      return (await db
        .prepare(sql)
        .bind(...binds)
        .first()) as T | null;
    },
    async all<T>(sql: string, binds: readonly unknown[] = []): Promise<T[]> {
      const result = await db
        .prepare(sql)
        .bind(...binds)
        .all();
      return result.results as T[];
    },
    async batch(writes: readonly SqlWrite[]): Promise<readonly BatchOutcome[]> {
      const statements: D1StatementLike[] = writes.map((write) =>
        db.prepare(write.sql).bind(...write.binds),
      );
      const results = await db.batch(statements);
      return results.map((result) => ({ changes: result.meta.changes }));
    },
  };
}
