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
import { STATEMENT_SLOT_CURRENT_CARD_USAGE_SQL } from "../../read-model/test/card-usage-legacy-sql.ts";
import {
  currentRowsDriver,
  explain,
  unboundedScans,
} from "../../read-model/test/card-usage-plan.ts";
import { CI_SCALE, scaledStore } from "../../read-model/test/card-usage-scale-fixture.ts";
import {
  CARD_PURCHASE_PAGE_SIZE,
  CURRENT_SQL,
  queryCardPurchases,
} from "../src/query/card-purchases.ts";
import { LEGACY_CURRENT_SQL } from "./card-purchase-current-legacy-sql.ts";

let db: Database;

beforeAll(async () => {
  db = (await scaledStore(CI_SCALE)).store.db;
}, 60_000);

/**
 * Runs every statement as given, or with the shipped current card usage query
 * in its place (with the MyJCB statement-slot rules of ADR 0007 and ADR 0016
 * substituted, card-usage-legacy-sql.ts); `seen` collects the statements as given.
 */
function executor(legacy: boolean, seen: string[] = []): SqlExecutor {
  // A function replacement: the query text is never read for `$` patterns.
  const text = (query: string): string =>
    legacy
      ? query.replaceAll(CURRENT_CARD_USAGE_SQL, () => STATEMENT_SLOT_CURRENT_CARD_USAGE_SQL)
      : query;
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
  test("the pass over current usage keeps the shipped current keys and count", () => {
    const held = (
      db.query("SELECT DISTINCT recognition_key FROM current_card_purchase_keys").all() as {
        recognition_key: string;
      }[]
    ).map((row) => row.recognition_key);
    const unheld = (
      db.query(`SELECT recognition_key FROM (${CURRENT_CARD_USAGE_SQL})`).all(0, -1) as {
        recognition_key: string | null;
      }[]
    )
      .map((row) => row.recognition_key)
      .filter((key): key is string => key !== null && !held.includes(key));
    expect(unheld.length).toBeGreaterThan(0);
    // Empty, held only, unheld only (a key both on the list and unrecognised),
    // and a mix with a key no row has.
    const lists = [[], held, unheld, [...held.slice(0, 50), ...unheld.slice(0, 5), '["none"]']];
    for (const keys of lists) {
      const json = JSON.stringify(keys);
      const legacy = db.query(LEGACY_CURRENT_SQL).all(0, -1, json) as {
        current_key: string | null;
        unrecognized: number | null;
      }[];
      const rows = db.query(CURRENT_SQL).all(0, -1, json, 3) as {
        recognition_key: string | null;
        on_page: number;
        unrecognized: number;
        unrecognized_total: number;
      }[];
      const keysOf = (values: (string | null)[]) =>
        [...new Set(values.filter((key): key is string => key !== null))].sort();
      expect(
        keysOf(rows.filter((row) => row.on_page === 1).map((row) => row.recognition_key)),
      ).toEqual(keysOf(legacy.map((row) => row.current_key)));
      expect(rows[0]?.unrecognized_total ?? 0).toBe(
        legacy.find((row) => row.current_key === null)!.unrecognized!,
      );
    }
  });

  test("pages equal the ones the shipped current usage query produced", async () => {
    const seen: string[] = [];
    const first = await queryCardPurchases(executor(false, seen));
    // The legacy executor has something to swap, so the comparison is not new against new.
    expect(seen.some((query) => query.includes(CURRENT_CARD_USAGE_SQL))).toBe(true);
    expect(first.items).toHaveLength(CARD_PURCHASE_PAGE_SIZE);
    expect(first.coverage.unrecognizedCurrentRows).toBeGreaterThan(0);
    expect(first.coverage.unrecognizedReasons.counts.length).toBeGreaterThan(0);
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
    // The wrapper's own relations: the materialized usage, the page's key list and the
    // ranked unrecognised rows, each read once.
    const steps = explain(db, usage[0]!, [0, -1, "[]", 1000]);
    expect(unboundedScans(steps, ["usage", "u", "json_each", "ranked"])).toEqual([]);
    expect(currentRowsDriver(steps)).toMatch(/^SCAN candidate\b/u);
  });
});
