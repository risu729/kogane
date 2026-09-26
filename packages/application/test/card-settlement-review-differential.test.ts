// Every application read of `card_settlement_readiness` against the text #251
// left it with (card-settlement-readiness-legacy-sql.ts), row for row, on small
// random stores (packages/read-model/test/card-settlement-random-store.ts) whose
// reviews draw every readiness flag both ways: the review list and one review
// (`queryCardSettlements`), the ownership review's candidate
// (`queryCardOwnership`), the settlement plan (`cardSettlementPlan`), and the
// ownership review's plan read and commit guard (`prepareOwnershipReview`).
// Every value is synthetic.
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
  CARD_SETTLEMENT_REVIEW_SQL,
  queryCardSettlements,
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
          expect(rows(db, sql, [id])).toEqual(rows(db, legacy, [id]));
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

  test("the seeds drew guards that hold and fail", () => {
    expect([...drawn].sort()).toEqual(["ownership guard 0", "ownership guard 1"]);
  });
});
