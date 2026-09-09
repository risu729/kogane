// D1 adapter for the command store. Typed structurally so this package needs
// no Cloudflare types: a real `D1Database` satisfies `D1Like`.
import type { BatchOutcome, CommandStore, PreparedWrite } from "../command/contract.ts";

interface D1BoundLike {
  all(): Promise<{ results: unknown[] }>;
  first(): Promise<unknown>;
}
interface D1StatementLike {
  bind(...values: unknown[]): D1BoundLike;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: unknown[]): Promise<{ meta: { changes: number } }[]>;
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
    async batch(writes: readonly PreparedWrite[]): Promise<readonly BatchOutcome[]> {
      const results = await db.batch(
        writes.map((write) => db.prepare(write.sql).bind(...write.binds)),
      );
      return results.map((result) => ({ changes: result.meta.changes }));
    },
  };
}
