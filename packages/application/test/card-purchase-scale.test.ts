// `GET /api/v2/card-purchases` (src/query/card-purchases.ts) on the scaled card
// store of packages/read-model/test/card-usage-scale-fixture.ts: the complete
// CORE schema, no table statistics (D1 is never analyzed), captures of several
// cards over months and live events written through the guarded recognition
// builder. The page is the one the shipped current card usage query produced,
// and its one pass over current usage starts from the current captures.
// Synthetic values only.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { CURRENT_CARD_USAGE_SQL } from "../../read-model/src/card-usage.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { LEGACY_CURRENT_CARD_USAGE_SQL } from "../../read-model/test/card-usage-legacy-sql.ts";
import {
  currentRowsDriver,
  explain,
  unboundedScans,
} from "../../read-model/test/card-usage-plan.ts";
import { CI_SCALE, scaledStore } from "../../read-model/test/card-usage-scale-fixture.ts";
import { CARD_PURCHASE_PAGE_SIZE, queryCardPurchases } from "../src/query/card-purchases.ts";

let db: Database;

beforeAll(async () => {
  db = (await scaledStore(CI_SCALE)).store.db;
}, 60_000);

/**
 * Runs every statement as given, or with the shipped current card usage query
 * in its place; `seen` collects the statements as given.
 */
function executor(legacy: boolean, seen: string[] = []): SqlExecutor {
  // A function replacement: the query text is never read for `$` patterns.
  const text = (query: string): string =>
    legacy ? query.replaceAll(CURRENT_CARD_USAGE_SQL, () => LEGACY_CURRENT_CARD_USAGE_SQL) : query;
  return {
    all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> => {
      seen.push(query);
      return db.query(text(query)).all(...(args as SQLQueryBindings[])) as T[];
    },
    first: async <T>(query: string, args: readonly unknown[]): Promise<T | null> => {
      seen.push(query);
      return (db.query(text(query)).get(...(args as SQLQueryBindings[])) as T | null) ?? null;
    },
  };
}

describe("card purchases on a scaled store without statistics", () => {
  test("pages equal the ones the shipped current usage query produced", async () => {
    const seen: string[] = [];
    const first = await queryCardPurchases(executor(false, seen));
    // The legacy executor has something to swap, so the comparison is not new against new.
    expect(seen.some((query) => query.includes(CURRENT_CARD_USAGE_SQL))).toBe(true);
    expect(first.items).toHaveLength(CARD_PURCHASE_PAGE_SIZE);
    expect(first.coverage.unrecognizedCurrentRows).toBeGreaterThan(0);
    expect(first).toEqual(await queryCardPurchases(executor(true)));
    // The stored period is already `YYYY-MM` (`statementPeriod` in the domain).
    const inputs = [
      { offset: CARD_PURCHASE_PAGE_SIZE },
      { period: first.items[0]!.statementPeriod! },
    ];
    for (const input of inputs) {
      const page = await queryCardPurchases(executor(false), input);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page).toEqual(await queryCardPurchases(executor(true), input));
    }
  });

  test("its pass over current usage starts from the current captures", async () => {
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const seen: string[] = [];
    await queryCardPurchases(executor(false, seen));
    const usage = seen.filter((query) => query.includes(CURRENT_CARD_USAGE_SQL));
    expect(usage).toHaveLength(1);
    // The wrapper's own relations: the materialized usage and the page's key list.
    const steps = explain(db, usage[0]!, [0, -1, "[]"]);
    expect(unboundedScans(steps, ["usage", "u", "json_each"])).toEqual([]);
    expect(currentRowsDriver(steps)).toMatch(/^SCAN candidate\b/u);
  });
});
