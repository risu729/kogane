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
import { createHash } from "node:crypto";
import {
  CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
  CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS,
  CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED,
  CARD_SETTLEMENT_STATEMENT_GROUP_SQL,
  CARD_SETTLEMENT_STATEMENT_OLDER_SQL,
  CARD_SETTLEMENT_STATEMENT_PAGE_SQL,
  CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL,
  leadFirst,
  queryCardSettlements,
  queryCardSettlementStatements,
} from "../src/query/card-settlements.ts";
import { settlementFacts, settlementReview } from "./card-settlement-fixture.ts";
import {
  LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL,
  LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL_SHA256,
} from "./card-settlement-statement-group-legacy-sql.ts";
import {
  LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL,
  LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL_SHA256,
} from "./card-settlement-statement-older-legacy-sql.ts";
import type { CardSettlementReview } from "../../domain/src/card-settlement-review.ts";
import {
  cardSettlementEligible,
  type CardSettlementFacts,
} from "../../domain/src/card-settlement.ts";

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

/**
 * A scripted store for the search's loop: each statement has five candidates
 * the grouped read returns, ready or blocked as `window` says, and `older`
 * ones the search pages through, the one at `readyAt` ready. Every value is
 * synthetic.
 */
function scripted(
  statements: { key: string; window: "blocked" | "ready"; older: number; readyAt?: number }[],
) {
  const facts = JSON.stringify(settlementFacts());
  const row = (key: string, id: string, minute: number, ready: boolean) => ({
    id,
    facts_json: facts,
    revision: 0,
    status: "proposed",
    decision_revision_id: null,
    event_id: null,
    obligation_id: null,
    settlement_id: null,
    created_at: new Date(Date.parse("2026-10-01T00:00:00Z") - minute * 60_000).toISOString(),
    statement_current: ready ? 1 : 0,
    bank_current: 1,
    ownership_current: 1,
    allocation_available: 1,
    statement_key: key,
  });
  const passes: { keys: string[]; passed: number }[] = [];
  const executor: SqlExecutor = {
    all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> => {
      if (query === CARD_SETTLEMENT_STATEMENT_PAGE_SQL)
        return statements.map((statement) => ({
          statement_key: statement.key,
          candidate_count: CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT + statement.older,
        })) as T[];
      if (query === CARD_SETTLEMENT_STATEMENT_GROUP_SQL)
        return statements.flatMap((statement) =>
          Array.from({ length: CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT }, (_, index) =>
            row(statement.key, `${statement.key}-w${index}`, index, statement.window === "ready"),
          ),
        ) as T[];
      if (query === CARD_SETTLEMENT_STATEMENT_OLDER_SQL) {
        // Each statement's cursor is the last candidate judged: the oldest of
        // its window (`-w4`) on the first pass, else the last older one
        // (`-o<n>`) the previous pass returned, with that one's creation time.
        const cursors = JSON.parse(String(args[0])) as [string, string, string][];
        const [limit] = args.slice(1) as [number];
        expect(args).toHaveLength(2);
        expect(limit).toBe(CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS);
        const after = cursors.map(([key, createdAt, id]) => {
          const window = `${key}-w${String(CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT - 1)}`;
          const passed = id === window ? 0 : Number(/^.+-o(\d+)$/u.exec(id)![1]) + 1;
          expect(createdAt).toBe(
            row(key, id, CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT - 1 + passed, false).created_at,
          );
          return { key, passed };
        });
        const keys = after.map((cursor) => cursor.key);
        // The scripted statements still searching have all passed as many.
        const passed = after[0]!.passed;
        for (const cursor of after) expect(cursor.passed).toBe(passed);
        passes.push({ keys, passed });
        return statements
          .filter((statement) => keys.includes(statement.key))
          .flatMap((statement) =>
            Array.from(
              { length: Math.max(0, Math.min(limit, statement.older - passed)) },
              (_, index) =>
                row(
                  statement.key,
                  `${statement.key}-o${passed + index}`,
                  CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT + passed + index,
                  statement.readyAt === passed + index,
                ),
            ),
          ) as T[];
      }
      return [];
    },
    first: async () => null,
  };
  return { executor, passes };
}

describe("the older-candidate search's bound", () => {
  test("it searches only undecided statements, stops at its limit and names how far it looked", async () => {
    expect(
      CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED % CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS,
    ).toBe(0);
    const limit = CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED;
    const { executor, passes } = scripted([
      { key: "s-ready-window", window: "ready", older: 10_000 },
      { key: "s-no-older", window: "blocked", older: 0 },
      { key: "s-found-second-pass", window: "blocked", older: 10_000, readyAt: 60 },
      { key: "s-found-last", window: "blocked", older: 10_000, readyAt: limit - 1 },
      { key: "s-past-limit", window: "blocked", older: 10_000, readyAt: limit },
      { key: "s-short", window: "blocked", older: 120 },
      { key: "s-exactly-limit", window: "blocked", older: limit },
      // One short of the limit: the last pass is short, so every one was judged.
      { key: "s-one-short", window: "blocked", older: limit - 1 },
      { key: "s-one-past", window: "blocked", older: limit + 1 },
    ]);
    const page = await queryCardSettlementStatements(executor);
    const by = new Map(page.statements.map((group) => [group.statementKey, group]));
    expect(page.coverage.olderCandidatesSearched).toBe(limit);
    expect(
      Object.fromEntries(page.statements.map((group) => [group.statementKey, group.leadSearch])),
    ).toEqual({
      "s-ready-window": "not_searched",
      "s-no-older": "not_searched",
      "s-found-second-pass": "found",
      "s-found-last": "found",
      "s-past-limit": "truncated",
      "s-short": "none_ready",
      // A full last pass at the limit: whether more follow is not read, so
      // the group never says none is ready.
      "s-exactly-limit": "truncated",
      "s-one-short": "none_ready",
      "s-one-past": "truncated",
    });
    expect(by.get("s-found-second-pass")!.candidates[0]!.proposalId).toBe(
      "s-found-second-pass-o60",
    );
    expect(by.get("s-found-last")!.candidates[0]!.proposalId).toBe(`s-found-last-o${limit - 1}`);
    for (const key of [
      "s-past-limit",
      "s-short",
      "s-exactly-limit",
      "s-no-older",
      "s-one-short",
      "s-one-past",
    ])
      expect(by.get(key)!.candidates[0]!.proposalId).toBe(`${key}-w0`);
    // One read a pass for the statements still searching, never past the limit.
    expect(passes.map((pass) => pass.passed)).toEqual(
      Array.from(
        { length: limit / CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS },
        (_, index) => index * CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS,
      ),
    );
    const searching = [
      "s-found-second-pass",
      "s-found-last",
      "s-past-limit",
      "s-short",
      "s-exactly-limit",
      "s-one-short",
      "s-one-past",
    ];
    expect(passes[0]!.keys).toEqual(searching);
    expect(passes[1]!.keys).toEqual(searching);
    expect(passes[2]!.keys).toEqual([
      "s-found-last",
      "s-past-limit",
      "s-short",
      "s-exactly-limit",
      "s-one-short",
      "s-one-past",
    ]);
    expect(passes.at(-1)!.keys).toEqual([
      "s-found-last",
      "s-past-limit",
      "s-exactly-limit",
      "s-one-short",
      "s-one-past",
    ]);
  });

  test("its worst case is eight reads a page and 200 judged older candidates a statement", async () => {
    // Ten statements whose newest decide nothing and whose older candidates
    // never turn ready: every pass reads all ten at once.
    const { executor, passes } = scripted(
      Array.from({ length: 10 }, (_, index) => ({
        key: `s-worst-${String(index)}`,
        window: "blocked" as const,
        older: 10_000,
      })),
    );
    const reads: string[] = [];
    const older = new Map<string, number>();
    const counted: SqlExecutor = {
      all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> => {
        reads.push(query);
        const found = await executor.all<T>(query, args);
        if (query === CARD_SETTLEMENT_STATEMENT_OLDER_SQL)
          for (const row of found as { statement_key: string }[])
            older.set(row.statement_key, (older.get(row.statement_key) ?? 0) + 1);
        return found;
      },
      first: executor.first,
    };
    const page = await queryCardSettlementStatements(counted);
    expect(page.statements.map((group) => group.leadSearch)).toEqual(
      Array.from({ length: 10 }, () => "truncated"),
    );
    // The statement page, the window, four passes, the history and the
    // debit-account evidence.
    expect(reads.length).toBe(8);
    expect(reads.filter((query) => query === CARD_SETTLEMENT_STATEMENT_OLDER_SQL).length).toBe(4);
    expect(passes.map((pass) => pass.keys.length)).toEqual([10, 10, 10, 10]);
    expect([...older.values()]).toEqual(
      Array.from({ length: 10 }, () => CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED),
    );
    expect([...older.values()].reduce((sum, count) => sum + count, 0)).toBe(2_000);
  });

  test("on drawn histories its lead and code equal a reference written from the counts", async () => {
    const limit = CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED;
    const sizes = [0, 1, 49, 50, 51, 149, 150, limit - 1, limit, limit + 1, 260] as const;
    const seen = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const pick = draws(seed);
      const statements = Array.from({ length: 10 }, (_, index) => {
        const older = pick(sizes);
        const at = pick([undefined, 0, 49, 50, limit - 1, limit, older - 1, older] as const);
        return {
          key: `s-${String(seed)}-${String(index)}`,
          window: pick(["blocked", "blocked", "blocked", "ready"] as const),
          older,
          ...(at === undefined || at < 0 ? {} : { readyAt: at }),
        };
      });
      const { executor, passes } = scripted(statements);
      const page = await queryCardSettlementStatements(executor);
      expect(passes.length).toBeLessThanOrEqual(limit / CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS);
      for (const statement of statements) {
        // Written from the counts, not from the loop: the window decides, or
        // the newest ready one among the first `limit` older ones leads, or
        // the newest leads and the code says whether all of them were judged.
        const window = `${statement.key}-w0`;
        const expected: { lead: string; leadSearch: string } =
          statement.window === "ready" || statement.older === 0
            ? { lead: window, leadSearch: "not_searched" }
            : statement.readyAt !== undefined &&
                statement.readyAt < Math.min(statement.older, limit)
              ? { lead: `${statement.key}-o${String(statement.readyAt)}`, leadSearch: "found" }
              : {
                  lead: window,
                  leadSearch: statement.older >= limit ? "truncated" : "none_ready",
                };
        const group = page.statements.find((entry) => entry.statementKey === statement.key)!;
        expect({
          lead: group.candidates[0]!.proposalId,
          leadSearch: group.leadSearch as string,
        }).toEqual(expected);
        seen.add(expected.leadSearch);
      }
    }
    expect([...seen].sort()).toEqual(["found", "none_ready", "not_searched", "truncated"]);
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
          // The window it judges is the shipped one (ADR 0090 adds a search, not a change to it).
          expect(found).toEqual(
            rows(db, LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [JSON.stringify(page), per]),
          );
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

/** Deterministic draws for the synthetic history below. */
function draws(seed: number): <T>(choices: readonly T[]) => T {
  let state = (seed * 7_919 + 104_729) >>> 0;
  return <T>(choices: readonly T[]): T => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return choices[(state >>> 8) % choices.length]!;
  };
}

/** The facts terms the older-candidate search requires, read in TypeScript. */
const searchable = (facts: Partial<CardSettlementFacts>): boolean =>
  facts.ownership === "established-same" &&
  facts.statement?.accountId != null &&
  facts.bankDebit?.accountId != null;

/**
 * More candidates for a few statements of the store, as recaptures add them:
 * the sweep's fact shape (card-settlement-fixture.ts) with the owner and
 * either account drawn otherwise, creation times that tie, and some rejected.
 * They cite the observations of a candidate the store already has for the
 * statement, so the insert guard admits them. Every value is synthetic.
 */
function addHistory(db: Database, seed: number, drawnHere: Set<string>): void {
  const pick = draws(seed);
  const keys = (
    db
      .query("SELECT DISTINCT statement_key FROM card_settlement_candidates ORDER BY 1")
      .values() as string[][]
  ).map(([key]) => key!);
  let sequence = 0;
  for (const key of keys.filter((_, index) => index % 2 === seed % 2).slice(0, 4)) {
    const cited = db
      .query("SELECT * FROM card_settlement_candidates WHERE statement_key=?1 ORDER BY id LIMIT 1")
      .get(key) as Record<string, SQLQueryBindings>;
    const count = pick([3, 6, 9, 12, 14]);
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      const id = `cs_history_${seed}_${pick(["a", "b", "c"])}${String(sequence).padStart(3, "0")}`;
      const facts = structuredClone(settlementFacts()) as unknown as Record<
        string,
        Record<string, unknown> | string
      >;
      const shape = pick([
        "searchable",
        "searchable",
        "searchable",
        "owner unknown",
        "owner differs",
        "no ownership",
        "no card account",
        "no bank account",
        "missing bank account",
      ] as const);
      const statement = facts["statement"] as Record<string, unknown>;
      const bankDebit = facts["bankDebit"] as Record<string, unknown>;
      if (shape === "owner unknown") facts["ownership"] = "unknown";
      if (shape === "owner differs") facts["ownership"] = "different";
      if (shape === "no ownership") delete facts["ownership"];
      if (shape === "no card account") statement["accountId"] = null;
      if (shape === "no bank account") bankDebit["accountId"] = null;
      if (shape === "missing bank account") delete bankDebit["accountId"];
      db.query(
        `INSERT INTO card_settlement_candidates(id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,
          bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        key,
        cited["bank_key"]!,
        cited["statement_observation_id"]!,
        cited["statement_parse_run_id"]!,
        cited["bank_observation_id"]!,
        cited["bank_parse_run_id"]!,
        cited["policy_release"]!,
        JSON.stringify(facts),
        `${seed.toString(16)}d${String(sequence).padStart(4, "0")}`.padStart(64, "c"),
        `2026-10-${pick(["01", "02", "02", "03", "05"])}T00:00:00Z`,
      );
      if (pick([false, false, true])) {
        db.query(
          `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
           VALUES(?,'relation',?,1,'reject','manual','synthetic-operator',NULL,'synthetic','[]',NULL,NULL,'2026-10-06')`,
        ).run(`dr-history-${seed}-${sequence}`, `card-settlement:${id}`);
        db.query(
          `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
           VALUES(?,1,'rejected',?,NULL,NULL,NULL,'2026-10-06')`,
        ).run(id, `dr-history-${seed}-${sequence}`);
      }
      drawnHere.add(`history: ${shape}`);
    }
  }
}

/**
 * The candidates the older-candidate search judges, computed in TypeScript:
 * of each statement, its candidates after the `per` newest that no decision
 * names and whose facts the search's terms admit, newest first, the `limit`
 * after the first `passed`.
 */
function olderReference(
  db: Database,
  keys: string[],
  per: number,
  passed: number,
  limit: number,
  drawnHere: Set<string>,
): string[] {
  const all = db
    .query(
      `SELECT c.id,c.statement_key,c.created_at,c.facts_json,
        EXISTS(SELECT 1 FROM card_settlement_decisions d WHERE d.proposal_id=c.id) AS decided
       FROM card_settlement_candidates c`,
    )
    .all() as (Candidate & { facts_json: string; decided: number })[];
  const chosen: string[] = [];
  for (const key of keys) {
    const members = all.filter((candidate) => candidate.statement_key === key).sort(newest);
    const kept = members.slice(per).filter((candidate) => {
      if (candidate.decided === 1) {
        drawnHere.add("older: left out by a decision");
        return false;
      }
      if (!searchable(JSON.parse(candidate.facts_json) as Partial<CardSettlementFacts>)) {
        drawnHere.add("older: left out by its facts");
        return false;
      }
      return true;
    });
    const pass = kept.slice(passed, passed + limit);
    if (pass.length > 0) drawnHere.add("older: judged");
    if (kept.length > passed + limit) drawnHere.add("older: a pass that cuts");
    if (passed > 0 && pass.length > 0) drawnHere.add("older: a later pass");
    chosen.push(...pass.map((candidate) => candidate.id));
  }
  return chosen;
}

/**
 * The keyed search's passes over `page` with no bound on their number, as
 * `queryCardSettlementStatements` makes them: the first continues after each
 * statement's `per`-th newest candidate (the oldest of its window), each later
 * one after the last candidate the previous pass returned for a statement whose
 * pass was full. `between` runs after each pass, before the next.
 */
function keyedPasses(
  db: Database,
  all: Candidate[],
  page: string[],
  per: number,
  limit: number,
  between?: (found: unknown[]) => void,
): { keys: string[]; found: unknown[] }[] {
  let searching = page.flatMap((key): [string, string, string][] => {
    const members = all.filter((candidate) => candidate.statement_key === key).sort(newest);
    const last = members[per - 1];
    return members.length > per && last !== undefined ? [[key, last.created_at, last.id]] : [];
  });
  const passes: { keys: string[]; found: unknown[] }[] = [];
  while (searching.length > 0) {
    const found = rows(db, CARD_SETTLEMENT_STATEMENT_OLDER_SQL, [
      JSON.stringify(searching),
      limit,
    ]) as Candidate[];
    passes.push({ keys: searching.map(([key]) => key), found });
    between?.(found);
    searching = searching.flatMap(([key]): [string, string, string][] => {
      const own = found.filter((row) => row.statement_key === key);
      const last = own.at(-1);
      return own.length === limit && last !== undefined ? [[key, last.created_at, last.id]] : [];
    });
  }
  return passes;
}

describe("the older-candidate search on random stores with synthetic history", () => {
  const drawnHere = new Set<string>();

  test("the frozen grouped read is the text #1021 shipped, byte for byte", () => {
    expect(
      createHash("sha256").update(LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL).digest("hex"),
    ).toBe(LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL_SHA256);
  });

  test("the search's facts terms admit every eligible candidate", () => {
    // `cardSettlementEligible` requires each term, so a candidate the terms
    // leave out is never ready; the converse need not hold.
    const facts = settlementFacts();
    expect(cardSettlementEligible(facts)).toBe(true);
    expect(searchable(facts)).toBe(true);
    for (const changed of [
      { ...facts, ownership: "unknown" as const },
      { ...facts, ownership: "different" as const },
      { ...facts, statement: { ...facts.statement, accountId: null } },
      { ...facts, bankDebit: { ...facts.bankDebit, accountId: null } },
    ]) {
      expect(searchable(changed)).toBe(false);
      expect(cardSettlementEligible(changed)).toBe(false);
    }
    expect(cardSettlementEligible(settlementFacts(true))).toBe(false);
  });

  test("the frozen positional search is the text #1132 first shipped, byte for byte", () => {
    expect(
      createHash("sha256").update(LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL).digest("hex"),
    ).toBe(LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL_SHA256);
  });

  test.each(SEEDS)(
    "seed %i: the search judges the reference's candidates, and the grouped read stays the shipped one",
    (seed) => {
      const { db } = randomSettlementStore(seed, new Set());
      addHistory(db, seed, drawnHere);
      const all = candidates(db);
      const keys = statementsReference(all).map((statement) => statement.statement_key);
      for (const per of [1, 2, 5])
        for (const page of [keys, keys.slice(0, 3), keys.slice(-2)]) {
          expect(
            rows(db, CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [JSON.stringify(page), per]),
          ).toEqual(
            rows(db, LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [JSON.stringify(page), per]),
          );
          // The frozen positional passes judge the reference's candidates.
          for (const [passed, limit] of [
            [0, 50],
            [0, 2],
            [2, 2],
            [3, 1],
            [50, 50],
          ] as const) {
            const chosen = olderReference(db, page, per, passed, limit, drawnHere);
            expect(
              rows(db, LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL, [
                JSON.stringify(page),
                per,
                passed,
                limit,
              ]),
            ).toEqual(rows(db, VIEW_REVIEWS_SQL, [JSON.stringify(chosen)]));
          }
          // The keyed passes, from the oldest of each window and then from
          // the last candidate each pass judged, return the frozen positional
          // passes' rows, pass for pass, when no decision lands between them.
          for (const limit of [50, 3, 2, 1]) {
            const keyed = keyedPasses(db, all, page, per, limit);
            keyed.forEach(({ keys: searching, found }, index) => {
              expect(found).toEqual(
                rows(db, LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL, [
                  JSON.stringify(searching),
                  per,
                  index * limit,
                  limit,
                ]),
              );
              if (index > 0) drawnHere.add("keyed: a pass after a cursor");
            });
          }
        }
    },
    60_000,
  );

  test.each(SEEDS)(
    "seed %i: a decision recorded between two keyed passes skips no candidate",
    (seed) => {
      const { db } = randomSettlementStore(seed, new Set());
      addHistory(db, seed, drawnHere);
      const all = candidates(db);
      const keys = statementsReference(all).map((statement) => statement.statement_key);
      const per = 1;
      const limit = 2;
      // Every candidate the passes could judge, read before any decision.
      const before = rows(db, LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL, [
        JSON.stringify(keys),
        per,
        0,
        1e6,
      ]) as { id: string; statement_key: string }[];
      db.run("SAVEPOINT between_passes");
      try {
        let decided = 0;
        const continued = new Set<string>();
        const keyed = keyedPasses(db, all, keys, per, limit, (found) => {
          // After each pass, reject the first candidate it judged of a
          // statement whose pass was full, so that statement passes again.
          const judged = found as { id: string; statement_key: string }[];
          const first = judged.find(
            (row) =>
              judged.filter((other) => other.statement_key === row.statement_key).length === limit,
          );
          if (first === undefined) return;
          continued.add(first.statement_key);
          decided += 1;
          db.query(
            `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
             VALUES(?,'relation',?,1,'reject','manual','synthetic-operator',NULL,'synthetic','[]',NULL,NULL,'2026-10-07')`,
          ).run(`dr-between-${seed}-${decided}`, `card-settlement:${first.id}`);
          db.query(
            `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
             VALUES(?,1,'rejected',?,NULL,NULL,NULL,'2026-10-07')`,
          ).run(first.id, `dr-between-${seed}-${decided}`);
        });
        // Each statement's passes, joined, are its candidates as they were
        // before the first decision: none skipped, none judged twice.
        for (const key of keys)
          expect(
            keyed.flatMap(({ found }) =>
              (found as { id: string; statement_key: string }[])
                .filter((row) => row.statement_key === key)
                .map((row) => row.id),
            ),
          ).toEqual(before.filter((row) => row.statement_key === key).map((row) => row.id));
        // A statement passed again after a decision on one it had judged.
        if (
          keyed.some(
            ({ found }, index) =>
              index > 0 &&
              (found as { statement_key: string }[]).some((row) =>
                continued.has(row.statement_key),
              ),
          )
        )
          drawnHere.add("keyed: a decision between passes");
      } finally {
        db.run("ROLLBACK TO between_passes");
        db.run("RELEASE between_passes");
      }
    },
    60_000,
  );

  test("the seeds drew every history shape and every way the search chooses", () => {
    expect([...drawnHere].sort()).toEqual([
      "history: missing bank account",
      "history: no bank account",
      "history: no card account",
      "history: no ownership",
      "history: owner differs",
      "history: owner unknown",
      "history: searchable",
      "keyed: a decision between passes",
      "keyed: a pass after a cursor",
      "older: a later pass",
      "older: a pass that cuts",
      "older: judged",
      "older: left out by a decision",
      "older: left out by its facts",
    ]);
  });
});
