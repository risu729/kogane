// Minimal D1 calls used by the two sweep tests, over the real SQLite schema.
import type { Database, SQLQueryBindings } from "bun:sqlite";
export function sweepDb(
  store: Database,
  mapSql: (sql: string) => string = (sql) => sql,
  afterAll: (sql: string) => Promise<void> | void = () => {},
): D1Database {
  const prepare = (original: string) => {
    const sql = mapSql(original);
    const statement = {
      sql,
      args: [] as SQLQueryBindings[],
      bind(...args: SQLQueryBindings[]) {
        statement.args = args;
        return statement;
      },
      async first() {
        return store.query(sql).get(...statement.args) ?? null;
      },
      async all() {
        const results = store.query(sql).all(...statement.args);
        await afterAll(sql);
        return { results };
      },
      async run() {
        return { meta: store.query(sql).run(...statement.args) };
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      return store.transaction(() =>
        statements.map((statement) => ({
          meta: store.query(statement.sql).run(...statement.args),
        })),
      )();
    },
  } as unknown as D1Database;
}
