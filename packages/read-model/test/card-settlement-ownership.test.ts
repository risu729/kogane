// The keyed ownership CTEs (src/card-settlement-ownership.ts) against the
// migration 0044 view they stand in for, row for row, on small random stores
// (card-settlement-random-store.ts) that draw every identity, mapping and
// ownership-claim state the view distinguishes. The last test checks that the
// seeds together drew every one of those states. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cardSettlementOwnershipCtes, type OwnershipKind } from "../src/card-settlement-ownership";
import { explain } from "./card-usage-plan";
import {
  RANDOM_STATES,
  randomSettlementStore,
  type RandomSettlementStore,
} from "./card-settlement-random-store";
import { statementPlanProblems } from "./card-statement-plan";

/** CI draws seeds 1–12; KOGANE_CARD_SETTLEMENT_SEEDS=n draws seeds 1–n. */
const SEED_COUNT = Number(process.env["KOGANE_CARD_SETTLEMENT_SEEDS"] ?? 12);
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1)
  throw new Error("KOGANE_CARD_SETTLEMENT_SEEDS must be a positive integer");
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);
const drawn = new Set<string>();

const COLUMNS = "kind,observation_id,account_id,owner_ref,evidence_refs_json";
const keyed = (kind: OwnershipKind): string =>
  `WITH observed AS (SELECT value AS observation_id FROM json_each(?1)),
 ${cardSettlementOwnershipCtes(kind)}
 SELECT ${COLUMNS} FROM ownership ORDER BY observation_id`;
const shipped = `SELECT ${COLUMNS} FROM card_settlement_fact_ownership
 WHERE kind=?2 AND observation_id IN (SELECT value FROM json_each(?1)) ORDER BY observation_id`;

function all(db: Database, sql: string, args: readonly unknown[]): unknown[] {
  return db.query(sql).all(...(args as SQLQueryBindings[]));
}

/** The keyed rows of `ids`, which must be the view's rows of them. */
function same(db: Database, kind: OwnershipKind, ids: readonly number[]): unknown[] {
  const list = JSON.stringify(ids);
  const found = all(db, keyed(kind), [list]);
  expect(found).toEqual(all(db, shipped, [list, kind]));
  return found;
}

describe("keyed card settlement ownership on random stores", () => {
  const stores = new Map<number, RandomSettlementStore>();
  const store = (seed: number): RandomSettlementStore => {
    let found = stores.get(seed);
    if (found === undefined) {
      found = randomSettlementStore(seed, drawn);
      stores.set(seed, found);
    }
    return found;
  };

  test.each(SEEDS)("seed %i: every statement and bank row, whole and in parts", (seed) => {
    const { db, balances, transactions } = store(seed);
    for (const [kind, ids] of [
      ["balance", balances],
      ["transaction", transactions],
    ] as const) {
      const rows = same(db, kind, ids) as { owner_ref: string | null; account_id: string | null }[];
      if (rows.some((row) => row.account_id !== null)) drawn.add(`${kind} owned`);
      if (rows.some((row) => row.owner_ref !== null)) drawn.add(`${kind} owner established`);
      if (rows.some((row) => row.account_id !== null && row.owner_ref === null))
        drawn.add(`${kind} account without owner`);
      if (rows.length < ids.length) drawn.add(`${kind} row without ownership`);
      // Parts, duplicates, ids of the other kind and ids no row has.
      same(
        db,
        kind,
        ids.filter((_, index) => index % 2 === seed % 2),
      );
      same(db, kind, [...ids.slice(0, 3), ...ids.slice(0, 3)]);
      same(db, kind, kind === "balance" ? transactions : balances);
      same(db, kind, [0, -1, 999_999]);
      same(db, kind, []);
    }
  });

  test("its plan reads only the named observations' parses, never the whole store", () => {
    const { db, balances, transactions } = store(1);
    // The store is what D1 runs: every CORE migration, no ANALYZE.
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    for (const [kind, ids] of [
      ["balance", balances],
      ["transaction", transactions],
    ] as const) {
      expect(statementPlanProblems(explain(db, keyed(kind), [JSON.stringify(ids)]))).toEqual([]);
      // The view the CTEs stand in for fails the same check: it materializes
      // the candidate identity runs of every published parse.
      expect(statementPlanProblems(explain(db, shipped, [JSON.stringify(ids), kind]))).not.toEqual(
        [],
      );
    }
  });

  test("the seeds together drew every state the view distinguishes", () => {
    for (const seed of SEEDS) store(seed);
    const required = [
      ...RANDOM_STATES,
      "balance owned",
      "balance owner established",
      "balance account without owner",
      "balance row without ownership",
      "transaction owned",
      "transaction owner established",
      "transaction account without owner",
      "transaction row without ownership",
    ];
    expect(required.filter((state) => !drawn.has(state))).toEqual([]);
  });
});
