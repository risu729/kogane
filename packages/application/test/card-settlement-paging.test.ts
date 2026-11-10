// The card settlement reads never offer a page their own budget refuses: the
// review list (and one statement's candidates and a review's competitors),
// the list grouped by statement and the statements without a candidate. Each
// read is walked from offset 0 along the `nextOffset` it offers, under grants
// of several `maxRows`, on synthetic stores held in memory: every offered
// page must be served, and the walk ends with `nextPage: "none"` when the
// last row was read, or `"budget_exceeded"` when rows follow that the grant
// may not read. Every value is synthetic.
import { describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { GRANT_LIMITS, type Grant } from "../src/grants.ts";
import {
  CARD_SETTLEMENT_EXISTS_SQL,
  CARD_SETTLEMENT_PAGE_SIZE,
  CARD_SETTLEMENT_PAGE_SQL,
  CARD_SETTLEMENT_RELATED_SQL,
  CARD_SETTLEMENT_REVIEW_SQL,
  CARD_SETTLEMENT_STATEMENT_GROUP_SQL,
  CARD_SETTLEMENT_STATEMENT_PAGE_SIZE,
  CARD_SETTLEMENT_STATEMENT_PAGE_SQL,
  CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL,
} from "../src/query/card-settlements.ts";
import {
  readCardSettlementStatementsForGrant,
  readCardSettlementsForGrant,
} from "../src/query/card-settlements-read.ts";
import {
  reviewUnmatchedCardStatements,
  UNMATCHED_PAGE_SIZE,
  UNMATCHED_STATEMENTS_SQL,
} from "../src/query/card-statements-unmatched.ts";
import { settlementFacts } from "./card-settlement-fixture.ts";

const grant = (maxRows: number): Grant => ({
  principal: "synthetic-settlement-pager",
  capabilities: ["records.read"],
  scopes: { sources: "*", accounts: "*" },
  budget: { maxRows, maxProposalTargets: 1, maxExplainDepth: 1 },
});

const FACTS = JSON.stringify(settlementFacts());
const reviewRow = (n: number, statementKey = "statement-synthetic") => ({
  id: `cs-${String(n).padStart(5, "0")}`,
  facts_json: FACTS,
  revision: 0,
  status: "proposed",
  decision_revision_id: null,
  event_id: null,
  obligation_id: null,
  settlement_id: null,
  created_at: "2026-09-11T00:00:00Z",
  statement_current: 1,
  bank_current: 1,
  ownership_current: 1,
  allocation_available: 1,
  statement_key: statementKey,
});
const unmatchedRow = (n: number) => ({
  id: n + 1,
  parse_run_id: 1,
  source_account: "synthetic-card",
  unit_ref: "JPY",
  source_id: "myjcb",
  value_status: "unknown",
  coefficient: null,
  scale: null,
  payment_date: null,
  as_of: null,
  period: null,
  statement_key: `statement-${n}`,
  account_id: null,
  owner_ref: null,
  evidence_refs_json: null,
});

/**
 * A store of `rows` candidates (or statements, or unmatched totals): each
 * page read is answered from its LIMIT and OFFSET binds, and every other read
 * (history, debit-account evidence) is empty. One candidate per statement,
 * so the grouped list judges no older candidate.
 */
function store(rows: number): SqlExecutor {
  const window = (binds: readonly unknown[], limit: number, offset: number) => {
    const start = binds[offset] as number;
    return Array.from(
      { length: Math.max(0, Math.min(binds[limit] as number, rows - start)) },
      (_, n) => start + n,
    );
  };
  return {
    all: async <T>(sql: string, binds: readonly unknown[]): Promise<T[]> => {
      if (
        sql === CARD_SETTLEMENT_PAGE_SQL ||
        sql === CARD_SETTLEMENT_STATEMENT_REVIEWS_SQL ||
        sql === CARD_SETTLEMENT_RELATED_SQL
      )
        return window(binds, 1, 2).map((n) => reviewRow(n)) as T[];
      if (sql === CARD_SETTLEMENT_REVIEW_SQL) return (rows > 0 ? [reviewRow(0)] : []) as T[];
      if (sql === CARD_SETTLEMENT_STATEMENT_PAGE_SQL)
        return window(binds, 0, 1).map((n) => ({
          statement_key: `statement-${n}`,
          candidate_count: 1,
        })) as T[];
      if (sql === CARD_SETTLEMENT_STATEMENT_GROUP_SQL)
        return (JSON.parse(binds[0] as string) as string[]).map((key, n) =>
          reviewRow(n, key),
        ) as T[];
      if (sql === UNMATCHED_STATEMENTS_SQL) return window(binds, 0, 1).map(unmatchedRow) as T[];
      return [];
    },
    first: async <T>(sql: string): Promise<T | null> =>
      (sql === CARD_SETTLEMENT_EXISTS_SQL ? { present: 1 } : null) as T | null,
  };
}

interface Page {
  status: "ok" | "refused" | "not_found";
  nextOffset: number | null;
  nextPage: unknown;
  length: number;
}
type Read = (sql: SqlExecutor, grant: Grant, offset: number) => Promise<Page>;

const asPage = (
  outcome:
    | { status: "ok"; answer: { nextOffset: number | null; nextPage?: unknown } }
    | { status: "refused" | "not_found" },
  length: (answer: never) => number,
): Page =>
  outcome.status === "ok"
    ? {
        status: "ok",
        nextOffset: outcome.answer.nextOffset,
        nextPage: outcome.answer.nextPage,
        length: length(outcome.answer as never),
      }
    : { status: outcome.status, nextOffset: null, nextPage: undefined, length: 0 };

const list =
  (extra: Record<string, string>): Read =>
  async (sql, grant, offset) =>
    asPage(
      await readCardSettlementsForGrant({ grant, sql, request: { ...extra, offset } }),
      (answer: { items: unknown[] }) => answer.items.length,
    );

const READS: [name: string, read: Read, pageSize: number][] = [
  ["the review list", list({}), CARD_SETTLEMENT_PAGE_SIZE],
  [
    "one statement's candidates",
    list({ statementKey: "statement-synthetic" }),
    CARD_SETTLEMENT_PAGE_SIZE,
  ],
  ["a review's competitors", list({ relatedTo: "cs-anchor" }), CARD_SETTLEMENT_PAGE_SIZE],
  [
    "the list grouped by statement",
    async (sql, grant, offset) =>
      asPage(
        await readCardSettlementStatementsForGrant({ grant, sql, request: { offset } }),
        (answer: { statements: unknown[] }) => answer.statements.length,
      ),
    CARD_SETTLEMENT_STATEMENT_PAGE_SIZE,
  ],
  [
    "the statements without a candidate",
    async (sql, grant, offset) => {
      const outcome = await reviewUnmatchedCardStatements({ grant, sql, request: { offset } });
      return outcome.ok
        ? {
            status: "ok",
            nextOffset: outcome.review.nextOffset,
            nextPage: (outcome.review as { nextPage?: unknown }).nextPage,
            length: outcome.review.items.length,
          }
        : {
            status: outcome.error.code === "budget_exceeded" ? "refused" : "not_found",
            nextOffset: null,
            nextPage: undefined,
            length: 0,
          };
    },
    UNMATCHED_PAGE_SIZE,
  ],
];

const MAX_ROWS = (size: number) => [size, size + 1, 2 * size - 1, 2 * size, 3 * size + 7, 1000];
const ROWS = (size: number) => [0, 1, size, size + 1, 2 * size, 2 * size + 1, 4 * size, 1101];

/** Every page a walk from offset 0 along the offered `nextOffset` reads. */
async function walk(read: Read, rows: number, maxRows: number): Promise<[number, Page][]> {
  const sql = store(rows);
  const pages: [number, Page][] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await read(sql, grant(maxRows), offset);
    pages.push([offset, page]);
    offset = page.status === "ok" ? page.nextOffset : null;
  }
  return pages;
}

describe.each(READS)("%s", (_name, read, size) => {
  test("never offers a page the same grant is refused", async () => {
    for (const maxRows of MAX_ROWS(size))
      for (const rows of ROWS(size)) {
        const pages = await walk(read, rows, maxRows);
        // Each page offered is served, never refused with `budget_exceeded`.
        expect(
          pages.map(([offset, page]) => ({ maxRows, rows, offset, status: page.status })),
        ).toEqual(pages.map(([offset]) => ({ maxRows, rows, offset, status: "ok" })));
        // The walk reads as deep as the budget allows, and no deeper.
        const read_ = pages.reduce((sum, [, page]) => sum + page.length, 0);
        expect({ maxRows, rows, read: read_ }).toEqual({
          maxRows,
          rows,
          read: Math.min(rows, Math.floor(maxRows / size) * size),
        });
      }
  });

  test("says why there is no next page: the last row, or rows the grant may not read", async () => {
    for (const maxRows of MAX_ROWS(size))
      for (const rows of ROWS(size)) {
        const pages = await walk(read, rows, maxRows);
        const [offset, last] = pages.at(-1)!;
        const more = pages.reduce((sum, [, page]) => sum + page.length, 0) < rows;
        expect(pages.slice(0, -1).map(([, page]) => page.nextPage)).toEqual(
          pages.slice(0, -1).map(() => "offered"),
        );
        expect({ maxRows, rows, offset, nextPage: last.nextPage }).toEqual({
          maxRows,
          rows,
          offset,
          nextPage: more ? "budget_exceeded" : "none",
        });
        // The page it does not name is the one the grant refuses.
        if (more)
          expect((await read(store(rows), grant(maxRows), offset + size)).status).toBe("refused");
      }
  });

  test("with the published budget, the last page offered is the last one served", async () => {
    const last = GRANT_LIMITS.maxRows - size; // 950 for 50 a page, 990 for 10
    const sql = store(1101);
    expect((await read(sql, grant(GRANT_LIMITS.maxRows), last - size)).nextOffset).toBe(last);
    const end = await read(sql, grant(GRANT_LIMITS.maxRows), last);
    expect([end.status, end.length, end.nextOffset]).toEqual(["ok", size, null]);
    expect((await read(sql, grant(GRANT_LIMITS.maxRows), last + size)).status).toBe("refused");
    expect(end.nextPage).toBe("budget_exceeded");
  });
});

test("one review read by its id offers no page", async () => {
  const outcome = await readCardSettlementsForGrant({
    grant: grant(1),
    sql: store(1),
    request: { proposalId: "cs-00000" },
  });
  expect(outcome).toMatchObject({ status: "ok", answer: { nextOffset: null, nextPage: "none" } });
});
