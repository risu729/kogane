// The identity pages against the real migrations: the SQL `kogane.identity.read`
// and `GET /api/identity/*` share, moved here from services/app (ADR 0081
// point 2). The rows themselves are covered by the App's identity tests over
// D1; this checks every collection's statement runs on the current schema in
// both read modes, filtered and not, and answers an empty store with an
// empty page.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  IDENTITY_COLLECTIONS,
  readIdentityConnections,
  readIdentityPage,
} from "../src/query/identity-pages.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { migratedDatabase } from "./sqlite-store.ts";

beforeAll(() => migratedDatabase().close(), 60_000);

function executor(db: Database): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      db.query(sql).all(...(args as (string | number | null)[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (db.query(sql).get(...(args as (string | number | null)[])) as T | null) ?? null,
  };
}

describe("identity pages", () => {
  test("the connection inventory of an empty store is empty", async () => {
    expect(await readIdentityConnections(executor(migratedDatabase()))).toEqual({
      connections: [],
    });
  });
  const collections = IDENTITY_COLLECTIONS.filter((name) => name !== "connections");
  for (const collection of collections)
    for (const mode of ["latest", "as-recorded"] as const)
      for (const source of [null, "sony-bank"])
        test(`${collection}, ${mode}, ${source === null ? "every source" : "one source"}`, async () => {
          const page = await readIdentityPage(executor(migratedDatabase()), collection, {
            source,
            offset: 0,
            mode,
          });
          expect(page).toMatchObject({
            rows: [],
            coverage: { truncated: false, nextOffset: null },
            interpretationContext: { mode },
          });
        });
});
