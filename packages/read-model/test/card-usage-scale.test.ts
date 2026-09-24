// The current card usage reads on a scaled store with the complete CORE
// schema and no table statistics, as D1 runs them (card-usage-scale-fixture.ts):
// the rewritten plans return exactly what the shipped queries returned, and no
// read walks the whole store. CI builds `CI_SCALE`; set
// KOGANE_CARD_USAGE_SCALE=full to build `FULL_SCALE` (a few minutes) and
// print the timings docs/read-model.md quotes. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  STALE_CARD_PURCHASE_KEYS_SQL,
  UNRECOGNIZED_CARD_USAGE_COUNT_SQL,
} from "../src/card-purchase-keys";
import {
  CURRENT_CARD_USAGE_SQL,
  type CurrentCardUsageRow,
  currentCardUsageSql,
  staleCardPurchaseKeysSql,
  unrecognizedCardUsageCountSql,
} from "../src/index";
import {
  LEGACY_CURRENT_CARD_USAGE_SQL,
  LEGACY_STALE_CARD_PURCHASE_KEYS_SQL,
  LEGACY_UNRECOGNIZED_CARD_USAGE_COUNT_SQL,
} from "./card-usage-legacy-sql";
import { currentRowsDriver, explain, perRowKeyProbes, unboundedScans } from "./card-usage-plan";
import {
  allCurrentUsage,
  CI_SCALE,
  FULL_SCALE,
  type ScaledStore,
  scaledStore,
} from "./card-usage-scale-fixture";

const FULL = process.env["KOGANE_CARD_USAGE_SCALE"] === "full";
const TIMEOUT = FULL ? 1_800_000 : 60_000;
const ALL_PAGES = [0, -1] as const;

let built: ScaledStore;
let db: Database;

beforeAll(async () => {
  built = await scaledStore(FULL ? FULL_SCALE : CI_SCALE);
  db = built.store.db;
}, TIMEOUT);

function rows(sql: string, args: readonly unknown[]): unknown[] {
  return db.query(sql).all(...(args as SQLQueryBindings[]));
}

/** Median wall time of `runs` executions, in milliseconds. */
function timed(sql: string, args: readonly unknown[], runs = 3): number {
  const times: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now();
    rows(sql, args);
    times.push(performance.now() - start);
  }
  return times.sort((left, right) => left - right)[Math.floor(runs / 2)]!;
}

describe("current card usage on a scaled store without statistics", () => {
  test("the store is what D1 runs: every CORE migration, no ANALYZE", () => {
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    expect(built.recognised).toBeGreaterThan(0);
    expect(built.counts.transactionObservations).toBeGreaterThan(2 * allCurrentUsage(db).length);
  });

  test(
    "the rewritten query returns the shipped query's rows, whole and page by page",
    () => {
      const current = rows(CURRENT_CARD_USAGE_SQL, ALL_PAGES) as CurrentCardUsageRow[];
      expect(current.length).toBeGreaterThan(0);
      expect(current).toEqual(
        rows(LEGACY_CURRENT_CARD_USAGE_SQL, ALL_PAGES) as CurrentCardUsageRow[],
      );
      // The lane's own paging: the same rows, in the same pages.
      const paged = allCurrentUsage(db);
      expect(paged).toEqual(current);
      const legacyPaged = allCurrentUsage(db, ({ afterId, limit }) => ({
        sql: LEGACY_CURRENT_CARD_USAGE_SQL,
        args: [afterId, limit],
      }));
      expect(legacyPaged).toEqual(paged);
      const middle = current[Math.floor(current.length / 2)]!.observation_id;
      const page = currentCardUsageSql({ afterId: middle, limit: 500 });
      expect(rows(page.sql, page.args)).toEqual(rows(LEGACY_CURRENT_CARD_USAGE_SQL, page.args));
    },
    TIMEOUT,
  );

  test(
    "stale keys and the unrecognised count equal the shipped reads",
    () => {
      for (const limit of [1, 3, 100, 1000]) {
        const stale = staleCardPurchaseKeysSql(limit);
        const found = rows(stale.sql, stale.args);
        expect(found).toEqual(rows(LEGACY_STALE_CARD_PURCHASE_KEYS_SQL, stale.args));
        if (limit === 1000) expect(found.length).toBeGreaterThan(0);
      }
      const count = unrecognizedCardUsageCountSql();
      const unrecognized = rows(count.sql, count.args);
      expect(unrecognized).toEqual(rows(LEGACY_UNRECOGNIZED_CARD_USAGE_COUNT_SQL, count.args));
      expect((unrecognized[0] as { unrecognized: number }).unrecognized).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test("no read walks the observations, parses, runs or identity rows of the whole store", () => {
    const page = currentCardUsageSql({ afterId: 0, limit: 500 });
    const usage = explain(db, page.sql, page.args);
    expect(unboundedScans(usage)).toEqual([]);
    // Every observation is reached from the current captures, never from all runs.
    expect(currentRowsDriver(usage)).toBe("SCAN candidate");
    const stale = explain(db, STALE_CARD_PURCHASE_KEYS_SQL, [...ALL_PAGES, 100]);
    // The one pass over live keys is the read's purpose: every live key is checked once.
    expect(unboundedScans(stale, ["k"])).toEqual([]);
    expect(perRowKeyProbes(stale)).toEqual([]);
    expect(stale.map((step) => step.detail)).toContain(
      "SEARCH held USING INDEX card_purchase_recognition_keys_key (recognition_key=?)",
    );
    const count = explain(db, UNRECOGNIZED_CARD_USAGE_COUNT_SQL, ALL_PAGES);
    expect(unboundedScans(count, ["usage"])).toEqual([]);

    // The checks see what the shipped plans did: every terminal report,
    // artifact, parse and observation walked before the snapshot filter, and
    // each live key probed once per current key.
    const legacy = explain(db, LEGACY_CURRENT_CARD_USAGE_SQL, page.args);
    expect(unboundedScans(legacy)).toContain(
      "SCAN t USING INDEX idx_fetch_run_reports_one_terminal",
    );
    expect(
      perRowKeyProbes(explain(db, LEGACY_STALE_CARD_PURCHASE_KEYS_SQL, [...ALL_PAGES, 100])),
    ).not.toEqual([]);
  });

  test.if(FULL)(
    "timings at full scale",
    () => {
      const page = currentCardUsageSql({ afterId: 0, limit: 500 });
      const current = allCurrentUsage(db);
      const middle = currentCardUsageSql({
        afterId: current[Math.floor(current.length / 2)]!.observation_id,
        limit: 500,
      });
      const stale = staleCardPurchaseKeysSql(100);
      const count = unrecognizedCardUsageCountSql();
      console.log(
        JSON.stringify(
          {
            store: { ...built.counts, recognised: built.recognised, currentRows: current.length },
            ms: {
              firstPage: timed(page.sql, page.args),
              midCursorPage: timed(middle.sql, middle.args),
              staleKeys100: timed(stale.sql, stale.args),
              unrecognizedCount: timed(count.sql, count.args),
              legacyFirstPage: timed(LEGACY_CURRENT_CARD_USAGE_SQL, page.args),
              legacyStaleKeys100: timed(LEGACY_STALE_CARD_PURCHASE_KEYS_SQL, stale.args, 1),
              legacyUnrecognizedCount: timed(LEGACY_UNRECOGNIZED_CARD_USAGE_COUNT_SQL, count.args),
            },
          },
          null,
          2,
        ),
      );
    },
    TIMEOUT,
  );
});
