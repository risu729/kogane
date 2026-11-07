// The keyed ownership CTEs (src/card-settlement-ownership.ts) against the
// migration 0044 view they stand in for, row for row, on small random stores
// (card-settlement-random-store.ts) that draw every identity, mapping and
// ownership-claim state the view distinguishes. The last test checks that the
// seeds together drew every one of those states. The random stores record no
// ownership proposal, so there the CTEs and the view agree; the last describe
// covers the one rule they deliberately differ in (ADR 0017's amendment of
// 2026-11-06). Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cardSettlementOwnershipCtes, type OwnershipKind } from "../src/card-settlement-ownership";
import { explain } from "./card-usage-plan";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import {
  LEGACY_OWNERSHIP_CTES,
  LEGACY_OWNERSHIP_CTES_SHA256,
  withProposalRule,
} from "./card-settlement-ownership-legacy-sql";
import {
  LATER_PROPOSAL_STATES,
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
  // The first store pays the one-time CORE schema build (schema-template.ts,
  // every migration in order), which crossed a seed's 5 s default timeout on
  // the loaded CI runner. Pay it here, outside any seed's budget.
  beforeAll(() => {
    fullCoreSchema().close();
  }, 60_000);

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

// ADR 0017's amendment of 2026-11-06: a proposal recorded after a decision of
// the same owner changes nothing. The same seed's store with ownership
// proposals appended last (`laterProposals`) must read exactly as the store
// without them. The shipped CTEs (frozen in
// card-settlement-ownership-legacy-sql.ts) and the 0044 view let such a
// proposal retire an accepted claim or lift a dated claim's veto.
describe("a later ownership proposal changes no owner", () => {
  const legacy = (kind: OwnershipKind): string =>
    `WITH observed AS (SELECT value AS observation_id FROM json_each(?1)),
 ${LEGACY_OWNERSHIP_CTES[kind]}
 SELECT ${COLUMNS} FROM ownership ORDER BY observation_id`;
  const proposalsDrawn = new Set<string>();
  const changes = new Set<string>();
  type Owned = { observation_id: number; owner_ref: string | null };

  beforeAll(() => {
    fullCoreSchema().close();
  }, 60_000);

  test("the frozen texts are the texts that shipped", () => {
    for (const kind of ["balance", "transaction"] as const)
      expect(createHash("sha256").update(LEGACY_OWNERSHIP_CTES[kind]).digest("hex")).toBe(
        LEGACY_OWNERSHIP_CTES_SHA256[kind],
      );
  });

  test("the current texts are the frozen ones with only the two newer-row checks changed", () => {
    for (const kind of ["balance", "transaction"] as const) {
      expect(cardSettlementOwnershipCtes(kind)).not.toBe(LEGACY_OWNERSHIP_CTES[kind]);
      expect(withProposalRule(LEGACY_OWNERSHIP_CTES[kind])).toBe(cardSettlementOwnershipCtes(kind));
    }
  });

  test.each(SEEDS)(
    "seed %i: the store with later proposals reads as the store without",
    (seed) => {
      const plain = randomSettlementStore(seed, new Set());
      const proposed = randomSettlementStore(seed, proposalsDrawn, { laterProposals: true });
      expect(proposed.balances).toEqual(plain.balances);
      expect(proposed.transactions).toEqual(plain.transactions);
      for (const [kind, ids] of [
        ["balance", plain.balances],
        ["transaction", plain.transactions],
      ] as const) {
        const list = JSON.stringify(ids);
        const current = all(plain.db, keyed(kind), [list]) as Owned[];
        // Without proposals the current CTEs are the shipped ones, row for row.
        expect(current).toEqual(all(plain.db, legacy(kind), [list]) as Owned[]);
        // With them, the current CTEs still read the store without them.
        expect(all(proposed.db, keyed(kind), [list])).toEqual(current);
        // The shipped CTEs read as the view does there, and moved.
        const before = all(proposed.db, legacy(kind), [list]) as Owned[];
        expect(before).toEqual(all(proposed.db, shipped, [list, kind]) as Owned[]);
        const now = new Map(current.map((row) => [row.observation_id, row.owner_ref]));
        for (const row of before) {
          const owner = now.get(row.observation_id) ?? null;
          if (owner !== null && row.owner_ref === null) changes.add("shipped lost an owner");
          if (owner === null && row.owner_ref !== null) changes.add("shipped gained an owner");
        }
        // The plan stays keyed with the proposals in the store.
        expect(statementPlanProblems(explain(proposed.db, keyed(kind), [list]))).toEqual([]);
      }
      plain.db.close();
      proposed.db.close();
    },
    30_000,
  );

  test("the seeds drew every proposal state, and the shipped read was wrong both ways", () => {
    expect(LATER_PROPOSAL_STATES.filter((state) => !proposalsDrawn.has(state))).toEqual([]);
    expect([...changes].sort()).toEqual(["shipped gained an owner", "shipped lost an owner"]);
  });
});
