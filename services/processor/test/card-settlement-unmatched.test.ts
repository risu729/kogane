// What the settlement sweep says about a statement that yields no candidate
// (src/card-settlement-job.ts `unmatched`, docs/card-settlements.md,
// Unmatched statements). The sweep runs against an in-memory stand-in for the
// rows its two reads return, so each shape is exactly the one named: a
// statement settled by two debits, a partial payment, no debit in the window,
// a statement with nothing to compare, and the exact match, whose candidate
// and digest are pinned to what the sweep wrote before the codes existed.
// Every value is synthetic.
import { expect, test } from "bun:test";
import { CORE_REVISION_SQL } from "../../../packages/read-model/src/source-revision.ts";
import {
  CARD_SETTLEMENT_BANK_DEBITS_SQL,
  CARD_SETTLEMENT_STATEMENTS_SQL,
  CARD_SETTLEMENT_UNMATCHED_CODES,
  cardSettlementSweep,
} from "../src/card-settlement-job.ts";
import { laneTick } from "../src/lane-ticks.ts";

type Row = Record<string, string | number | null>;

/** A Vpass statement total (no debit-account read), as `card_statement_facts` returns it. */
function statement(id: number, coefficient: string | null, paymentDate: string | null): Row {
  return {
    id,
    parse_run_id: 900 + id,
    source_account: "vpass:synthetic:" + id,
    unit_ref: "JPY",
    source_id: "vpass",
    value_status: coefficient === null ? "unavailable" : "exact",
    coefficient,
    scale: coefficient === null ? null : 0,
    payment_date: paymentDate,
    as_of: null,
    period: "2098-09",
    statement_key: JSON.stringify(["vpass", "synthetic", "card-" + id]),
    bank_key: "",
    account_id: null,
    owner_ref: null,
    evidence_refs_json: null,
  };
}

/** One bank debit as `card_bank_debit_facts` returns it, magnitude signed negative. */
function debit(id: number, coefficient: string, debitDate: string): Row {
  return {
    id,
    parse_run_id: 800 + id,
    source_account: "smbc-bank:synthetic",
    unit_ref: "JPY",
    source_id: "smbc-bank",
    value_status: "exact",
    coefficient: "-" + coefficient,
    scale: 0,
    payment_date: null,
    as_of: debitDate + "T00:00:00+09:00",
    debit_date: debitDate,
    period: null,
    statement_key: "",
    bank_key: JSON.stringify(["smbc-bank", "synthetic", "debit-" + id]),
    account_id: null,
    owner_ref: null,
    evidence_refs_json: null,
  };
}

const days = (date: string, offset: number): string =>
  new Date(Date.parse(date + "T00:00:00Z") + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * `D1Database` over the given rows: the statement page and the bank window
 * (`debit_date` within three days, up to the bound limit) as the two reads
 * define them, a stable CORE revision, and every candidate insert recorded.
 */
function store(statements: Row[], debits: Row[]) {
  const inserts: unknown[][] = [];
  const prepare = (sql: string) => {
    let binds: unknown[] = [];
    const statementApi = {
      bind: (...values: unknown[]) => {
        binds = values;
        return statementApi;
      },
      first: async () => {
        if (sql === CORE_REVISION_SQL)
          return { source_revision: 1, visibility_revision: 1, core_epoch: "synthetic" };
        return null;
      },
      all: async () => {
        if (sql === CARD_SETTLEMENT_STATEMENTS_SQL) {
          const [after, size] = binds as [number, number];
          return {
            results: statements.filter((row) => (row.id as number) > after).slice(0, size),
          };
        }
        if (sql === CARD_SETTLEMENT_BANK_DEBITS_SQL) {
          const [from, to, limit] = binds as [string, string, number];
          return {
            results: debits
              .filter(
                (row) =>
                  (row.debit_date as string) >= days(from, -3) &&
                  (row.debit_date as string) <= days(to, 3),
              )
              .slice(0, limit),
          };
        }
        throw new Error("unexpected read: " + sql);
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO card_settlement_candidates")) {
          inserts.push(binds);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE card_settlement_scan_cursor")) return { meta: { changes: 1 } };
        throw new Error("unexpected write: " + sql);
      },
    };
    return statementApi;
  };
  return { db: { prepare } as unknown as D1Database, inserts };
}

const NONE = { statement_not_comparable: 0, no_debit_in_window: 0, no_equal_amount_debit: 0 };
const DUE = "2098-09-10";
/** The exact match's digest as the sweep on main wrote it before `unmatched` existed. */
const PINNED_DIGEST = "b8bca672e9f849ae3fd75a4299b99755b9d87e0ca2fe352a5c245d2c4f67f5c8";

test("an exact match writes the same candidate and digest as before, and counts nothing unmatched", async () => {
  const { db, inserts } = store([statement(1, "30000", DUE)], [debit(11, "30000", days(DUE, 1))]);
  expect(await cardSettlementSweep(db)).toEqual({
    scanned: 2,
    proposed: 1,
    written: 1,
    debitAccountEvidence: 0,
    unmatched: NONE,
  });
  expect(inserts).toHaveLength(1);
  const [id, statementKey, bankKey, statementId, statementParse, bankId, bankParse, policy] =
    inserts[0]!;
  expect([statementKey, bankKey, statementId, statementParse, bankId, bankParse, policy]).toEqual([
    JSON.stringify(["vpass", "synthetic", "card-1"]),
    JSON.stringify(["smbc-bank", "synthetic", "debit-11"]),
    1,
    901,
    11,
    811,
    "card-statement-settlement-v1",
  ]);
  // Pinned from the sweep before `unmatched` existed: the facts and their
  // digest did not change.
  expect(id).toBe("cs_" + inserts[0]![9]);
  expect(inserts[0]![9]).toBe(PINNED_DIGEST);
});

test("two debits that sum to the total, or a partial debit, is `no_equal_amount_debit`", async () => {
  const twoDebits = store(
    [statement(1, "30000", DUE)],
    [debit(11, "10000", DUE), debit(12, "20000", days(DUE, 2))],
  );
  expect(await cardSettlementSweep(twoDebits.db)).toMatchObject({
    scanned: 3,
    proposed: 0,
    written: 0,
    unmatched: { ...NONE, no_equal_amount_debit: 1 },
  });
  expect(twoDebits.inserts).toEqual([]);
  const partial = store([statement(1, "30000", DUE)], [debit(11, "12000", days(DUE, -1))]);
  expect(await cardSettlementSweep(partial.db)).toMatchObject({
    proposed: 0,
    unmatched: { ...NONE, no_equal_amount_debit: 1 },
  });
  expect(partial.inserts).toEqual([]);
});

test("an equal debit outside the three days, or none at all, is `no_debit_in_window`", async () => {
  for (const debits of [[debit(11, "30000", days(DUE, 4))], []]) {
    const { db, inserts } = store([statement(1, "30000", DUE)], debits);
    expect(await cardSettlementSweep(db)).toEqual({
      scanned: 1,
      proposed: 0,
      written: 0,
      debitAccountEvidence: 0,
      unmatched: { ...NONE, no_debit_in_window: 1 },
    });
    expect(inserts).toEqual([]);
  }
});

test("a statement with nothing to compare is `statement_not_comparable`, read or not", async () => {
  const { db, inserts } = store(
    [
      statement(1, null, DUE), // no exact total: no bank read
      statement(2, "30000", null), // no due date: no bank read
      statement(3, "0", DUE), // a zero total is read, and never matches
    ],
    [debit(11, "0", DUE)],
  );
  expect(await cardSettlementSweep(db)).toMatchObject({
    proposed: 0,
    unmatched: { ...NONE, statement_not_comparable: 3 },
  });
  expect(inserts).toEqual([]);
});

test("one tick counts each statement once, and its tick row holds counts and closed codes only", async () => {
  const { db, inserts } = store(
    [
      statement(1, "30000", DUE),
      statement(2, "30000", "2098-10-10"),
      statement(3, "45000", "2098-11-10"),
      statement(4, null, DUE),
    ],
    [debit(11, "30000", DUE), debit(12, "10000", "2098-11-09"), debit(13, "35000", "2098-11-11")],
  );
  const result = await cardSettlementSweep(db);
  expect(result).toMatchObject({
    proposed: 1,
    written: 1,
    unmatched: { statement_not_comparable: 1, no_debit_in_window: 1, no_equal_amount_debit: 1 },
  });
  expect(inserts).toHaveLength(1);
  const row = laneTick("card_settlement_sweep", 0, 1, { outcome: "ran", result })!;
  expect(Object.keys(row.counts["unmatched"] as object)).toEqual([
    ...CARD_SETTLEMENT_UNMATCHED_CODES,
  ]);
  const stored = JSON.stringify(row.counts);
  for (const text of [
    "30000",
    "45000",
    "10000",
    "35000",
    "2098",
    "JPY",
    "vpass",
    "smbc",
    "synthetic",
  ])
    expect(stored).not.toContain(text);
  for (const value of Object.values(row.counts["unmatched"] as Record<string, unknown>))
    expect(Number.isSafeInteger(value)).toBe(true);
});
