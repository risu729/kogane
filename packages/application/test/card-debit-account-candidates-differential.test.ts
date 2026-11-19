// The debit-account candidate read (`CARD_DEBIT_ACCOUNT_CANDIDATES_SQL`,
// docs/card-settlements.md, Debit account per card) against the text #1387
// shipped (card-debit-account-candidates-legacy-sql.ts), on small random stores
// (packages/read-model/test/card-settlement-random-store.ts) whose reviews
// draw accepted, withdrawn, rejected and proposed candidates over statements
// read through two namespaces and two card ordinals of one account, with
// statement keys, accounts, sources and periods drawn away from the
// statement's own.
//
// The new read differs from the shipped one in one place: a proposed
// candidate counts as covered when an accepted one has its statement key (as
// shipped) or its card month, the acceptance guard's
// `(statement.sourceId, statement.accountId, statement.period)` term of
// `card_settlement_readiness.allocation_available` (migration 0044). So the
// expected rows are the shipped text's, over the reviews less every proposed
// candidate that term reserves (the term copied from the migration,
// card-debit-account-candidates-guard.ts). Where no
// such candidate exists, that is the shipped text's own answer; where one
// does, the guard itself refuses it (`allocation_available` is 0). Every value
// is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomSettlementStore } from "../../read-model/test/card-settlement-random-store.ts";
import { CARD_DEBIT_ACCOUNT_CANDIDATES_SQL } from "../src/query/card-debit-accounts.ts";
import {
  EXPECTED_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL,
  RESERVED_BY_MONTH_SQL,
} from "./card-debit-account-candidates-guard.ts";
import { LEGACY_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL } from "./card-debit-account-candidates-legacy-sql.ts";

/** CI draws seeds 1–8; KOGANE_CARD_SETTLEMENT_SEEDS=n draws seeds 1–n. */
const SEED_COUNT = Number(process.env["KOGANE_CARD_SETTLEMENT_SEEDS"] ?? 8);
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1)
  throw new Error("KOGANE_CARD_SETTLEMENT_SEEDS must be a positive integer");
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);

/** The new read with one of its month terms dropped: each must miss on some seed. */
const MUTANTS = new Map(
  [
    "m.card_source_id=live.card_source_id",
    "m.card_account_id=live.card_account_id",
    "m.period=live.period",
  ].map((term) => {
    if (!CARD_DEBIT_ACCOUNT_CANDIDATES_SQL.includes(term)) throw new Error(`missing term ${term}`);
    return [term, CARD_DEBIT_ACCOUNT_CANDIDATES_SQL.replace(term, "1")] as const;
  }),
);
const killed = new Set<string>();
const drawn = new Set<string>();

function rows(db: Database, sql: string, args: readonly unknown[] = []): unknown[] {
  return db.query(sql).all(...(args as SQLQueryBindings[]));
}

describe("card debit-account candidates on random stores", () => {
  test.each(SEEDS)(
    "seed %i: the shipped rows, less the proposals the guard reserves by card month",
    (seed) => {
      const { db } = randomSettlementStore(seed, new Set());
      const found = rows(db, CARD_DEBIT_ACCOUNT_CANDIDATES_SQL);
      expect(found).toEqual(rows(db, EXPECTED_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL));
      const reserved = (rows(db, RESERVED_BY_MONTH_SQL) as { id: string }[]).map((row) => row.id);
      const shipped = rows(db, LEGACY_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL);
      if (reserved.length === 0) {
        // No card month read under two statement keys: the shipped answer.
        expect(found).toEqual(shipped);
        drawn.add("no overlap");
      } else {
        drawn.add("overlap");
        if (JSON.stringify(found) !== JSON.stringify(shipped)) drawn.add("rows differ");
        // The guard itself refuses every proposal the new read stops listing.
        for (const id of reserved) {
          const guard = db
            .query("SELECT allocation_available FROM card_settlement_readiness WHERE id=?")
            .get(id) as { allocation_available: number } | null;
          expect({ id, guard }).toEqual({ id, guard: { allocation_available: 0 } });
        }
      }
      for (const [term, mutant] of MUTANTS)
        if (JSON.stringify(rows(db, mutant)) !== JSON.stringify(found)) killed.add(term);
    },
    60_000,
  );

  test("the seeds drew stores with and without an overlap, and every month term matters", () => {
    expect([...drawn].sort()).toEqual(["no overlap", "overlap", "rows differ"]);
    expect([...killed].sort()).toEqual([...MUTANTS.keys()].sort());
  });
});
