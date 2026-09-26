// The keyed readiness CTEs (src/card-settlement-readiness.ts) against the
// migration 0044 view they stand in for (reading the migration 0052 bank debit
// view, both adapters), row for row, on small random stores
// (card-settlement-random-store.ts) whose reviews cite current and older
// statements and debits under their own and other keys, with owners, evidence
// and decisions drawn around the ones the store holds. Each flag both holds and
// fails across the seeds, and each change listed in MUTATIONS, which would make
// the CTEs inexact, fails the comparison on some seed. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { cardSettlementReadinessCtes } from "../src/card-settlement-readiness";
import { explain } from "./card-usage-plan";
import {
  READINESS_STATES,
  randomSettlementStore,
  type RandomSettlementStore,
} from "./card-settlement-random-store";
import { statementPlanProblems } from "./card-statement-plan";

/**
 * CI draws seeds 1–16 (12 until the SBI Shinsei rows joined the stores and
 * moved every draw after them); KOGANE_CARD_SETTLEMENT_SEEDS=n draws seeds 1–n.
 */
const SEED_COUNT = Number(process.env["KOGANE_CARD_SETTLEMENT_SEEDS"] ?? 16);
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1)
  throw new Error("KOGANE_CARD_SETTLEMENT_SEEDS must be a positive integer");
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);
const FLAGS = ["statement_current", "bank_current", "ownership_current", "allocation_available"];
const drawn = new Set<string>();

const COLUMNS = `id,${FLAGS.join(",")}`;
const keyed = (ctes: string): string =>
  `WITH chosen AS (SELECT value AS id FROM json_each(?1)), ${ctes}
 SELECT ${COLUMNS} FROM readiness ORDER BY id`;
const shipped = `SELECT ${COLUMNS} FROM card_settlement_readiness
 WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id`;

/**
 * Changes that make the CTEs inexact, each of which the comparison must catch:
 * a restriction that cuts partitions, a dropped or loosened condition of the
 * view, a reversed order.
 */
const MUTATIONS: [string, string, string][] = [
  [
    "rank only the candidates' own statements",
    " AND EXISTS(SELECT 1 FROM statement_partitions statement_partition",
    " AND b.id IN (SELECT statement_observation_id FROM ready_candidates) AND EXISTS(SELECT 1 FROM statement_partitions statement_partition",
  ],
  [
    "rank only the candidates' own debits",
    " WHERE a.source_id='smbc-bank' AND t.external_id IS NOT NULL",
    " WHERE t.id IN (SELECT bank_observation_id FROM ready_candidates) AND a.source_id='smbc-bank' AND t.external_id IS NOT NULL",
  ],
  [
    "the oldest debit capture wins",
    "  ORDER BY a.fetched_at DESC,t.id DESC) AS position",
    "  ORDER BY a.fetched_at,t.id DESC) AS position",
  ],
  [
    "rank only the candidates' own SBI Shinsei debits",
    " WHERE a.source_id='sbi-shinsei-bank'",
    " WHERE t.id IN (SELECT bank_observation_id FROM ready_candidates) AND a.source_id='sbi-shinsei-bank'",
  ],
  [
    "an SBI Shinsei row of another parser",
    " AND p.parser_name='sbi-shinsei-top-balances-and-activity'",
    "",
  ],
  ["an SBI Shinsei row in another currency", " AND unit_ref='JPY'", ""],
  [
    "an SBI Shinsei row whose side the provider did not state",
    " AND json_extract(extra_json,'$._kogane.amountSignSource')='debit'",
    "",
  ],
  ["an SBI Shinsei row with a status", "status IS NULL AND unit_ref", "unit_ref"],
  [
    "a newer statement of any account",
    "    AND newer_owner.account_id=json_extract(ready_candidate.facts_json,'$.statement.accountId')\n",
    "\n",
  ],
  [
    "a tie goes to the lower id",
    "AND newer_statement.id>current_statement.id",
    "AND newer_statement.id<current_statement.id",
  ],
  [
    "the statement owner's evidence is not checked",
    "   AND NOT EXISTS(SELECT 1 FROM json_each(statement_owner.evidence_refs_json) e",
    "   AND 1 OR NOT EXISTS(SELECT 1 FROM json_each(statement_owner.evidence_refs_json) e",
  ],
  [
    "the debit owner is not checked",
    "   AND debit_owner.owner_ref=json_extract(ready_candidate.facts_json,'$.bankDebit.ownerRef')",
    "",
  ],
  [
    "a withdrawn review still reserves",
    "used.status='accepted'",
    "used.status IN ('accepted','withdrawn')",
  ],
  [
    "a superseded or withdrawn allocation still counts",
    "NOT EXISTS(SELECT 1 FROM current_allocations a",
    "NOT EXISTS(SELECT 1 FROM allocations a",
  ],
  [
    "a review's own allocation counts against it",
    "\n  AND a.id IS NOT (SELECT settlement_id FROM card_settlement_reviews self WHERE self.id=ready_candidate.id)",
    "",
  ],
];

function all(db: Database, sql: string, args: readonly unknown[]): unknown[] {
  return db.query(sql).all(...(args as SQLQueryBindings[]));
}

const ids = (db: Database): string[] =>
  (db.query("SELECT id FROM card_settlement_candidates ORDER BY id").values() as string[][]).map(
    ([id]) => id!,
  );

describe("keyed card settlement readiness on random stores", () => {
  const stores = new Map<number, RandomSettlementStore>();
  const store = (seed: number): RandomSettlementStore => {
    let found = stores.get(seed);
    if (found === undefined) {
      found = randomSettlementStore(seed, drawn);
      stores.set(seed, found);
    }
    return found;
  };

  test.each(SEEDS)("seed %i: every candidate, whole and in parts", (seed) => {
    const { db } = store(seed);
    const every = ids(db);
    const sets = [
      every,
      every.filter((_, index) => index % 2 === seed % 2),
      [...every.slice(0, 3), ...every.slice(0, 3)],
      ...every.slice(0, 6).map((id) => [id]),
      ["cs_missing", ""],
      [],
    ];
    const text = keyed(cardSettlementReadinessCtes());
    for (const set of sets) {
      const args = [JSON.stringify(set)];
      const found = all(db, text, args) as Record<string, number | string>[];
      expect(found as unknown[]).toEqual(all(db, shipped, args));
      for (const row of found) {
        for (const flag of FLAGS) drawn.add(`${flag}=${row[flag]}`);
        if (FLAGS.every((flag) => row[flag] === 1)) drawn.add("ready");
      }
    }
  });

  test("the seeds together drew every review state and both values of every flag", () => {
    for (const seed of SEEDS) store(seed);
    const required = [
      ...READINESS_STATES,
      ...FLAGS.flatMap((flag) => [`${flag}=0`, `${flag}=1`]),
      "ready",
    ];
    expect(required.filter((state) => !drawn.has(state))).toEqual([]);
  });

  test.each(MUTATIONS)("the comparison catches: %s", (_, from, to) => {
    const ctes = cardSettlementReadinessCtes();
    expect(ctes).toContain(from);
    const mutated = keyed(ctes.replace(from, to));
    const caught = SEEDS.some((seed) => {
      const { db } = store(seed);
      const args = [JSON.stringify(ids(db))];
      return JSON.stringify(all(db, mutated, args)) !== JSON.stringify(all(db, shipped, args));
    });
    expect(caught).toBe(true);
  });

  test("its plan reads only the named candidates' facts and owners, never the whole store", () => {
    const { db } = store(1);
    // The store is what D1 runs: every CORE migration, no ANALYZE.
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const args = [JSON.stringify(ids(db))];
    expect(statementPlanProblems(explain(db, keyed(cardSettlementReadinessCtes()), args))).toEqual(
      [],
    );
    // The view it stands in for fails the same check: its ownership source
    // materializes the candidate identity runs of every published parse.
    expect(statementPlanProblems(explain(db, shipped, args))).not.toEqual([]);
  });
});
