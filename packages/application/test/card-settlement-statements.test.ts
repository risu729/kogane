// The `カード照合` list grouped by statement (`queryCardSettlementStatements`)
// and one statement's candidates (`queryCardSettlements({ statementKey })`).
// On small random stores (packages/read-model/test/card-settlement-random-store.ts)
// whose reviews share statement keys and draw every decision, the reads equal
// a reference written another way: the statements, counts and chosen
// candidates computed in TypeScript from every candidate, and the readiness
// flags read through the migration 0044 view, which the keyed CTEs replace.
// Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomSettlementStore } from "../../read-model/test/card-settlement-random-store.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import {
  CARD_SETTLEMENT_STATEMENT_GROUP_SQL,
  CARD_SETTLEMENT_STATEMENT_PAGE_SQL,
  CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL,
  leadFirst,
  queryCardSettlements,
  queryCardSettlementStatements,
} from "../src/query/card-settlements.ts";
import { settlementReview } from "./card-settlement-fixture.ts";
import type { CardSettlementReview } from "../../domain/src/card-settlement-review.ts";

const SEED_COUNT = Number(process.env["KOGANE_CARD_SETTLEMENT_SEEDS"] ?? 4);
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1)
  throw new Error("KOGANE_CARD_SETTLEMENT_SEEDS must be a positive integer");
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);
const drawn = new Set<string>();

function rows(db: Database, sql: string, args: readonly unknown[]): unknown[] {
  return db.query(sql).all(...(args as SQLQueryBindings[]));
}

interface Candidate {
  id: string;
  statement_key: string;
  created_at: string;
  status: string;
}

/** Newest first, as every list orders candidates. */
const newest = (left: Candidate, right: Candidate): number =>
  left.created_at === right.created_at
    ? left.id < right.id
      ? 1
      : left.id > right.id
        ? -1
        : 0
    : left.created_at < right.created_at
      ? 1
      : -1;

function candidates(db: Database): Candidate[] {
  return db
    .query("SELECT id,statement_key,created_at,status FROM card_settlement_reviews")
    .all() as Candidate[];
}

/** Every statement key, newest candidate first, with its count. */
function statementsReference(
  all: Candidate[],
): { statement_key: string; candidate_count: number }[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of all)
    groups.set(candidate.statement_key, [
      ...(groups.get(candidate.statement_key) ?? []),
      candidate,
    ]);
  return [...groups.entries()]
    .map(([key, members]) => ({
      key,
      latest: members
        .map((member) => member.created_at)
        .sort()
        .at(-1)!,
      count: members.length,
    }))
    .sort((left, right) =>
      left.latest === right.latest
        ? left.key < right.key
          ? 1
          : -1
        : left.latest < right.latest
          ? 1
          : -1,
    )
    .map((group) => ({
      statement_key: group.key,
      candidate_count: group.count,
    }));
}

/** The `per` newest candidates of each key and every accepted one. */
function chosenReference(all: Candidate[], keys: string[], per: number): string[] {
  const chosen = new Set<string>();
  for (const key of keys) {
    const members = all.filter((candidate) => candidate.statement_key === key).sort(newest);
    for (const member of members.slice(0, per)) chosen.add(member.id);
    for (const member of members.slice(per))
      if (member.status === "accepted") {
        chosen.add(member.id);
        drawn.add("accepted candidate older than the newest ones");
      }
    if (members.length > per) drawn.add("statement with more candidates than judged");
  }
  return [...chosen];
}

/** The same rows through the migration 0044 view, for named candidates. */
const VIEW_REVIEWS_SQL = `SELECT c.id,c.facts_json,c.revision,c.status,c.decision_revision_id,c.event_id,c.obligation_id,c.settlement_id,c.created_at,
 r.statement_current,r.bank_current,r.ownership_current,r.allocation_available,c.statement_key
FROM card_settlement_reviews c LEFT JOIN card_settlement_readiness r ON r.id=c.id
WHERE c.id IN (SELECT value FROM json_each(?1)) ORDER BY c.created_at DESC,c.id DESC`;

function review(
  proposalId: string,
  status: CardSettlementReview["status"],
  blockers: string[] = [],
): CardSettlementReview {
  return {
    ...settlementReview(),
    proposalId,
    status,
    acceptanceBlockers: blockers,
  };
}

describe("the lead candidate of a statement", () => {
  test("an accepted candidate leads, then the newest ready one, then the newest", () => {
    const stale = review("stale", "proposed", ["statement_changed"]);
    const ready = review("ready", "proposed");
    const accepted = review("accepted", "accepted", ["allocation_already_used"]);
    const rejected = review("rejected", "rejected");
    expect(leadFirst([stale, ready, accepted]).map((item) => item.proposalId)).toEqual([
      "accepted",
      "stale",
      "ready",
    ]);
    expect(leadFirst([stale, rejected, ready]).map((item) => item.proposalId)).toEqual([
      "ready",
      "stale",
      "rejected",
    ]);
    // Nothing ready: the newest leads, and nothing is dropped.
    expect(leadFirst([rejected, stale]).map((item) => item.proposalId)).toEqual([
      "rejected",
      "stale",
    ]);
    expect(leadFirst([])).toEqual([]);
  });
  test("a withdrawn candidate never leads as if it were accepted", () => {
    const withdrawn = review("withdrawn", "withdrawn");
    const stale = review("stale", "proposed", ["statement_changed"]);
    expect(leadFirst([stale, withdrawn])[0]?.proposalId).toBe("stale");
  });
});

describe("statement-grouped reads on random stores", () => {
  test.each(SEEDS)(
    "seed %i: statements, chosen candidates and readiness equal the reference",
    async (seed) => {
      const { db } = randomSettlementStore(seed, new Set());
      const all = candidates(db);
      const statements = statementsReference(all);
      if (statements.some((statement) => statement.candidate_count > 1))
        drawn.add("statement with several candidates");
      for (const [limit, offset] of [
        [11, 0],
        [3, 0],
        [3, 3],
        [11, statements.length - 1],
        [11, statements.length],
      ] as const)
        expect(rows(db, CARD_SETTLEMENT_STATEMENT_PAGE_SQL, [limit, offset])).toEqual(
          statements.slice(offset, offset + limit),
        );
      const keys = statements.map((statement) => statement.statement_key);
      for (const per of [1, 2, 5])
        for (const page of [keys, keys.slice(0, 3), keys.slice(-2)]) {
          const chosen = chosenReference(all, page, per);
          const found = rows(db, CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [JSON.stringify(page), per]);
          expect(found).toEqual(rows(db, VIEW_REVIEWS_SQL, [JSON.stringify(chosen)]));
        }
      for (const key of keys.slice(0, 4))
        for (const [limit, offset] of [
          [51, 0],
          [1, 1],
        ] as const) {
          const ids = all
            .filter((candidate) => candidate.statement_key === key)
            .sort(newest)
            .slice(offset, offset + limit)
            .map((candidate) => candidate.id);
          const expected = (
            rows(db, VIEW_REVIEWS_SQL, [JSON.stringify(ids)]) as Record<string, unknown>[]
          ).map(({ statement_key: _, ...rest }) => rest);
          expect(rows(db, CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL, [key, limit, offset])).toEqual(
            expected,
          );
        }
      // The random facts are not the sweep's, so the reads may refuse them;
      // they refuse rather than return a partial group.
      const executor: SqlExecutor = {
        all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> =>
          rows(db, query, args) as T[],
        first: async <T>(query: string, args: readonly unknown[]): Promise<T | null> =>
          (db.query(query).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
      };
      const grouped = await queryCardSettlementStatements(executor).catch(
        (error: Error) => error.message,
      );
      if (typeof grouped === "string") expect(grouped).toBe("card_settlement_facts_invalid");
      else {
        expect(grouped.statements.map((group) => group.statementKey)).toEqual(keys.slice(0, 10));
        for (const group of grouped.statements)
          expect(group.candidates.length).toBeLessThanOrEqual(group.candidateCount);
      }
      await expect(queryCardSettlements(executor, { statementKey: "" })).rejects.toThrow(
        "invalid_statement_key",
      );
      await expect(
        queryCardSettlements(executor, {
          statementKey: keys[0]!,
          proposalId: "x",
        }),
      ).rejects.toThrow("invalid_query");
    },
    60_000,
  );

  test("the seeds drew grouped statements, a cap that cuts, and an older acceptance", () => {
    expect([...drawn].sort()).toEqual([
      "accepted candidate older than the newest ones",
      "statement with more candidates than judged",
      "statement with several candidates",
    ]);
  });
});
