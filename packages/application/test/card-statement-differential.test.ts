// The card purchases statement and settlement reads against the text #235
// shipped (card-statement-legacy-sql.ts), row for row, on small random stores
// (packages/read-model/test/card-settlement-random-store.ts) that draw every
// statement, identity, mapping and ownership-claim state the migration 0044
// views distinguish; the settlement read, whose text is unchanged, is compared
// with and without the migration 0050 index. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomSettlementStore } from "../../read-model/test/card-settlement-random-store.ts";
import { SETTLEMENT_SQL, STATEMENT_SQL } from "../src/query/card-purchases.ts";
import { LEGACY_STATEMENT_SQL } from "./card-statement-legacy-sql.ts";

/** CI draws seeds 1–8; KOGANE_CARD_SETTLEMENT_SEEDS=n draws seeds 1–n. */
const SEED_COUNT = Number(process.env["KOGANE_CARD_SETTLEMENT_SEEDS"] ?? 8);
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1)
  throw new Error("KOGANE_CARD_SETTLEMENT_SEEDS must be a positive integer");
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);
const INDEX = "card_settlement_candidates_statement_period";
const drawn = new Set<string>();

function rows(db: Database, sql: string, args: readonly unknown[]): string[] {
  return db
    .query(sql)
    .all(...(args as SQLQueryBindings[]))
    .map((row) => JSON.stringify(row))
    .sort();
}

describe("card purchase statement reads on random stores", () => {
  test.each(SEEDS)("seed %i: the shipped rows for every set of statements asked for", (seed) => {
    const { db, triples } = randomSettlementStore(seed, new Set());
    const sets = [
      triples,
      triples.filter((_, index) => index % 2 === seed % 2),
      triples.filter((triple) => triple[2] === "2026-07"),
      [...triples.slice(0, 4), ...triples.slice(0, 4)],
      [],
    ];
    for (const set of sets) {
      const args = [JSON.stringify(set)];
      const found = rows(db, STATEMENT_SQL, args);
      expect(found).toEqual(rows(db, LEGACY_STATEMENT_SQL, args));
      if (found.length > 0) drawn.add("statement linked");
      const settled = rows(db, SETTLEMENT_SQL, args);
      if (settled.length > 0) drawn.add("review linked");
      const definition = (
        db.query("SELECT sql FROM sqlite_master WHERE name=?").get(INDEX) as { sql: string }
      ).sql;
      db.exec(`DROP INDEX ${INDEX}`);
      expect(rows(db, SETTLEMENT_SQL, args)).toEqual(settled);
      db.exec(definition);
    }
  });

  test("the seeds linked statements and reviews", () => {
    expect([...drawn].sort()).toEqual(["review linked", "statement linked"]);
  });
});
