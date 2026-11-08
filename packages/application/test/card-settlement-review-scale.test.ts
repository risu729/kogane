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
import { CARD_INFORMATION_READER_VERSION } from "../../domain/src/myjcb-card-information.ts";
import {
  CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL,
  CARD_SETTLEMENT_PAGE_SIZE,
  CARD_SETTLEMENT_PAGE_SQL,
  CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
  CARD_SETTLEMENT_RELATED_SQL,
  CARD_SETTLEMENT_REVIEW_SQL,
  CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS,
  CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED,
  CARD_SETTLEMENT_STATEMENT_GROUP_SQL,
  CARD_SETTLEMENT_STATEMENT_OLDER_SQL,
  CARD_SETTLEMENT_STATEMENT_PAGE_SIZE,
  CARD_SETTLEMENT_STATEMENT_PAGE_SQL,
  CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL,
  queryCardSettlementStatements,
  queryCardSettlements,
  queryRelatedCardSettlements,
} from "../src/query/card-settlements.ts";
import type {
  CardSettlementReview,
  CardSettlementStatementPage,
} from "../../domain/src/card-settlement-review.ts";
import { LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL } from "./card-settlement-statement-group-legacy-sql.ts";
import { LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL } from "./card-settlement-statement-older-legacy-sql.ts";
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

/**
 * The shipped text in place of the keyed list reads and the grouped read, or
 * every statement as given. The shipped grouped list never searched a
 * statement's older candidates, so the search finds none.
 */
function executor(legacy: boolean): SqlExecutor {
  const text = (query: string): string =>
    !legacy
      ? query
      : query === CARD_SETTLEMENT_PAGE_SQL || query === CARD_SETTLEMENT_REVIEW_SQL
        ? LEGACY_CARD_SETTLEMENT_REVIEWS_SQL
        : query === CARD_SETTLEMENT_STATEMENT_GROUP_SQL
          ? LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL
          : query;
  return {
    all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> =>
      legacy && query === CARD_SETTLEMENT_STATEMENT_OLDER_SQL
        ? []
        : (rows(text(query), args) as T[]),
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

/** Every page of the grouped list (at most `pages`), as one page. */
async function everyPage(sql: SqlExecutor, pages = Number.POSITIVE_INFINITY) {
  const statements: CardSettlementStatementPage["statements"] = [];
  let offset: number | null = 0;
  for (let read = 0; offset !== null && read < pages; read += 1) {
    const page: CardSettlementStatementPage = await queryCardSettlementStatements(sql, { offset });
    statements.push(...page.statements);
    offset = page.nextOffset;
  }
  return { statements };
}

const decidableReview = (item: CardSettlementReview): boolean =>
  item.status === "accepted" ||
  (item.status === "proposed" && item.acceptanceBlockers.length === 0);

function lead(page: { statements: CardSettlementStatementPage["statements"] }, key: string) {
  return page.statements.find((entry) => entry.statementKey === key)!.candidates[0]!;
}

/**
 * The intended change and nothing else: every statement as the shipped list
 * showed it, except that `key`, whose judged newest candidates hold no
 * acceptance and none ready, now leads with `ready` ahead of them.
 */
function expectOnlyLead(
  fresh: { statements: CardSettlementStatementPage["statements"] },
  legacy: { statements: CardSettlementStatementPage["statements"] },
  key: string,
  ready: CardSettlementReview,
): void {
  expect(fresh.statements.map((entry) => entry.statementKey)).toEqual(
    legacy.statements.map((entry) => entry.statementKey),
  );
  fresh.statements.forEach((entry, index) => {
    const shipped = legacy.statements[index]!;
    if (entry.statementKey !== key) {
      expect(entry).toEqual(shipped);
      return;
    }
    expect(shipped.candidates.some(decidableReview)).toBe(false);
    expect(entry.leadSearch).toBe("found");
    expect(entry.candidateCount).toBe(shipped.candidateCount);
    expect(entry.candidates[0]!.proposalId).toBe(ready.proposalId);
    expect(entry.candidates[0]!.status).toBe("proposed");
    expect(entry.candidates[0]!.acceptanceBlockers).toEqual([]);
    expect(entry.candidates.slice(1)).toEqual(shipped.candidates);
  });
}

/**
 * Each statement's lead against its whole list, judged candidate by candidate
 * through `queryCardSettlements({ statementKey })`: its accepted candidate,
 * else the newest ready one (the same review the statement's list returns),
 * else the newest. A statement whose search stopped at its limit leads with
 * its newest and says so, and only when its newest candidates decide nothing
 * and it has more older candidates that could be ready than the limit.
 */
async function expectLeads(page: {
  statements: CardSettlementStatementPage["statements"];
}): Promise<void> {
  for (const group of page.statements) {
    const all: CardSettlementReview[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const found: Awaited<ReturnType<typeof queryCardSettlements>> = await queryCardSettlements(
        executor(false),
        { statementKey: group.statementKey, offset },
      );
      all.push(...found.items);
      offset = found.nextOffset;
    }
    expect(all).toHaveLength(group.candidateCount);
    const ready = all.find(
      (item) => item.status === "proposed" && item.acceptanceBlockers.length === 0,
    );
    const [first] = group.candidates;
    const window = all.slice(0, CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT);
    const searched =
      all.length > CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT &&
      !all.some((item) => item.status === "accepted") &&
      !window.some(decidableReview);
    const couldBeReady = all
      .slice(CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT)
      .filter(
        (item) =>
          item.status === "proposed" &&
          item.facts.ownership === "established-same" &&
          item.facts.statement.accountId !== null &&
          item.facts.bankDebit.accountId !== null,
      );
    const readyAt = ready === undefined ? -1 : couldBeReady.indexOf(ready);
    if (!searched) expect(group.leadSearch).toBe("not_searched");
    if (all.some((item) => item.status === "accepted")) expect(first!.status).toBe("accepted");
    else if (searched && (readyAt >= CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED || readyAt < 0)) {
      expect(first).toEqual(all[0]);
      expect(group.leadSearch).toBe(
        couldBeReady.length >= CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED
          ? "truncated"
          : "none_ready",
      );
    } else if (ready !== undefined) {
      expect(first).toEqual(ready);
      if (searched) expect(group.leadSearch).toBe("found");
    } else expect(first).toEqual(all[0]);
  }
}

/**
 * The keyed passes over every statement of the store, from the oldest of each
 * window and then from the last candidate each pass returned for a statement
 * whose pass was full, against the frozen positional passes
 * (card-settlement-statement-older-legacy-sql.ts), pass for pass, with no
 * decision recorded between them. Returns the number of passes.
 */
function expectKeyedPassesEqualPositional(limit: number): number {
  const per = CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT;
  let searching = db
    .query(
      `SELECT statement_key,created_at,id FROM (
        SELECT statement_key,created_at,id,
         row_number() OVER (PARTITION BY statement_key ORDER BY created_at DESC,id DESC) AS position
        FROM card_settlement_candidates) WHERE position=?1 ORDER BY statement_key`,
    )
    .values(per) as [string, string, string][];
  let pass = 0;
  while (searching.length > 0) {
    const keyed = rows(CARD_SETTLEMENT_STATEMENT_OLDER_SQL, [JSON.stringify(searching), limit]) as {
      id: string;
      created_at: string;
      statement_key: string;
    }[];
    expect(keyed as unknown[]).toEqual(
      rows(LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL, [
        JSON.stringify(searching.map(([key]) => key)),
        per,
        pass * limit,
        limit,
      ]),
    );
    searching = searching.flatMap(([key]): [string, string, string][] => {
      const own = keyed.filter((row) => row.statement_key === key);
      const last = own.at(-1);
      return own.length === limit && last !== undefined ? [[key, last.created_at, last.id]] : [];
    });
    pass += 1;
  }
  return pass;
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
    "each review's competitors are the reservation's, each as its own review read shows it",
    async () => {
      let seen = 0;
      for (const { id } of sample(FULL ? 1 : 4)) {
        const ids = (
          db
            .query(
              `SELECT c.id FROM card_settlement_candidates c WHERE c.id<>?1 AND EXISTS(
                SELECT 1 FROM card_settlement_candidates a WHERE a.id=?1
                AND (c.statement_key=a.statement_key OR c.bank_key=a.bank_key
                 OR (json_extract(c.facts_json,'$.statement.sourceId')=json_extract(a.facts_json,'$.statement.sourceId')
                  AND json_extract(c.facts_json,'$.statement.accountId')=json_extract(a.facts_json,'$.statement.accountId')
                  AND json_extract(c.facts_json,'$.statement.period')=json_extract(a.facts_json,'$.statement.period'))))
               ORDER BY c.created_at DESC,c.id DESC LIMIT ?2`,
            )
            .all(id, CARD_SETTLEMENT_PAGE_SIZE) as { id: string }[]
        ).map((row) => row.id);
        const page = await queryRelatedCardSettlements(executor(false), id);
        expect(page?.items.map((item) => item.proposalId)).toEqual(ids);
        for (const item of page?.items ?? []) {
          const own = await queryCardSettlements(executor(false), { proposalId: item.proposalId });
          expect(own.items).toEqual([item]);
        }
        seen += ids.length;
      }
      // Each recapture of a paid bill is a candidate of the same statement.
      expect(seen).toBeGreaterThan(0);
      expect(await queryRelatedCardSettlements(executor(false), "cs_missing")).toBeNull();
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
    "every page of the grouped list equals the shipped one where its newest candidates decide the lead",
    async () => {
      // The grouped read itself is the shipped text's rows, statement for statement.
      const keys = (
        db
          .query("SELECT DISTINCT statement_key FROM card_settlement_candidates ORDER BY 1")
          .values() as string[][]
      ).map(([key]) => key!);
      for (const page of [keys, keys.slice(0, 3)])
        expect(
          rows(CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [
            JSON.stringify(page),
            CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
          ]),
        ).toEqual(
          rows(LEGACY_CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [
            JSON.stringify(page),
            CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
          ]),
        );
      // On this store every statement's newest candidates hold its
      // acceptance or a ready one, so no page changes.
      const fresh = await everyPage(executor(false), FULL ? 1 : Number.POSITIVE_INFINITY);
      expect(fresh).toEqual(await everyPage(executor(true), FULL ? 1 : Number.POSITIVE_INFINITY));
      await expectLeads(fresh);
    },
    TIMEOUT,
  );

  test(
    "a ready candidate older than the five newest of its statement leads it, and only that changes",
    async () => {
      db.run("SAVEPOINT older_ready");
      try {
        const before = await queryCardSettlementStatements(executor(false));
        // A statement no acceptance reserves, whose newest candidate is ready.
        const group = before.statements.find(
          (entry) =>
            entry.candidates[0]!.status === "proposed" &&
            entry.candidates[0]!.acceptanceBlockers.length === 0 &&
            entry.candidates.every((item) => item.status !== "accepted"),
        )!;
        const ready = group.candidates[0]!;
        // Newer candidates that cite captures no longer current, as the
        // sweep's candidates for another debit of the same amount do once it
        // is recaptured: synthetic copies of the statement's stale ones.
        const stale = db
          .query(
            `SELECT * FROM card_settlement_candidates WHERE statement_key=?1 AND id<>?2
             ORDER BY created_at DESC,id DESC LIMIT 5`,
          )
          .all(group.statementKey, ready.proposalId) as Record<string, SQLQueryBindings>[];
        expect(stale).toHaveLength(5);
        let copies = 0;
        const copy = (count: number): string[] =>
          Array.from({ length: count }, () => {
            const index = (copies += 1);
            const row = stale[index % stale.length]!;
            const id = `cs_synthetic_newer_${String(index).padStart(3, "0")}`;
            db.query(
              `INSERT INTO card_settlement_candidates(id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,
                bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            ).run(
              id,
              row["statement_key"]!,
              row["bank_key"]!,
              row["statement_observation_id"]!,
              row["statement_parse_run_id"]!,
              row["bank_observation_id"]!,
              row["bank_parse_run_id"]!,
              row["policy_release"]!,
              row["facts_json"]!,
              String(index).padStart(64, "e"),
              new Date(Date.parse("2026-12-01T00:00:00Z") + index * 60_000).toISOString(),
            );
            return id;
          }).reverse();
        const passes = (): { executor: SqlExecutor; count: () => number } => {
          let count = 0;
          const plain = executor(false);
          return {
            executor: {
              ...plain,
              all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> => {
                if (query === CARD_SETTLEMENT_STATEMENT_OLDER_SQL) count += 1;
                return plain.all<T>(query, args);
              },
            },
            count: () => count,
          };
        };

        // Five newer: the shipped list led with the newest of them.
        const newer = copy(5);
        let read = passes();
        let fresh = await everyPage(read.executor);
        let legacy = await everyPage(executor(true));
        expectOnlyLead(fresh, legacy, group.statementKey, ready);
        expect(lead(legacy, group.statementKey).proposalId).toBe(newer[0]!);
        let moved = fresh.statements.find((entry) => entry.statementKey === group.statementKey)!;
        expect(moved.candidateCount).toBe(group.candidateCount + 5);
        // The five newer ones follow it, newest first, each with its blockers.
        expect(moved.candidates.slice(1).map((item) => item.proposalId)).toEqual(newer);
        for (const item of moved.candidates.slice(1))
          expect(item.acceptanceBlockers).not.toEqual([]);
        expect(read.count()).toBe(1);
        await expectLeads(fresh);

        // Sixty more: the search reaches it on its second pass.
        copy(60);
        read = passes();
        fresh = await everyPage(read.executor);
        legacy = await everyPage(executor(true));
        expectOnlyLead(fresh, legacy, group.statementKey, ready);
        expect(read.count()).toBe(2);
        expect(65 - CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT).toBeGreaterThan(
          CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS,
        );
        await expectLeads(fresh);
        // The keyed passes return the positional ones' rows, pass for pass.
        expect(expectKeyedPassesEqualPositional(CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS)).toBe(2);
        expect(expectKeyedPassesEqualPositional(7)).toBeGreaterThan(2);

        // Rejected: no candidate of the statement is ready, the newest leads
        // as before, and the search ends once a pass is short.
        db.run("SAVEPOINT older_rejected");
        db.query(
          `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
           VALUES('dr_synthetic_reject','relation',?,1,'reject','manual','synthetic-operator',NULL,'synthetic','[]',NULL,NULL,'2026-12-02T00:00:00Z')`,
        ).run(`card-settlement:${ready.proposalId}`);
        db.query(
          `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
           VALUES(?,1,'rejected','dr_synthetic_reject',NULL,NULL,NULL,'2026-12-02T00:00:00Z')`,
        ).run(ready.proposalId);
        read = passes();
        fresh = await everyPage(read.executor);
        expect(fresh).toEqual(await everyPage(executor(true)));
        moved = fresh.statements.find((entry) => entry.statementKey === group.statementKey)!;
        expect(moved.candidates.some(decidableReview)).toBe(false);
        const eligibleOlder = (
          rows(`SELECT count(*) AS n FROM (${LEGACY_CARD_SETTLEMENT_STATEMENT_OLDER_SQL})`, [
            JSON.stringify([group.statementKey]),
            CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT,
            0,
            1e6,
          ]) as { n: number }[]
        )[0]!.n;
        expect(eligibleOlder).toBeLessThan(CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED);
        expect(read.count()).toBe(
          Math.floor(eligibleOlder / CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS) + 1,
        );
        expect(
          fresh.statements.find((entry) => entry.statementKey === group.statementKey)!.leadSearch,
        ).toBe("none_ready");
        await expectLeads(fresh);
        db.run("ROLLBACK TO older_rejected");
        db.run("RELEASE older_rejected");

        // Enough more that the ready one lies past the search's limit: the
        // search stops after its last pass, the newest leads as the shipped
        // list led, and the group says the search was cut, never that no
        // candidate is ready.
        const newest = copy(CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED)[0]!;
        read = passes();
        fresh = await everyPage(read.executor);
        legacy = await everyPage(executor(true));
        expect(read.count()).toBe(
          CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED / CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS,
        );
        expect(
          expectKeyedPassesEqualPositional(CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS),
        ).toBeGreaterThan(
          CARD_SETTLEMENT_OLDER_CANDIDATES_SEARCHED / CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS,
        );
        expect(fresh.statements.map((entry) => entry.statementKey)).toEqual(
          legacy.statements.map((entry) => entry.statementKey),
        );
        fresh.statements.forEach((entry, index) => {
          const shipped = legacy.statements[index]!;
          if (entry.statementKey !== group.statementKey) expect(entry).toEqual(shipped);
          else {
            expect(entry.leadSearch).toBe("truncated");
            expect(shipped.leadSearch).toBe("none_ready");
            expect({ ...entry, leadSearch: "none_ready" }).toEqual(shipped);
            expect(entry.candidates[0]!.proposalId).toBe(newest);
            expect(entry.candidates.map((item) => item.proposalId)).not.toContain(ready.proposalId);
          }
        });
        await expectLeads(fresh);
      } finally {
        db.run("ROLLBACK TO older_ready");
        db.run("RELEASE older_ready");
      }
    },
    TIMEOUT,
  );

  test(
    "a decision recorded between two passes on a candidate already judged skips no older candidate",
    async () => {
      db.run("SAVEPOINT older_decided");
      try {
        const before = await queryCardSettlementStatements(executor(false));
        const group = before.statements.find(
          (entry) =>
            entry.candidates[0]!.status === "proposed" &&
            entry.candidates[0]!.acceptanceBlockers.length === 0 &&
            entry.candidates.every((item) => item.status !== "accepted"),
        )!;
        const ready = group.candidates[0]!;
        const stale = db
          .query(
            `SELECT * FROM card_settlement_candidates WHERE statement_key=?1 AND id<>?2
             ORDER BY created_at DESC,id DESC LIMIT 5`,
          )
          .all(group.statementKey, ready.proposalId) as Record<string, SQLQueryBindings>[];
        expect(stale).toHaveLength(5);
        // The five newest and one full pass of newer stale copies: the ready
        // candidate is the first older candidate the second pass judges.
        const count =
          CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT + CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS;
        for (let index = 1; index <= count; index += 1) {
          const row = stale[index % stale.length]!;
          db.query(
            `INSERT INTO card_settlement_candidates(id,statement_key,bank_key,statement_observation_id,statement_parse_run_id,
              bank_observation_id,bank_parse_run_id,policy_release,facts_json,proposal_digest,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            `cs_synthetic_judged_${String(index).padStart(3, "0")}`,
            row["statement_key"]!,
            row["bank_key"]!,
            row["statement_observation_id"]!,
            row["statement_parse_run_id"]!,
            row["bank_observation_id"]!,
            row["bank_parse_run_id"]!,
            row["policy_release"]!,
            row["facts_json"]!,
            String(index).padStart(64, "d"),
            new Date(Date.parse("2026-12-01T00:00:00Z") + index * 60_000).toISOString(),
          );
        }
        // The operator rejects a candidate the first pass judged while the
        // page is read: the decision lands between the first and second pass.
        const plain = executor(false);
        const judged: string[][] = [];
        const racing: SqlExecutor = {
          ...plain,
          all: async <T>(query: string, args: readonly unknown[]): Promise<T[]> => {
            const found = await plain.all<T>(query, args);
            if (query !== CARD_SETTLEMENT_STATEMENT_OLDER_SQL) return found;
            judged.push((found as { id: string }[]).map((row) => row.id));
            if (judged.length === 1) {
              const rejected = judged[0]![10]!;
              db.query(
                `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
                 VALUES('dr_synthetic_between_passes','relation',?,1,'reject','manual','synthetic-operator',NULL,'synthetic','[]',NULL,NULL,'2026-12-02T00:00:00Z')`,
              ).run(`card-settlement:${rejected}`);
              db.query(
                `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
                 VALUES(?,1,'rejected','dr_synthetic_between_passes',NULL,NULL,NULL,'2026-12-02T00:00:00Z')`,
              ).run(rejected);
            }
            return found;
          },
        };
        const page = await queryCardSettlementStatements(racing);
        const moved = page.statements.find((entry) => entry.statementKey === group.statementKey)!;
        expect(judged[0]).toHaveLength(CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS);
        expect(judged[0]).not.toContain(ready.proposalId);
        // The second pass starts at the ready candidate, not one past it.
        expect(judged[1]![0]).toBe(ready.proposalId);
        expect(moved.leadSearch).toBe("found");
        expect(moved.candidates[0]!.proposalId).toBe(ready.proposalId);
      } finally {
        db.run("ROLLBACK TO older_decided");
        db.run("RELEASE older_decided");
      }
    },
    TIMEOUT,
  );

  test(
    "the grouped, per-statement and competitor lists read debit-account evidence once, for the reviews they return, as one review's read does",
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
              refusal_code: null,
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
      // A candidate's competitors, read the same way.
      const recaptured = grouped.statements.find((group) => group.candidateCount > 1)!;
      asked.length = 0;
      const related = await queryRelatedCardSettlements(
        withEvidence,
        recaptured.candidates[0]!.proposalId,
      );
      expect(related!.items.length).toBeGreaterThan(0);
      expect(asked).toEqual([related!.items.map((item) => item.proposalId)]);
      for (const item of related!.items)
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
      // The competitors' union (`related_review`) is read whole; each of its
      // three branches searches the candidates by its own index.
      [
        CARD_SETTLEMENT_RELATED_SQL,
        LEGACY_CARD_SETTLEMENT_REVIEWS_SQL,
        [id, 51, 0],
        ["related_review"],
      ],
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
    // A keyed pass continues after the oldest of the statement's window.
    const cursor = JSON.stringify([
      db
        .query(
          `SELECT statement_key,created_at,id FROM card_settlement_candidates WHERE statement_key=?1
           ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET ?2`,
        )
        .values(key, CARD_SETTLEMENT_CANDIDATES_PER_STATEMENT - 1)[0],
    ]);
    // The grouped reads: the statement page orders every candidate
    // (`statement_page`), the group and one statement's list reach theirs by key.
    for (const [sql, args, allowed] of [
      [CARD_SETTLEMENT_STATEMENT_PAGE_SQL, [11, 0], ["statement_page"]],
      [CARD_SETTLEMENT_STATEMENT_GROUP_SQL, [JSON.stringify([key]), 5], []],
      [
        CARD_SETTLEMENT_STATEMENT_OLDER_SQL,
        [cursor, CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS],
        [],
      ],
      [CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL, [key, 51, 0], []],
    ] as const)
      expect(statementPlanProblems(explain(db, sql, args), [...allowed])).toEqual([]);
    // A keyed pass finds the statement's candidates by key and filters them by
    // the cursor: no index holds (statement_key, created_at, id), so the
    // cursor narrows no index range and the pass sorts the candidates it keeps
    // (docs/card-settlements.md, Cost).
    const older = explain(db, CARD_SETTLEMENT_STATEMENT_OLDER_SQL, [
      cursor,
      CARD_SETTLEMENT_OLDER_CANDIDATES_PER_PASS,
    ]).map((step) => step.detail);
    expect(older).toContain(
      "SEARCH c USING INDEX card_settlement_candidates_statement (statement_key=?)",
    );
    expect(older.filter((step) => /\bcreated_at\b/u.test(step))).toEqual([]);
    // The pass's own steps, before the readiness CTEs: it sorts what it keeps.
    expect(older.indexOf("MATERIALIZE ready_candidates")).toBeGreaterThan(0);
    const pass = older.slice(0, older.indexOf("MATERIALIZE ready_candidates"));
    expect(pass).toContain(
      "SEARCH c USING INDEX card_settlement_candidates_statement (statement_key=?)",
    );
    expect(pass).toContain("USE TEMP B-TREE FOR ORDER BY");
    const indexes = (
      db.query("PRAGMA index_list(card_settlement_candidates)").all() as { name: string }[]
    ).map(({ name }) => [
      name,
      (
        db.query(`PRAGMA index_info(${JSON.stringify(name)})`).all() as { name: string | null }[]
      ).map((column) => column.name),
    ]);
    expect(
      indexes.filter(
        ([, columns]) => columns![0] === "statement_key" && columns![1] === "created_at",
      ),
    ).toEqual([]);
    expect(indexes).toContainEqual(["card_settlement_candidates_statement", ["statement_key"]]);
    for (const [sql, legacy, args, allowed] of reads) {
      // The list orders every candidate to choose its page (`review_page`);
      // nothing else is read whole.
      expect(statementPlanProblems(explain(db, sql, args), allowed)).toEqual([]);
      // The checks see what the shipped reads did: the readiness view, which
      // ranks every statement and debit and owns every identity of the store.
      expect(statementPlanProblems(explain(db, legacy, args))).not.toEqual([]);
    }
  });

  test("the debit-account evidence read probes only the page's candidates, their cited readings and their own pages", () => {
    const ids = JSON.stringify(
      (
        db
          .query(
            "SELECT id FROM card_settlement_candidates ORDER BY created_at DESC,id DESC LIMIT 50",
          )
          .values() as string[][]
      ).map(([id]) => id!),
    );
    const plan = explain(db, CARD_SETTLEMENT_DEBIT_ACCOUNT_SQL, [
      ids,
      CARD_DEBIT_ACCOUNT_POLICY,
      CARD_INFORMATION_READER_VERSION,
    ]);
    expect(statementPlanProblems(plan)).toEqual([]);
    const text = JSON.stringify(plan);
    expect(text).toContain("card_settlement_debit_account_evidence_candidate");
    // The page's reading is found by its unique (raw_sha256, card, version) key.
    expect(text).toContain("card_debit_account_statement_object");
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
              competitors: await timed(() => queryRelatedCardSettlements(executor(false), id)),
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
