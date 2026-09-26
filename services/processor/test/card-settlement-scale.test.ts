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
import { cardSettlementReadinessCtes } from "../../../packages/read-model/src/card-settlement-readiness.ts";
import { cardSettlementCommitGuardSql } from "../src/card-settlement-commands.ts";
import {
  CARD_SETTLEMENT_BANK_DEBITS_SQL,
  CARD_SETTLEMENT_STATEMENTS_SQL,
  cardSettlementSweep,
} from "../src/card-settlement-job.ts";
import {
  LEGACY_CARD_SETTLEMENT_BANK_DEBITS_SQL,
  LEGACY_CARD_SETTLEMENT_STATEMENTS_SQL,
  legacyCardSettlementCommitGuardSql,
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
 * Whether the sweep can date a bank row: before migration 0052 it skipped an
 * SMBC row whose `as_of` failed this regex after reading it; the bank read now
 * leaves such rows out by `debit_date`, and an SBI Shinsei row needs its
 * posting date as `YYYY-MM-DD`.
 */
const SWEEP_DATE = {
  "smbc-bank": /^([0-9]{4}-[0-9]{2}-[0-9]{2})T00:00:00[+]09:00$/u,
  "sbi-shinsei-bank": /^([0-9]{4}-[0-9]{2}-[0-9]{2})$/u,
} as Record<string, RegExp>;
const datable = (row: { adapter: string; as_of: string | null }): boolean =>
  SWEEP_DATE[row.adapter]?.test(row.as_of ?? "") ?? false;

/**
 * Both texts' reads from every cursor, with each page size, and around every
 * due date, with the sweep's bank limit (and, around the first, a limit of
 * one); returns the rows seen. The bank read returns the shipped read's rows
 * the sweep can date, in its order, up to the limit: the shipped read also
 * returned rows the sweep then skipped, and counted them against the limit.
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
      const shipped = rows(store, LEGACY_CARD_SETTLEMENT_BANK_DEBITS_SQL, [date, date, -1]) as {
        adapter: string;
        as_of: string | null;
      }[];
      expect(found).toEqual(shipped.filter(datable).slice(0, limit));
      for (const row of found as { adapter: string; as_of: string; debit_date: string }[])
        expect(row.debit_date).toBe(SWEEP_DATE[row.adapter]!.exec(row.as_of)![1]!);
      banks += found.length;
    }
  return { statements, banks };
}

/** A commit guard as a query: 1 when the reservation may write. */
const guardQuery = (sql: string): string => `SELECT ${sql} AS ok`;

/**
 * Both texts of the commit guard for each review in `ids`, at its own revision
 * and the next, under its own status and another, for an acceptance and not;
 * returns the guards that held and failed.
 */
function sameGuards(store: Database, ids: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    const review = store
      .query("SELECT revision,status FROM card_settlement_reviews WHERE id=?")
      .get(id) as { revision: number; status: string } | null;
    const revision = review?.revision ?? 0;
    for (const accept of [true, false])
      for (const expected of [revision, revision + 1])
        for (const status of [review?.status ?? "proposed", "accepted"]) {
          const args = [id, expected, status];
          const [found] = rows(store, guardQuery(cardSettlementCommitGuardSql(accept)), args) as {
            ok: number;
          }[];
          expect(found as unknown).toEqual(
            rows(store, guardQuery(legacyCardSettlementCommitGuardSql(accept)), args)[0],
          );
          seen.add(`${accept ? "accept" : "other"} guard ${found!.ok}`);
        }
  }
  return seen;
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
    "the commit guard holds and fails exactly where the shipped one did",
    () => {
      // Every accepted and rejected review, the newest proposed ones, and an id no review has.
      const ids = (
        db
          .query(
            `SELECT id FROM (SELECT id,status,row_number() OVER (PARTITION BY status ORDER BY created_at DESC,id DESC) AS n
              FROM card_settlement_reviews) WHERE n<=? ORDER BY id`,
          )
          .values(FULL ? 2 : 12) as string[][]
      ).map(([id]) => id!);
      // And reviews the keyed readiness finds ready, so the guard also holds.
      const ready = (
        db
          .query(
            `WITH chosen AS (SELECT id FROM card_settlement_candidates), ${cardSettlementReadinessCtes()}
             SELECT id FROM readiness WHERE statement_current=1 AND bank_current=1
              AND ownership_current=1 AND allocation_available=1 ORDER BY id LIMIT 3`,
          )
          .values() as string[][]
      ).map(([id]) => id!);
      expect(ready.length).toBeGreaterThan(0);
      const seen = sameGuards(db, [...ids, ...ready, "cs_missing"]);
      expect(seen).toContain("accept guard 1");
      expect(seen).toContain("accept guard 0");
    },
    TIMEOUT,
  );

  test("the commit guard judges its own review only", () => {
    const id = (
      db.query("SELECT id FROM card_settlement_reviews WHERE status='proposed' LIMIT 1").get() as {
        id: string;
      }
    ).id;
    for (const accept of [true, false]) {
      const args = [id, 0, "proposed"];
      expect(
        statementPlanProblems(explain(db, guardQuery(cardSettlementCommitGuardSql(accept)), args)),
      ).toEqual([]);
    }
    // The shipped guard read the readiness view, which owns every identity of the store.
    expect(
      statementPlanProblems(
        explain(db, guardQuery(legacyCardSettlementCommitGuardSql(true)), [id, 0, "proposed"]),
      ),
    ).not.toEqual([]);
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
      const id = (
        db
          .query("SELECT id FROM card_settlement_reviews WHERE status='proposed' LIMIT 1")
          .get() as {
          id: string;
        }
      ).id;
      const guardArgs = [id, 0, "proposed"];
      console.log(
        JSON.stringify(
          {
            ms: {
              acceptGuard: timed(() =>
                rows(db, guardQuery(cardSettlementCommitGuardSql(true)), guardArgs),
              ),
              rejectGuard: timed(() =>
                rows(db, guardQuery(cardSettlementCommitGuardSql(false)), guardArgs),
              ),
              legacyAcceptGuard: timed(
                () => rows(db, guardQuery(legacyCardSettlementCommitGuardSql(true)), guardArgs),
                1,
              ),
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

  test("every review's commit guard holds and fails exactly where the shipped one did", () => {
    const seen = new Set<string>();
    // The readiness CTEs' own seeds (packages/read-model): few random reviews are ready.
    for (let seed = 1; seed <= Math.max(12, SEED_COUNT); seed += 1) {
      const store = randomSettlementStore(seed, new Set()).db;
      const ids = (
        store.query("SELECT id FROM card_settlement_candidates ORDER BY id").values() as string[][]
      ).map(([id]) => id!);
      for (const state of sameGuards(store, [...ids, "cs_missing"])) seen.add(state);
    }
    expect([...seen].sort()).toEqual([
      "accept guard 0",
      "accept guard 1",
      "other guard 0",
      "other guard 1",
    ]);
  }, 180_000);
});
