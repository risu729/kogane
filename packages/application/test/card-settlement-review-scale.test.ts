// The reads of `card_settlement_readiness` behind the `カード照合` list, the
// ownership review and the settlement and ownership plans and guards, on the
// scaled store with statement history
// (packages/read-model/test/card-usage-scale-fixture.ts, `statements`): the
// complete CORE schema, no table statistics (D1 is never analyzed), and the
// settlement reviews the sweep proposes, mostly accepted. The reads equal the
// shipped ones (card-settlement-readiness-legacy-sql.ts), and no plan reads the
// whole store. CI builds `STATEMENT_CI_SCALE`; set
// KOGANE_CARD_STATEMENT_SCALE=full to build `STATEMENT_SCALE` (a few minutes)
// and print the timings docs/card-settlements.md quotes. Synthetic values only.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { statementPlanProblems } from "../../read-model/test/card-statement-plan.ts";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import {
  STATEMENT_CI_SCALE,
  STATEMENT_SCALE,
  type ScaledStore,
  scaledStore,
} from "../../read-model/test/card-usage-scale-fixture.ts";
import { CARD_SETTLEMENT_PLAN_SQL } from "../src/operations/card-settlement-target.ts";
import {
  OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL,
  OWNERSHIP_REVIEW_CANDIDATE_SQL,
} from "../src/operations/ownership-review.ts";
import { CARD_OWNERSHIP_CANDIDATE_SQL } from "../src/query/card-ownership.ts";
import {
  CARD_SETTLEMENT_PAGE_SIZE,
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

const FULL = process.env["KOGANE_CARD_STATEMENT_SCALE"] === "full";
const TIMEOUT = FULL ? 1_800_000 : 120_000;

let built: ScaledStore;
let db: Database;

beforeAll(async () => {
  built = await scaledStore(FULL ? STATEMENT_SCALE : STATEMENT_CI_SCALE);
  db = built.store.db;
}, TIMEOUT);

function rows(sql: string, args: readonly unknown[]): unknown[] {
  return db.query(sql).all(...(args as SQLQueryBindings[]));
}

/** The shipped text in place of the keyed list reads, or every statement as given. */
function executor(legacy: boolean): SqlExecutor {
  const text = (query: string): string =>
    legacy && (query === CARD_SETTLEMENT_PAGE_SQL || query === CARD_SETTLEMENT_REVIEW_SQL)
      ? LEGACY_CARD_SETTLEMENT_REVIEWS_SQL
      : query;
  return {
    all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> =>
      rows(text(query), args) as T[],
    first: async <T>(query: string, args: readonly unknown[]): Promise<T | null> =>
      (db.query(text(query)).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

/**
 * Reviews to compare one by one: the newest proposed one, and of each status
 * up to `each` more, spread over the history.
 */
function sample(each: number): { id: string; revision: number }[] {
  const found: { id: string; revision: number }[] = [];
  for (const status of ["proposed", "accepted", "rejected"]) {
    const all = db
      .query(
        "SELECT id,revision FROM card_settlement_reviews WHERE status=? ORDER BY created_at DESC,id DESC",
      )
      .all(status) as { id: string; revision: number }[];
    const step = Math.max(1, Math.floor(all.length / each));
    found.push(...all.filter((_, index) => index % step === 0).slice(0, each));
  }
  return found;
}

/** Median wall time of `runs` executions, in milliseconds. */
async function timed(run: () => unknown, runs = 3): Promise<number> {
  const times: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  return Math.round(times.sort((left, right) => left - right)[Math.floor(runs / 2)]! * 10) / 10;
}

const guard = (sql: string): string => `SELECT ${sql} AS ok`;

describe("card settlement readiness reads on a scaled store without statistics", () => {
  test(
    "the list pages equal the ones the shipped read produced, ready and blocked",
    async () => {
      const first = await queryCardSettlements(executor(false));
      expect(first.items).toHaveLength(CARD_SETTLEMENT_PAGE_SIZE);
      expect(first).toEqual(await queryCardSettlements(executor(true)));
      // The page's blockers come from the readiness flags: recaptured
      // statements and allocations an accepted review already holds.
      const blockers = new Set(first.items.flatMap((item) => item.acceptanceBlockers));
      expect(blockers).toContain("statement_changed");
      expect(blockers).toContain("allocation_already_used");
      const count = (
        db.query("SELECT count(*) AS n FROM card_settlement_candidates").get() as { n: number }
      ).n;
      for (const offset of FULL ? [count - 7] : [CARD_SETTLEMENT_PAGE_SIZE, count - 7]) {
        const page = await queryCardSettlements(executor(false), { offset });
        expect(page.items.length).toBeGreaterThan(0);
        expect(page).toEqual(await queryCardSettlements(executor(true), { offset }));
      }
    },
    TIMEOUT,
  );

  test(
    "each review's reads and guards equal the shipped ones",
    async () => {
      const reviews = sample(FULL ? 1 : 4);
      expect(reviews.length).toBeGreaterThan(2);
      for (const { id, revision } of reviews) {
        expect(rows(CARD_SETTLEMENT_REVIEW_SQL, [id, 51, 0])).toEqual(
          rows(LEGACY_CARD_SETTLEMENT_REVIEWS_SQL, [id, 51, 0]),
        );
        for (const [sql, legacy] of [
          [CARD_OWNERSHIP_CANDIDATE_SQL, LEGACY_CARD_OWNERSHIP_CANDIDATE_SQL],
          [CARD_SETTLEMENT_PLAN_SQL, LEGACY_CARD_SETTLEMENT_PLAN_SQL],
          [OWNERSHIP_REVIEW_CANDIDATE_SQL, LEGACY_OWNERSHIP_REVIEW_CANDIDATE_SQL],
        ] as const)
          expect(rows(sql, [id])).toEqual(rows(legacy, [id]));
        expect(rows(guard(OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL), [id, revision])).toEqual(
          rows(guard(LEGACY_OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL), [id, revision]),
        );
        const page = await queryCardSettlements(executor(false), { proposalId: id });
        expect(page.items).toHaveLength(1);
        expect(page).toEqual(await queryCardSettlements(executor(true), { proposalId: id }));
      }
    },
    TIMEOUT,
  );

  test("no read walks the store's owners, statements or debits", () => {
    const { id, revision } = sample(1)[0]!;
    const reads: [string, string, unknown[], string[]][] = [
      [
        CARD_SETTLEMENT_PAGE_SQL,
        LEGACY_CARD_SETTLEMENT_REVIEWS_SQL,
        [null, 51, 0],
        ["review_page"],
      ],
      [CARD_SETTLEMENT_REVIEW_SQL, LEGACY_CARD_SETTLEMENT_REVIEWS_SQL, [id, 51, 0], []],
      [CARD_OWNERSHIP_CANDIDATE_SQL, LEGACY_CARD_OWNERSHIP_CANDIDATE_SQL, [id], []],
      [CARD_SETTLEMENT_PLAN_SQL, LEGACY_CARD_SETTLEMENT_PLAN_SQL, [id], []],
      [OWNERSHIP_REVIEW_CANDIDATE_SQL, LEGACY_OWNERSHIP_REVIEW_CANDIDATE_SQL, [id], []],
      [
        guard(OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL),
        guard(LEGACY_OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL),
        [id, revision],
        [],
      ],
    ];
    for (const [sql, legacy, args, allowed] of reads) {
      // The list orders every candidate to choose its page (`review_page`);
      // nothing else is read whole.
      expect(statementPlanProblems(explain(db, sql, args), allowed)).toEqual([]);
      // The checks see what the shipped reads did: the readiness view, which
      // ranks every statement and debit and owns every identity of the store.
      expect(statementPlanProblems(explain(db, legacy, args))).not.toEqual([]);
    }
  });

  test.if(FULL)(
    "timings at full scale",
    async () => {
      const { id, revision } = sample(1)[0]!;
      console.log(
        JSON.stringify(
          {
            store: built.counts,
            ms: {
              listFirstPage: await timed(() => queryCardSettlements(executor(false))),
              listLastPage: await timed(() =>
                queryCardSettlements(executor(false), { offset: 3_750 }),
              ),
              review: await timed(() => queryCardSettlements(executor(false), { proposalId: id })),
              ownershipCandidate: await timed(() => rows(CARD_OWNERSHIP_CANDIDATE_SQL, [id])),
              settlementPlan: await timed(() => rows(CARD_SETTLEMENT_PLAN_SQL, [id])),
              ownershipGuard: await timed(() =>
                rows(guard(OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL), [id, revision]),
              ),
              legacyListFirstPage: await timed(() => queryCardSettlements(executor(true)), 1),
              legacySettlementPlan: await timed(
                () => rows(LEGACY_CARD_SETTLEMENT_PLAN_SQL, [id]),
                1,
              ),
              legacyOwnershipGuard: await timed(
                () => rows(guard(LEGACY_OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL), [id, revision]),
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
