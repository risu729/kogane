// Every application read of `card_settlement_readiness` against the text #251
// left it with (card-settlement-readiness-legacy-sql.ts), row for row, on small
// random stores (packages/read-model/test/card-settlement-random-store.ts) whose
// reviews draw every readiness flag both ways: the review list and one review
// (`queryCardSettlements`), the ownership review's candidate
// (`queryCardOwnership`), the settlement plan (`cardSettlementPlan`), and the
// ownership review's plan read and commit guard (`prepareOwnershipReview`).
// The competitor read (`queryRelatedCardSettlements`), which has no shipped
// text, is compared with the reservation's own terms over every candidate,
// each review shown as the shipped review read shows it. Every value is
// synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomSettlementStore } from "../../read-model/test/card-settlement-random-store.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { CARD_SETTLEMENT_PLAN_SQL } from "../src/operations/card-settlement-target.ts";
import {
  OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL,
  OWNERSHIP_REVIEW_CANDIDATE_SQL,
} from "../src/operations/ownership-review.ts";
import { CARD_OWNERSHIP_CANDIDATE_SQL } from "../src/query/card-ownership.ts";
import {
  CARD_SETTLEMENT_PAGE_SQL,
  CARD_SETTLEMENT_RELATED_SQL,
  CARD_SETTLEMENT_REVIEW_SQL,
  queryCardSettlements,
  queryRelatedCardSettlements,
} from "../src/query/card-settlements.ts";
import {
  LEGACY_CARD_OWNERSHIP_CANDIDATE_SQL,
  LEGACY_CARD_SETTLEMENT_PLAN_SQL,
  LEGACY_CARD_SETTLEMENT_REVIEWS_SQL,
  LEGACY_OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL,
  LEGACY_OWNERSHIP_REVIEW_CANDIDATE_SQL,
} from "./card-settlement-readiness-legacy-sql.ts";

/**
 * CI draws seeds 1–4 (the readiness CTEs themselves are compared on more in
 * packages/read-model); KOGANE_CARD_SETTLEMENT_SEEDS=n draws seeds 1–n.
 */
const SEED_COUNT = Number(process.env["KOGANE_CARD_SETTLEMENT_SEEDS"] ?? 4);
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1)
  throw new Error("KOGANE_CARD_SETTLEMENT_SEEDS must be a positive integer");
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);
const drawn = new Set<string>();

/**
 * The competitor read with one of its three terms dropped: each must miss a
 * competitor on some seed, so the seeds exercise every term.
 */
const RELATED_MUTANTS = new Map(
  [
    "related.statement_key=anchor.statement_key",
    "related.bank_key=anchor.bank_key",
    "json_extract(related.facts_json,'$.statement.period')=json_extract(anchor.facts_json,'$.statement.period')",
  ].map((term) => {
    if (!CARD_SETTLEMENT_RELATED_SQL.includes(term)) throw new Error(`missing term ${term}`);
    return [term, CARD_SETTLEMENT_RELATED_SQL.replace(term, "0")] as const;
  }),
);
const killed = new Set<string>();

/**
 * The columns the shipped reads had: the plan read adds `claim_available` and
 * the review's `event_id` (ADR 0054, G1b), which
 * packages/read-model/test/card-settlement-readiness.test.ts compares.
 */
function shippedColumns(found: unknown[]): unknown[] {
  return found.map((row) =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).filter(
        ([name]) => name !== "claim_available" && name !== "event_id",
      ),
    ),
  );
}

function rows(db: Database, sql: string, args: readonly unknown[]): unknown[] {
  return db.query(sql).all(...(args as SQLQueryBindings[]));
}

/** The shipped text in place of each keyed one, or every statement as given. */
const LEGACY = new Map([
  [CARD_SETTLEMENT_PAGE_SQL, LEGACY_CARD_SETTLEMENT_REVIEWS_SQL],
  [CARD_SETTLEMENT_REVIEW_SQL, LEGACY_CARD_SETTLEMENT_REVIEWS_SQL],
]);
function executor(db: Database, legacy: boolean): SqlExecutor {
  const text = (query: string): string => (legacy ? (LEGACY.get(query) ?? query) : query);
  return {
    all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> =>
      rows(db, text(query), args) as T[],
    first: async <T>(query: string, args: readonly unknown[]): Promise<T | null> =>
      (db.query(text(query)).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

/** Each review's id and revision, and an id no review has. */
function reviews(db: Database): { id: string; revision: number }[] {
  return [
    ...(db.query("SELECT id,revision FROM card_settlement_reviews ORDER BY id").all() as {
      id: string;
      revision: number;
    }[]),
    { id: "cs_missing", revision: 0 },
  ];
}

describe("card settlement readiness reads on random stores", () => {
  test.each(SEEDS)(
    "seed %i: the shipped rows for every page and every review",
    async (seed) => {
      const { db } = randomSettlementStore(seed, new Set());
      const count = (
        db.query("SELECT count(*) AS n FROM card_settlement_candidates").get() as {
          n: number;
        }
      ).n;
      for (const [limit, offset] of [
        [51, 0],
        [5, 0],
        [5, 5],
        [3, count - 2],
        [51, count],
      ] as const) {
        const args = [null, limit, offset];
        const found = rows(db, CARD_SETTLEMENT_PAGE_SQL, args);
        expect(found).toEqual(rows(db, LEGACY_CARD_SETTLEMENT_REVIEWS_SQL, args));
      }
      for (const { id, revision } of reviews(db)) {
        for (const offset of [0, 1]) {
          const args = [id, 51, offset];
          expect(rows(db, CARD_SETTLEMENT_REVIEW_SQL, args)).toEqual(
            rows(db, LEGACY_CARD_SETTLEMENT_REVIEWS_SQL, args),
          );
        }
        for (const [sql, legacy] of [
          [CARD_OWNERSHIP_CANDIDATE_SQL, LEGACY_CARD_OWNERSHIP_CANDIDATE_SQL],
          [CARD_SETTLEMENT_PLAN_SQL, LEGACY_CARD_SETTLEMENT_PLAN_SQL],
          [OWNERSHIP_REVIEW_CANDIDATE_SQL, LEGACY_OWNERSHIP_REVIEW_CANDIDATE_SQL],
        ] as const)
          expect(shippedColumns(rows(db, sql, [id]))).toEqual(rows(db, legacy, [id]));
        for (const expected of [revision, revision + 1]) {
          const [guard] = rows(db, `SELECT ${OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL} AS ok`, [
            id,
            expected,
          ]) as { ok: number }[];
          expect(guard as unknown).toEqual(
            rows(db, `SELECT ${LEGACY_OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL} AS ok`, [
              id,
              expected,
            ])[0],
          );
          drawn.add(`ownership guard ${guard!.ok}`);
        }
      }
      // The list as the page shows it, through the same executor either way. The
      // random facts are not the sweep's, so the page may refuse them: it must
      // refuse them the same way.
      const page = (legacy: boolean, input: { offset?: number; proposalId?: string }) =>
        queryCardSettlements(executor(db, legacy), input).catch((error: Error) => error.message);
      for (const input of [{}, { offset: 50 }, { proposalId: reviews(db)[0]!.id }])
        expect(await page(false, input)).toEqual(await page(true, input));
    },
    60_000,
  );

  test.each(SEEDS)(
    "seed %i: each review's competitors are the reservation's, as the shipped review read shows them",
    async (seed) => {
      const { db } = randomSettlementStore(seed, new Set());
      for (const { id } of reviews(db)) {
        // The reservation's own terms (`allocation_available` in
        // card-settlement-readiness.ts), over every candidate.
        const ids = (
          db
            .query(
              `SELECT c.id FROM card_settlement_candidates c WHERE c.id<>?1 AND EXISTS(
                SELECT 1 FROM card_settlement_candidates a WHERE a.id=?1
                AND (c.statement_key=a.statement_key OR c.bank_key=a.bank_key
                 OR (json_extract(c.facts_json,'$.statement.sourceId')=json_extract(a.facts_json,'$.statement.sourceId')
                  AND json_extract(c.facts_json,'$.statement.accountId')=json_extract(a.facts_json,'$.statement.accountId')
                  AND json_extract(c.facts_json,'$.statement.period')=json_extract(a.facts_json,'$.statement.period'))))
               ORDER BY c.created_at DESC,c.id DESC`,
            )
            .all(id) as { id: string }[]
        ).map((row) => row.id);
        drawn.add(ids.length === 0 ? "no competitor" : "competitors");
        const expected = ids.flatMap((other) =>
          rows(db, LEGACY_CARD_SETTLEMENT_REVIEWS_SQL, [other, 51, 0]),
        );
        expect(rows(db, CARD_SETTLEMENT_RELATED_SQL, [id, 51, 0])).toEqual(expected);
        expect(rows(db, CARD_SETTLEMENT_RELATED_SQL, [id, 2, 1])).toEqual(expected.slice(1, 3));
        for (const [term, mutant] of RELATED_MUTANTS)
          if (rows(db, mutant, [id, 51, 0]).length !== expected.length) killed.add(term);
        const page = await queryRelatedCardSettlements(executor(db, false), id).catch(
          (error: Error) => error.message,
        );
        // The random facts are not the sweep's, so the page may refuse them.
        if (id === "cs_missing") expect(page).toBeNull();
        else if (typeof page === "string") expect(page).toBe("card_settlement_facts_invalid");
        else expect(page?.items.map((item) => item.proposalId)).toEqual(ids.slice(0, 50));
      }
    },
    60_000,
  );

  test("the seeds drew guards that hold and fail, and reviews with and without competitors", () => {
    expect([...drawn].sort()).toEqual([
      "competitors",
      "no competitor",
      "ownership guard 0",
      "ownership guard 1",
    ]);
    expect([...killed].sort()).toEqual([...RELATED_MUTANTS.keys()].sort());
  });
});
