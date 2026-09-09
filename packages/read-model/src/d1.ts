// D1 adapter. Typed structurally so this package needs no Cloudflare types:
// a real `D1Database` satisfies `D1Like`, and so does a read-only wrapper
// that only exposes `prepare`.

import { createObservationReader } from "./observation-reader";
import type { ObservationReader, ReaderOptions, SqlExecutor } from "./reader";

export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results: unknown[] }>;
      first(): Promise<unknown>;
    };
  };
}

export function d1Executor(db: D1Like): SqlExecutor {
  return {
    async all<T>(sql: string, args: readonly unknown[]): Promise<T[]> {
      const result = await db
        .prepare(sql)
        .bind(...args)
        .all();
      return result.results as T[];
    },
    async first<T>(sql: string, args: readonly unknown[]): Promise<T | null> {
      return (await db
        .prepare(sql)
        .bind(...args)
        .first()) as T | null;
    },
  };
}

export function createD1ObservationReader(
  db: D1Like,
  options: ReaderOptions = {},
): ObservationReader {
  return createObservationReader(d1Executor(db), options);
}
