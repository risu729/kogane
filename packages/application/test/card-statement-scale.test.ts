// The statement and settlement joins of `GET /api/v2/card-purchases`
// (src/query/card-purchases.ts) on a scaled store with statement history
// (packages/read-model/test/card-usage-scale-fixture.ts, `statements`): the
// complete CORE schema, no table statistics (D1 is never analyzed), three
// Vpass cards, a MyJCB connection and two banks captured daily, every statement
// total recaptured daily, settlement reviews proposed as the sweep proposes
// them and mostly accepted. The pages equal the ones the shipped statement read
// produced, and no plan reads the whole store. CI builds `STATEMENT_CI_SCALE`;
// set KOGANE_CARD_STATEMENT_SCALE=full to build `STATEMENT_SCALE` (a few
// minutes) and print the timings docs/card-settlements.md quotes. Synthetic
// values only.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import { statementPlanProblems } from "../../read-model/test/card-statement-plan.ts";
import {
  STATEMENT_CI_SCALE,
  STATEMENT_SCALE,
  type ScaledStore,
  scaledStore,
} from "../../read-model/test/card-usage-scale-fixture.ts";
import {
  CARD_PURCHASE_PAGE_SIZE,
  queryCardPurchases,
  SETTLEMENT_SQL,
  STATEMENT_SQL,
} from "../src/query/card-purchases.ts";
import { LEGACY_STATEMENT_SQL } from "./card-statement-legacy-sql.ts";

const FULL = process.env["KOGANE_CARD_STATEMENT_SCALE"] === "full";
const TIMEOUT = FULL ? 1_800_000 : 60_000;
const INDEX = "card_settlement_candidates_statement_period";

let built: ScaledStore;
let db: Database;

beforeAll(async () => {
  built = await scaledStore(FULL ? STATEMENT_SCALE : STATEMENT_CI_SCALE);
  db = built.store.db;
}, TIMEOUT);

function rows(sql: string, args: readonly unknown[]): unknown[] {
  return db.query(sql).all(...(args as SQLQueryBindings[]));
}

const sorted = (found: unknown[]): string[] => found.map((row) => JSON.stringify(row)).sort();

/**
 * Runs every statement as given, or with the shipped statement read in its
 * place; `seen` collects the statements as given.
 */
function executor(legacy: boolean, seen: string[] = []): SqlExecutor {
  const text = (query: string): string =>
    legacy && query === STATEMENT_SQL ? LEGACY_STATEMENT_SQL : query;
  return {
    all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> => {
      seen.push(query);
      return rows(text(query), args) as T[];
    },
    first: async <T>(query: string, args: readonly unknown[]): Promise<T | null> => {
      seen.push(query);
      return (db.query(text(query)).get(...(args as SQLQueryBindings[])) as T | null) ?? null;
    },
  };
}

/** Every (account, source, period) a live posted purchase names, and some none does. */
function triples(): string {
  const found = db
    .query(
      `SELECT DISTINCT account_id,source_id,statement_period FROM current_card_purchase_recognitions
       WHERE statement_period IS NOT NULL`,
    )
    .values() as string[][];
  return JSON.stringify([
    ...found,
    ["acct-card-0", "myjcb", found[0]![2]],
    ["acct-jcb", "vpass", found[0]![2]],
    ["acct-unknown", "vpass", "2020-01"],
  ]);
}

/** Median wall time of `runs` executions, in milliseconds. */
async function timed(run: () => unknown, runs = 3): Promise<number> {
  const times: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  return Math.round(times.sort((left, right) => left - right)[Math.floor(runs / 2)]! * 10) / 10;
}

describe("card purchase statements on a scaled store without statistics", () => {
  test("the store is what D1 runs, with statement and settlement history", () => {
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const { counts } = built;
    // Every capture restates the bills of the posted months.
    expect(counts.statementTotals).toBeGreaterThan(counts.captureDays);
    expect(counts.settlement!.accepted).toBeGreaterThan(0);
    expect(counts.settlement!.candidates).toBeGreaterThan(5 * counts.settlement!.accepted);
    expect(counts.balanceObservations).toBeGreaterThan(counts.statementTotals);
  });

  test(
    "pages equal the ones the shipped statement read produced",
    async () => {
      const seen: string[] = [];
      const first = await queryCardPurchases(executor(false, seen));
      // The legacy executor has something to swap, so the comparison is not new against new.
      expect(seen).toContain(STATEMENT_SQL);
      expect(first.items).toHaveLength(CARD_PURCHASE_PAGE_SIZE);
      expect(first).toEqual(await queryCardPurchases(executor(true)));
      // The summary links every statement of the history, and most are settled.
      const totals = first.summary.statementTotals;
      expect(totals.length).toBeGreaterThan(4);
      const period = totals[Math.floor(totals.length / 2)]!.period;
      const periodPage = await queryCardPurchases(executor(false), { period });
      const linked = periodPage.items.find((item) => item.statement.status === "linked");
      expect(linked).toBeDefined();
      expect(periodPage.items.some((item) => item.settlement?.reviewStatus === "accepted")).toBe(
        true,
      );
      for (const input of [
        { offset: CARD_PURCHASE_PAGE_SIZE },
        { period },
        { eventId: linked!.eventId },
      ]) {
        const page = await queryCardPurchases(executor(false), input);
        expect(page.items.length).toBeGreaterThan(0);
        expect(page).toEqual(await queryCardPurchases(executor(true), input));
      }
    },
    TIMEOUT,
  );

  test(
    "the statement read returns the shipped rows for any set of statements",
    () => {
      const all = triples();
      const found = rows(STATEMENT_SQL, [all]);
      expect(found.length).toBeGreaterThan(4);
      expect(sorted(found)).toEqual(sorted(rows(LEGACY_STATEMENT_SQL, [all])));
      const some = JSON.stringify(
        (JSON.parse(all) as unknown[]).filter((_, index) => index % 3 === 0),
      );
      expect(sorted(rows(STATEMENT_SQL, [some]))).toEqual(
        sorted(rows(LEGACY_STATEMENT_SQL, [some])),
      );
      expect(rows(STATEMENT_SQL, ["[]"])).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "the settlement index changes no settlement row",
    () => {
      const all = triples();
      const found = rows(SETTLEMENT_SQL, [all]);
      expect(found.length).toBeGreaterThan(4);
      const definition = (
        db.query("SELECT sql FROM sqlite_master WHERE name=?").get(INDEX) as { sql: string }
      ).sql;
      db.exec(`DROP INDEX ${INDEX}`);
      try {
        expect(sorted(rows(SETTLEMENT_SQL, [all]))).toEqual(sorted(found));
        // Without it the settlement read walks every candidate for every statement.
        expect(statementPlanProblems(explain(db, SETTLEMENT_SQL, [all]), ["w"])).not.toEqual([]);
      } finally {
        db.exec(definition);
      }
    },
    TIMEOUT,
  );

  test("no read walks the balance history's owners or every settlement candidate", () => {
    const all = triples();
    expect(statementPlanProblems(explain(db, STATEMENT_SQL, [all]))).toEqual([]);
    const settlement = explain(db, SETTLEMENT_SQL, [all]);
    expect(statementPlanProblems(settlement, ["w"])).toEqual([]);
    expect(settlement.some((step) => step.detail.includes(`USING INDEX ${INDEX} (`))).toBe(true);
    // The checks see what the shipped read did: the owner of each statement
    // through the ownership view, which starts from every published parse and
    // groups every balance identity. Only the failure is asserted, not which
    // step the planner picks for it.
    expect(statementPlanProblems(explain(db, LEGACY_STATEMENT_SQL, [all]))).not.toEqual([]);
  });

  test.if(FULL)(
    "timings at full scale",
    async () => {
      const all = triples();
      const first = await queryCardPurchases(executor(false));
      const totals = first.summary.statementTotals;
      const period = totals[Math.floor(totals.length / 2)]!.period;
      const periodPage = await queryCardPurchases(executor(false), { period });
      const eventId = periodPage.items.find((item) => item.statement.status === "linked")!.eventId;
      console.log(
        JSON.stringify(
          {
            store: { ...built.counts, recognised: built.recognised },
            ms: {
              pageUnfiltered: await timed(() => queryCardPurchases(executor(false))),
              pagePeriod: await timed(() => queryCardPurchases(executor(false), { period })),
              pageEvent: await timed(() => queryCardPurchases(executor(false), { eventId })),
              statementRead: await timed(() => rows(STATEMENT_SQL, [all])),
              settlementRead: await timed(() => rows(SETTLEMENT_SQL, [all])),
              statementFactsView: await timed(() => rows("SELECT * FROM card_statement_facts", [])),
              legacyPageUnfiltered: await timed(() => queryCardPurchases(executor(true)), 1),
              legacyStatementRead: await timed(() => rows(LEGACY_STATEMENT_SQL, [all]), 1),
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
