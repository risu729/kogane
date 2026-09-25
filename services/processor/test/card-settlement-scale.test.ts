// The settlement sweep's statement and bank reads (src/card-settlement-job.ts)
// on the scaled store with statement history of
// packages/read-model/test/card-usage-scale-fixture.ts (`statements`): the
// complete CORE schema on bun:sqlite, no table statistics (D1 is never
// analyzed). The reads return exactly what the shipped ones did, there and on
// small random stores, no plan reads the whole store's owners, and the sweep
// itself, run over the store, finds every review the fixture proposed already
// written. CI builds `STATEMENT_CI_SCALE`; KOGANE_CARD_STATEMENT_SCALE=full
// builds `STATEMENT_SCALE` and prints the timings docs/card-settlements.md
// quotes. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { randomSettlementStore } from "../../../packages/read-model/test/card-settlement-random-store.ts";
import { statementPlanProblems } from "../../../packages/read-model/test/card-statement-plan.ts";
import { explain } from "../../../packages/read-model/test/card-usage-plan.ts";
import {
  STATEMENT_CI_SCALE,
  STATEMENT_SCALE,
  type ScaledStore,
  scaledStore,
} from "../../../packages/read-model/test/card-usage-scale-fixture.ts";
import {
  CARD_SETTLEMENT_BANK_DEBITS_SQL,
  CARD_SETTLEMENT_STATEMENTS_SQL,
  cardSettlementSweep,
} from "../src/card-settlement-job.ts";
import {
  LEGACY_CARD_SETTLEMENT_BANK_DEBITS_SQL,
  LEGACY_CARD_SETTLEMENT_STATEMENTS_SQL,
} from "./card-settlement-legacy-sql.ts";

const FULL = process.env["KOGANE_CARD_STATEMENT_SCALE"] === "full";
const TIMEOUT = FULL ? 1_800_000 : 60_000;
/** The sweep's page and bank limits (src/card-settlement-job.ts). */
const PAGE = 100;
const BANK_LIMIT = 1000;

let built: ScaledStore;
let db: Database;

beforeAll(async () => {
  built = await scaledStore(FULL ? STATEMENT_SCALE : STATEMENT_CI_SCALE);
  db = built.store.db;
}, TIMEOUT);

function rows(store: Database, sql: string, args: readonly unknown[]): unknown[] {
  return store.query(sql).all(...(args as SQLQueryBindings[]));
}

/** `D1Database` over bun:sqlite: the calls the sweep makes, nothing more. */
function d1(store: Database): D1Database {
  const prepare = (sql: string) => {
    let binds: SQLQueryBindings[] = [];
    const statement = {
      bind: (...values: SQLQueryBindings[]) => {
        binds = values;
        return statement;
      },
      first: async () => store.query(sql).get(...binds) ?? null,
      all: async () => ({ results: store.query(sql).all(...binds) }),
      run: async () => ({ meta: { changes: store.query(sql).run(...binds).changes } }),
    };
    return statement;
  };
  return { prepare } as unknown as D1Database;
}

/** Cursors worth reading from: the start, inside, at and past the last statement. */
function cursors(store: Database): number[] {
  const ids = (
    store.query("SELECT id FROM card_statement_facts ORDER BY id").values() as number[][]
  ).map(([id]) => id!);
  const last = ids.at(-1) ?? 0;
  return [0, ids[Math.floor(ids.length / 2)] ?? 0, last - 1, last, last + 1];
}

/** Every due date the statements carry, and a date no debit is near. */
function dueDates(store: Database): string[] {
  const dates = (
    store
      .query(
        "SELECT DISTINCT payment_date FROM card_statement_facts WHERE payment_date IS NOT NULL ORDER BY 1",
      )
      .values() as string[][]
  ).map(([date]) => date!);
  return [...dates, "2000-01-01"];
}

/**
 * Both texts' reads from every cursor, with each page size, and around every
 * due date, with the sweep's bank limit (and, around the first, a limit of
 * one); returns the rows seen.
 */
function sameReads(
  store: Database,
  pages: readonly number[],
): { statements: number; banks: number } {
  let statements = 0;
  let banks = 0;
  for (const cursor of cursors(store))
    for (const limit of pages) {
      const found = rows(store, CARD_SETTLEMENT_STATEMENTS_SQL, [cursor, limit]);
      expect(found).toEqual(rows(store, LEGACY_CARD_SETTLEMENT_STATEMENTS_SQL, [cursor, limit]));
      statements += found.length;
    }
  for (const [index, date] of dueDates(store).entries())
    for (const limit of index === 0 ? [1, BANK_LIMIT] : [BANK_LIMIT]) {
      const found = rows(store, CARD_SETTLEMENT_BANK_DEBITS_SQL, [date, date, limit]);
      expect(found).toEqual(
        rows(store, LEGACY_CARD_SETTLEMENT_BANK_DEBITS_SQL, [date, date, limit]),
      );
      banks += found.length;
    }
  return { statements, banks };
}

/** Median wall time of `runs` executions, in milliseconds. */
function timed(run: () => unknown, runs = 3): number {
  const times: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return Math.round(times.sort((left, right) => left - right)[Math.floor(runs / 2)]! * 10) / 10;
}

describe("the settlement sweep's reads on a scaled store without statistics", () => {
  test(
    "the statement and bank reads return the shipped rows",
    () => {
      const seen = sameReads(db, [1, 7, PAGE]);
      expect(seen.statements).toBeGreaterThan(0);
      expect(seen.banks).toBeGreaterThan(0);
      // The rows carry owners: the comparison is not of empty ownership.
      const page = rows(db, CARD_SETTLEMENT_STATEMENTS_SQL, [0, PAGE]) as {
        owner_ref: string | null;
      }[];
      expect(page.every((row) => row.owner_ref !== null)).toBe(true);
    },
    TIMEOUT,
  );

  test("no read walks the owners of the whole store", () => {
    const [date] = dueDates(db);
    const reads: [string, string, unknown[]][] = [
      [CARD_SETTLEMENT_STATEMENTS_SQL, LEGACY_CARD_SETTLEMENT_STATEMENTS_SQL, [0, PAGE]],
      [
        CARD_SETTLEMENT_BANK_DEBITS_SQL,
        LEGACY_CARD_SETTLEMENT_BANK_DEBITS_SQL,
        [date, date, BANK_LIMIT],
      ],
    ];
    for (const [sql, legacy, args] of reads) {
      expect(statementPlanProblems(explain(db, sql, args))).toEqual([]);
      // The checks see what the shipped reads did: the ownership view, which
      // starts from every published parse and groups every identity of a kind.
      expect(statementPlanProblems(explain(db, legacy, args))).not.toEqual([]);
    }
  });

  test(
    "the sweep over the store proposes nothing the fixture has not written",
    async () => {
      const before = (
        db.query("SELECT count(*) AS n FROM card_settlement_candidates").get() as { n: number }
      ).n;
      const statements = (
        db.query("SELECT count(*) AS n FROM card_statement_facts").get() as { n: number }
      ).n;
      let proposed = 0;
      let written = 0;
      // One full cycle of the cursor over every current statement.
      for (let tick = 0; tick <= Math.ceil(statements / PAGE); tick += 1) {
        const result = await cardSettlementSweep(d1(db));
        proposed += result.proposed;
        written += result.written;
      }
      expect(proposed).toBeGreaterThan(0);
      expect(written).toBe(0);
      expect(
        (db.query("SELECT count(*) AS n FROM card_settlement_candidates").get() as { n: number }).n,
      ).toBe(before);
    },
    TIMEOUT,
  );

  test.if(FULL)(
    "timings at full scale",
    () => {
      const [date] = dueDates(db);
      console.log(
        JSON.stringify(
          {
            ms: {
              cursorCheck: timed(() =>
                rows(db, "SELECT 1 FROM card_statement_facts WHERE id>? LIMIT 1", [0]),
              ),
              statementPage: timed(() => rows(db, CARD_SETTLEMENT_STATEMENTS_SQL, [0, PAGE])),
              bankDebits: timed(() =>
                rows(db, CARD_SETTLEMENT_BANK_DEBITS_SQL, [date, date, BANK_LIMIT]),
              ),
              bankDebitView: timed(() => rows(db, "SELECT * FROM card_bank_debit_facts", [])),
              legacyStatementPage: timed(
                () => rows(db, LEGACY_CARD_SETTLEMENT_STATEMENTS_SQL, [0, PAGE]),
                1,
              ),
              legacyBankDebits: timed(
                () => rows(db, LEGACY_CARD_SETTLEMENT_BANK_DEBITS_SQL, [date, date, BANK_LIMIT]),
                1,
              ),
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

/**
 * CI draws seeds 1–4 (the ownership CTEs themselves are compared on more in
 * packages/read-model); KOGANE_CARD_SETTLEMENT_SEEDS=n draws seeds 1–n.
 */
const SEED_COUNT = Number(process.env["KOGANE_CARD_SETTLEMENT_SEEDS"] ?? 4);
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1)
  throw new Error("KOGANE_CARD_SETTLEMENT_SEEDS must be a positive integer");

describe("the settlement sweep's reads on random stores", () => {
  test.each(Array.from({ length: SEED_COUNT }, (_, index) => index + 1))(
    "seed %i: the shipped rows from every cursor and around every due date",
    (seed) => {
      const store = randomSettlementStore(seed, new Set()).db;
      const seen = sameReads(store, [1, PAGE]);
      expect(seen.statements).toBeGreaterThan(0);
    },
  );
});
