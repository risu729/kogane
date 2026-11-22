// `undatedTransactions`: the current transactions a `from`/`to` window
// of `listTransactions` leaves out because their `as_of` starts with no
// calendar date (INV05). The window's own SQL is not changed: its date check
// is the shipped text, frozen below, and the count reads the same row set
// with that check's exact complement. On seeded random stores, every scope's
// unwindowed rows are the rows the widest window places plus the rows
// counted, and the count equals an independent oracle per source account.
// Synthetic only: seeded source ids, placeholder accounts and descriptions.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CALENDAR_DATED_AS_OF,
  type CollectionScope,
  createObservationReader,
  scopePredicates,
  type SqlExecutor,
} from "../src/index";
import { transactionsSql, undatedTransactionsSql } from "../src/sql";
import { explain, type PlanStep } from "./card-usage-plan";
import {
  publishTransactions,
  QualityStore,
  type SyntheticTransaction,
} from "./transaction-shapes-store";

/** The window predicates as shipped before the count existed; never edit by hand. */
const LEGACY_WINDOW_WHERE =
  "date(substr(as_of,1,10), '+0 days') = substr(as_of,1,10) AND substr(as_of,1,10) >= ? AND substr(as_of,1,10) <= ?";

function executor(store: QualityStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

/** Every row of `scope`, read page by page through the shipped SQL. */
function allRows(store: QualityStore, scope: CollectionScope): { id: number }[] {
  const out: { id: number }[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = transactionsSql(scope, offset);
    const rows = store.db.query(page.sql).all(...(page.args as SQLQueryBindings[])) as {
      id: number;
    }[];
    out.push(...rows.slice(0, 500));
    if (rows.length <= 500) return out;
  }
}

/** Independent of SQLite: a real `YYYY-MM-DD` day at the start of the text. */
function calendarDated(asOf: string | null): boolean {
  if (asOf === null) return false;
  const day = asOf.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return last !== undefined && date >= 1 && date <= last;
}

const SHAPES = [
  () => null,
  () => "2026-03",
  () => "2026-02-30",
  () => "2026-13-01",
  () => "",
  () => "not a date",
  () => "2026",
  () => "2026/03/04",
];

/** The derived set a read wraps: the text inside its outermost `FROM (...)`. */
function innerSet(sql: string): string {
  const start = sql.indexOf("FROM (") + "FROM (".length;
  const last = "WHERE rank_in_identity = 1";
  const end = sql.lastIndexOf(last) + last.length;
  expect(sql.slice(end, end + 2)).toBe(")\n");
  return sql.slice(start, end);
}

/** The relations a plan reads, by kind, subquery numbers erased, as a sorted multiset. */
function reads(steps: readonly PlanStep[]): string[] {
  return steps
    .map((step) => step.detail)
    .filter((detail) => /^(SCAN|SEARCH|MATERIALIZE|CO-ROUTINE) /u.test(detail))
    .map((detail) => detail.replace(/subquery-\d+/gu, "subquery"))
    .sort();
}

describe("the window's date check is unchanged", () => {
  test("the from/to predicates are the shipped text", () => {
    expect(scopePredicates({ from: "2026-01-01", to: "2026-01-31" }, ["from", "to"]).where).toBe(
      LEGACY_WINDOW_WHERE,
    );
    expect(LEGACY_WINDOW_WHERE.startsWith(CALENDAR_DATED_AS_OF)).toBe(true);
  });
});

describe("the count reads the list's own row set", () => {
  test("the derived set is TRANSACTIONS_SQL's text, byte for byte, for every scope", () => {
    for (const scope of [
      {},
      { source: "paypay" },
      { account: "account-1" },
      { source: "paypay", account: "account-1", q: "alpha" },
    ]) {
      const list = transactionsSql({ ...scope, from: "2026-01-01" }, 0);
      const count = undatedTransactionsSql(scope);
      expect(innerSet(count.sql)).toBe(innerSet(list.sql));
      expect(innerSet(count.sql).length).toBeGreaterThan(1000);
      // The same filters, in the same order, with the window's date check
      // turned into its complement and its bounds dropped.
      const listWhere = scopePredicates({ ...scope, from: "2026-01-01" }, [
        "source",
        "account",
        "from",
        "q",
      ]);
      const countWhere = scopePredicates(scope, ["source", "account", "q"]);
      expect(listWhere.where).toBe(
        countWhere.where === "1"
          ? `${CALENDAR_DATED_AS_OF} AND substr(as_of,1,10) >= ?`
          : countWhere.where.replace(
              /( AND \(instr|$)/u,
              ` AND ${CALENDAR_DATED_AS_OF} AND substr(as_of,1,10) >= ?$1`,
            ),
      );
      expect(count.sql).toContain(
        `WHERE ${countWhere.where} AND (${CALENDAR_DATED_AS_OF}) IS NOT 1`,
      );
      expect(count.args).toEqual(countWhere.args);
    }
  });

  test("without table statistics, the count's plan reads what the windowed list reads and nothing more", () => {
    const store = new QualityStore();
    try {
      publishTransactions(store, "paypay", "synthetic-activity", [
        { asOf: "2026-03-04", account: "account-1" },
        { asOf: null, account: "account-2" },
      ]);
      // The store is what D1 runs: every CORE migration, no ANALYZE.
      expect(
        store.db
          .query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'")
          .get(),
      ).toEqual({ n: 0 });
      for (const scope of [
        {},
        { source: "paypay" },
        { account: "account-1" },
        { source: "paypay", account: "account-1", q: "alpha" },
      ]) {
        const list = transactionsSql({ ...scope, from: "2026-01-01", to: "2026-12-31" }, 0);
        const count = undatedTransactionsSql(scope);
        const listReads = reads(explain(store.db, list.sql, list.args));
        const countReads = reads(explain(store.db, count.sql, count.args));
        expect(countReads.length).toBeGreaterThan(20);
        // Every scan or search of the count is one the list makes, as many times.
        expect(countReads).toEqual(listReads);
      }
    } finally {
      store.db.close();
    }
  });
});

describe("undatedTransactions", () => {
  test("counts null, year-month and impossible-day rows per account, and no row a window places", async () => {
    const store = new QualityStore();
    try {
      publishTransactions(store, "paypay", "synthetic-activity", [
        { asOf: "2026-03-04", account: "account-1" },
        { asOf: "2026-03-04T10:00:00", account: "account-1" },
        { asOf: "2026-03-05T05:00:00+09:00", account: "account-1" },
        { asOf: "2026-03-03T23:00:00.000Z", account: "account-1" },
        { asOf: null, account: "account-1" },
        { asOf: "2026-03", account: "account-2" },
        { asOf: "2026-02-30", account: "account-2" },
      ]);
      const reader = createObservationReader(executor(store));
      expect(await reader.undatedTransactions({})).toEqual([
        { source_id: "paypay", source_account: "account-1", row_count: 1 },
        { source_id: "paypay", source_account: "account-2", row_count: 2 },
      ]);
      expect(await reader.undatedTransactions({ account: "account-2" })).toEqual([
        { source_id: "paypay", source_account: "account-2", row_count: 2 },
      ]);
      expect(await reader.undatedTransactions({ source: "wise" })).toEqual([]);
      // The window drops exactly the counted rows.
      const placed = (await reader.listTransactions({ from: "0001-01-01", offset: 0 })).length;
      expect(placed).toBe(4);
      expect((await reader.listTransactions({ offset: 0 })).length).toBe(7);
    } finally {
      store.db.close();
    }
  });

  test("on random stores, unwindowed rows are the placed rows plus the counted ones, per scope", async () => {
    const SOURCES = ["paypay", "wise", "opal"];
    const ACCOUNTS = ["account-1", "account-2"];
    const WORDS = ["alpha line", "beta line"];
    for (const seed of [11, 29, 47, 83, 131]) {
      let state = seed;
      const next = () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
      };
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const store = new QualityStore();
      try {
        const written: (SyntheticTransaction & { source: string })[] = [];
        for (let parse = 0; parse < 12; parse += 1) {
          const source = pick(SOURCES);
          const rows: SyntheticTransaction[] = Array.from(
            { length: 1 + Math.floor(next() * 40) },
            () => {
              const day = `2026-0${String(1 + Math.floor(next() * 9))}-${String(10 + Math.floor(next() * 19))}`;
              const asOf =
                next() < 0.4
                  ? pick(SHAPES)()
                  : pick([day, `${day}T10:00:00`, `${day}T05:00:00+09:00`, `${day}T01:00:00.000Z`]);
              return {
                asOf,
                account: pick(ACCOUNTS),
                description: pick(WORDS),
              };
            },
          );
          // About one parse in four is never published: its rows are in no
          // current read, so neither the list nor the count may see them.
          const published = next() >= 0.25;
          publishTransactions(store, source, `synthetic-activity-${String(parse)}`, rows, {
            published,
          });
          if (published) written.push(...rows.map((row) => ({ ...row, source })));
        }
        const reader = createObservationReader(executor(store));
        const scopes: CollectionScope[] = [
          {},
          ...SOURCES.map((source) => ({ source })),
          ...ACCOUNTS.map((account) => ({ account })),
          { source: "paypay", account: "account-1" },
          { q: "alpha" },
          { source: "wise", q: "beta" },
          // `q` also searches the source id and the account, case-insensitively.
          { q: "PAY" },
        ];
        for (const scope of scopes) {
          const counts = await reader.undatedTransactions(scope);
          const inScope = written.filter(
            (row) =>
              (scope.source === undefined || row.source === scope.source) &&
              (scope.account === undefined || row.account === scope.account) &&
              (scope.q === undefined ||
                [row.description!, row.source, row.account!].some((text) =>
                  text.toLowerCase().includes(scope.q!.toLowerCase()),
                )),
          );
          const oracle = new Map<string, number>();
          for (const row of inScope)
            if (!calendarDated(row.asOf)) {
              const key = `${row.source}/${row.account!}`;
              oracle.set(key, (oracle.get(key) ?? 0) + 1);
            }
          expect(
            Object.fromEntries(
              counts.map((count) => [
                `${count.source_id}/${count.source_account}`,
                count.row_count,
              ]),
            ),
          ).toEqual(Object.fromEntries([...oracle].sort(([a], [b]) => (a < b ? -1 : 1))));
          const total = counts.reduce((sum, count) => sum + count.row_count, 0);
          const unwindowed = allRows(store, scope).length;
          const widest = allRows(store, {
            ...scope,
            from: "0001-01-01",
            to: "9999-12-31",
          }).length;
          expect(unwindowed).toBe(inScope.length);
          expect(unwindowed).toBe(widest + total);
        }
      } finally {
        store.db.close();
      }
    }
  });
});
