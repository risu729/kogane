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
import { cardSettlementReadinessCtes } from "../../read-model/src/card-settlement-readiness.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { LEGACY_CARD_SETTLEMENT_READINESS_CTES } from "../../read-model/test/card-settlement-readiness-ctes-legacy-sql.ts";
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
import { CARD_DEBIT_ACCOUNT_POLICY } from "../../domain/src/card-debit-account.ts";
import {
  CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL,
  CARD_SETTLEMENT_PAGE_SIZE,
  CARD_SETTLEMENT_PAGE_SQL,
  CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
  CARD_SETTLEMENT_REVIEW_SQL,
  CARD_SETTLEMENT_STATEMENT_GROUP_SQL,
  CARD_SETTLEMENT_STATEMENT_PAGE_SIZE,
  CARD_SETTLEMENT_STATEMENT_PAGE_SQL,
  CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL,
  queryCardSettlementStatements,
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

/**
 * The columns the shipped reads had: the plan read adds `claim_available` and
 * the review's `event_id` (ADR 0054, G1b), compared on their own below.
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
          expect(shippedColumns(rows(sql, [id]))).toEqual(rows(legacy, [id]));
        expect(rows(guard(OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL), [id, revision])).toEqual(
          rows(guard(LEGACY_OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL), [id, revision]),
        );
        const page = await queryCardSettlements(executor(false), {
          proposalId: id,
        });
        expect(page.items).toHaveLength(1);
        expect(page).toEqual(await queryCardSettlements(executor(true), { proposalId: id }));
      }
    },
    TIMEOUT,
  );

  test(
    "the readiness CTEs keep their frozen text's columns, and claim_available its definition",
    () => {
      // ADR 0054 G1b: the frozen text is the CTEs before claim_available
      // (packages/read-model/test/card-settlement-readiness-ctes-legacy-sql.ts).
      const ids = JSON.stringify(
        (
          db.query("SELECT id FROM card_settlement_candidates ORDER BY id").values() as string[][]
        ).map(([id]) => id!),
      );
      const select = (ctes: string, columns: string) =>
        `WITH chosen AS (SELECT value AS id FROM json_each(?1)), ${ctes} SELECT ${columns} FROM readiness ORDER BY id`;
      const old = "id,statement_current,bank_current,ownership_current,allocation_available";
      expect(rows(select(cardSettlementReadinessCtes(), old), [ids])).toEqual(
        rows(select(LEGACY_CARD_SETTLEMENT_READINESS_CTES, old), [ids]),
      );
      // No economic claim and no alias class on this store: a claim is
      // unavailable exactly when another live accepted settlement holds the key.
      const claims = rows(select(cardSettlementReadinessCtes(), "id,claim_available"), [ids]);
      const reference = rows(
        `SELECT c.id,NOT EXISTS(SELECT 1 FROM live_consumption_claims l WHERE l.book='cash-movement'
          AND l.consumption_key=c.bank_key
          AND l.event_id IS NOT (SELECT r.event_id FROM card_settlement_reviews r WHERE r.id=c.id AND r.status='accepted')) AS claim_available
         FROM card_settlement_candidates c ORDER BY c.id`,
        [],
      );
      expect(claims).toEqual(reference);
      expect(
        statementPlanProblems(
          explain(db, select(cardSettlementReadinessCtes(), "id,claim_available"), [ids]),
        ),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "the statement-grouped list judges the candidates the view judges, and leads with the accepted or ready one",
    async () => {
      const grouped = await queryCardSettlementStatements(executor(false));
      expect(grouped.statements.length).toBeGreaterThan(1);
      expect(grouped.statements.length).toBeLessThanOrEqual(CARD_SETTLEMENT_STATEMENT_PAGE_SIZE);
      const view = (ids: string[]) =>
        rows(
          `SELECT c.id,r.statement_current,r.bank_current,r.ownership_current,r.allocation_available
           FROM card_settlement_reviews c LEFT JOIN card_settlement_readiness r ON r.id=c.id
           WHERE c.id IN (SELECT value FROM json_each(?1)) ORDER BY c.created_at DESC,c.id DESC`,
          [JSON.stringify(ids)],
        );
      const keys = grouped.statements.map((group) => group.statementKey);
      const found = rows(CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [
        JSON.stringify(keys),
        CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
      ]) as (Record<string, unknown> & { id: string })[];
      expect(
        found.map(
          ({ id, statement_current, bank_current, ownership_current, allocation_available }) => ({
            id,
            statement_current,
            bank_current,
            ownership_current,
            allocation_available,
          }),
        ),
      ).toEqual(view(found.map((row) => row.id)) as never);
      let recaptured = 0;
      for (const group of grouped.statements) {
        const counted = (
          db
            .query("SELECT count(*) AS n FROM card_settlement_candidates WHERE statement_key=?1")
            .get(group.statementKey) as { n: number }
        ).n;
        expect(group.candidateCount).toBe(counted);
        if (counted > 1) recaptured += 1;
        const [lead, ...rest] = group.candidates;
        if (rest.some((item) => item.status === "accepted")) throw new Error("accepted not first");
        if (
          lead!.status !== "accepted" &&
          rest.some((item) => item.acceptanceBlockers.length === 0 && item.status === "proposed")
        )
          throw new Error("ready candidate not first");
        // The statement's full list reaches every candidate the group did not carry.
        const all = await queryCardSettlements(executor(false), {
          statementKey: group.statementKey,
        });
        expect(all.items.length).toBe(Math.min(counted, 50));
      }
      expect(recaptured).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    "the grouped and per-statement lists read debit-account evidence once, for the reviews they return, as one review's read does",
    async () => {
      // The scaled store records no evidence, so the read answers with a
      // synthetic row for each statement's first candidate.
      const plain = await queryCardSettlementStatements(executor(false));
      const marked = new Set(plain.statements.map((group) => group.candidates[0]!.proposalId));
      const asked: string[][] = [];
      const withEvidence: SqlExecutor = {
        ...executor(false),
        all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> => {
          if (query !== CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL)
            return executor(false).all<T>(query, args);
          const ids = JSON.parse(String(args[0])) as string[];
          asked.push(ids);
          return ids
            .filter((id) => marked.has(id))
            .map((id) => ({
              candidate_id: id,
              statement_id: 7,
              reader_version: "synthetic-reader-1.0.0",
              outcome: "not_proposed",
              reason: "ambiguous_accounts",
              proposal_json: null,
              created_at: "2026-09-11T00:00:00Z",
            })) as T[];
        },
      };
      const grouped = await queryCardSettlementStatements(withEvidence);
      const judged = grouped.statements.flatMap((group) =>
        group.candidates.map((item) => item.proposalId),
      );
      expect(new Set(judged).size).toBe(judged.length);
      expect(asked).toHaveLength(1);
      expect([...asked[0]!].sort()).toEqual([...judged].sort());
      for (const group of grouped.statements)
        for (const item of group.candidates) {
          expect(item.debitAccount.outcome).toBe(
            marked.has(item.proposalId) ? "not_proposed" : "absent",
          );
          expect(item).toEqual(
            (await queryCardSettlements(withEvidence, { proposalId: item.proposalId })).items[0]!,
          );
        }
      asked.length = 0;
      const statement = await queryCardSettlements(withEvidence, {
        statementKey: grouped.statements[0]!.statementKey,
      });
      expect(asked).toEqual([statement.items.map((item) => item.proposalId)]);
      for (const item of statement.items)
        expect(item.debitAccount.outcome).toBe(
          marked.has(item.proposalId) ? "not_proposed" : "absent",
        );
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
    const key = (
      db
        .query(
          "SELECT statement_key FROM card_settlement_candidates ORDER BY created_at DESC LIMIT 1",
        )
        .get() as {
        statement_key: string;
      }
    ).statement_key;
    // The grouped reads: the statement page orders every candidate
    // (`statement_page`), the group and one statement's list reach theirs by key.
    for (const [sql, args, allowed] of [
      [CARD_SETTLEMENT_STATEMENT_PAGE_SQL, [11, 0], ["statement_page"]],
      [CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [JSON.stringify([key]), 5], []],
      [CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL, [key, 51, 0], []],
    ] as const)
      expect(statementPlanProblems(explain(db, sql, args), [...allowed])).toEqual([]);
    for (const [sql, legacy, args, allowed] of reads) {
      // The list orders every candidate to choose its page (`review_page`);
      // nothing else is read whole.
      expect(statementPlanProblems(explain(db, sql, args), allowed)).toEqual([]);
      // The checks see what the shipped reads did: the readiness view, which
      // ranks every statement and debit and owns every identity of the store.
      expect(statementPlanProblems(explain(db, legacy, args))).not.toEqual([]);
    }
  });

  test("the debit-account evidence read probes only the page's candidates", () => {
    const ids = JSON.stringify(
      (
        db
          .query(
            "SELECT id FROM card_settlement_candidates ORDER BY created_at DESC,id DESC LIMIT 50",
          )
          .values() as string[][]
      ).map(([id]) => id!),
    );
    const plan = explain(db, CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL, [ids, CARD_DEBIT_ACCOUNT_POLICY]);
    expect(statementPlanProblems(plan)).toEqual([]);
    expect(JSON.stringify(plan)).toContain("card_settlement_debit_account_evidence_candidate");
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
              statementsFirstPage: await timed(() =>
                queryCardSettlementStatements(executor(false)),
              ),
              oneStatementFirstPage: await timed(() =>
                queryCardSettlements(executor(false), {
                  statementKey: (
                    db
                      .query(
                        "SELECT statement_key FROM card_settlement_candidates GROUP BY statement_key ORDER BY count(*) DESC LIMIT 1",
                      )
                      .get() as { statement_key: string }
                  ).statement_key,
                }),
              ),
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
