import { expect, test } from "bun:test";
import {
  readCardOwnershipForGrant,
  readCardSettlementStatementsForGrant,
  readCardSettlementsForGrant,
} from "../src/query/card-settlements-read.ts";
import { CARD_SETTLEMENT_STATEMENT_PAGE_SQL } from "../src/query/card-settlements.ts";
import type { Grant } from "../src/grants.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";

const GRANT: Grant = {
  principal: "synthetic-settlement-reader",
  capabilities: ["records.read"],
  scopes: { sources: "*", accounts: "*" },
  budget: { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 1 },
};
function forbiddenStore() {
  let reads = 0;
  const deny = async (): Promise<never> => {
    reads++;
    throw new Error("private database shape must not escape");
  };
  return { sql: { all: deny, first: deny } satisfies SqlExecutor, reads: () => reads };
}
function emptyStore() {
  const calls: unknown[][] = [];
  const all = async <T>(sql: string, binds: unknown[] = []): Promise<T[]> => {
    calls.push([sql, binds]);
    return [];
  };
  return { sql: { all, first: async () => null } as unknown as SqlExecutor, calls };
}

test("capability and both whole-store axes precede validation and every read", async () => {
  for (const [grant, code] of [
    [{ ...GRANT, capabilities: [] }, "unauthorized"],
    [{ ...GRANT, scopes: { sources: ["myjcb"], accounts: "*" } }, "evidence_restricted"],
    [{ ...GRANT, scopes: { sources: "*", accounts: ["synthetic"] } }, "evidence_restricted"],
  ] as const) {
    const store = forbiddenStore();
    for (const request of [{}, { offset: -1 }, "private probe"]) {
      const list = await readCardSettlementsForGrant({ grant, sql: store.sql, request });
      expect(list).toMatchObject({
        status: "refused",
        error: { code, requestId: "card-settlements.read" },
      });
      const statements = await readCardSettlementStatementsForGrant({
        grant,
        sql: store.sql,
        request,
      });
      expect(statements).toMatchObject({
        status: "refused",
        error: { code, requestId: "card-settlements.statements" },
      });
      const ownership = await readCardOwnershipForGrant({ grant, sql: store.sql, request });
      expect(ownership).toMatchObject({
        status: "refused",
        error: { code, requestId: "card-settlements.ownership" },
      });
    }
    expect(store.reads()).toBe(0);
  }
});

test("a closed request is required before reading", async () => {
  const store = forbiddenStore();
  for (const request of [
    [],
    "x",
    { offset: -1 },
    { offset: 1.5 },
    { offset: 1_000_001 },
    { offset: "0" },
    { proposalId: "/etc" },
    { proposalId: 1 },
    { proposalId: "a", offset: 0 },
    { source: "myjcb" },
    { statementKey: "" },
    { statementKey: "k".repeat(1025) },
    { statementKey: 1 },
    { statementKey: "k", proposalId: "a" },
    { relatedTo: "/etc" },
    { relatedTo: "a".repeat(129) },
    { relatedTo: 1 },
    { relatedTo: "a", proposalId: "a" },
    { relatedTo: "a", statementKey: "k" },
    { relatedTo: "a", offset: -1 },
  ])
    expect(await readCardSettlementsForGrant({ grant: GRANT, sql: store.sql, request })).toEqual({
      status: "refused",
      error: expect.objectContaining({ code: "invalid_query", refs: ["request"] }),
    });
  for (const request of [undefined, {}, { proposalId: "/etc" }, { proposalId: "a", offset: 0 }])
    expect(await readCardOwnershipForGrant({ grant: GRANT, sql: store.sql, request })).toEqual({
      status: "refused",
      error: expect.objectContaining({ code: "invalid_query", refs: ["proposalId"] }),
    });
  expect(store.reads()).toBe(0);
});

test("an empty page is an answer, a missing proposal is not found", async () => {
  const store = emptyStore();
  const page = await readCardSettlementsForGrant({ grant: GRANT, sql: store.sql, request: null });
  expect(page).toMatchObject({ status: "ok", answer: { items: [], nextOffset: null } });
  expect(store.calls[0]![1]).toEqual([null, 51, 0]);
  expect(
    await readCardSettlementsForGrant({
      grant: GRANT,
      sql: store.sql,
      request: { proposalId: "missing" },
    }),
  ).toEqual({ status: "not_found" });
  expect(store.calls[1]![1]).toEqual(["missing", 51, 0]);
  expect(
    await readCardOwnershipForGrant({
      grant: GRANT,
      sql: store.sql,
      request: { proposalId: "missing" },
    }),
  ).toEqual({ status: "not_found" });
});

test("the grant's maxRows bounds the page depth before any read", async () => {
  const store = forbiddenStore();
  const grant = { ...GRANT, budget: { ...GRANT.budget, maxRows: 99 } };
  for (const request of [{ offset: 50 }, { offset: 1_000_000 }])
    expect(await readCardSettlementsForGrant({ grant, sql: store.sql, request })).toEqual({
      status: "refused",
      error: expect.objectContaining({ code: "budget_exceeded", refs: ["budget:maxRows=99"] }),
    });
  expect(store.reads()).toBe(0);
  const one = emptyStore();
  expect(
    await readCardSettlementsForGrant({
      grant: { ...GRANT, budget: { ...GRANT.budget, maxRows: 1 } },
      sql: one.sql,
      request: { proposalId: "missing" },
    }),
  ).toEqual({ status: "not_found" });
});

test("one statement's candidates and a review's competitors read the pages' services", async () => {
  const store = emptyStore();
  expect(
    await readCardSettlementsForGrant({
      grant: GRANT,
      sql: store.sql,
      request: { statementKey: "statement-synthetic", offset: 50 },
    }),
  ).toMatchObject({ status: "ok", answer: { items: [], nextOffset: null } });
  expect(store.calls[0]![1]).toEqual(["statement-synthetic", 51, 50]);
  // A missing anchor is not found, read by its key before any page.
  const first: unknown[][] = [];
  const missing = {
    all: async () => {
      throw new Error("no page without an anchor");
    },
    first: async (sql: string, binds: unknown[] = []) => {
      first.push([sql, binds]);
      return null;
    },
  } as unknown as SqlExecutor;
  expect(
    await readCardSettlementsForGrant({
      grant: GRANT,
      sql: missing,
      request: { relatedTo: "missing" },
    }),
  ).toEqual({ status: "not_found" });
  expect(first).toEqual([[expect.stringContaining("WHERE id=?1"), ["missing"]]]);
  const present = emptyStore();
  const anchored = { ...present.sql, first: async () => ({ present: 1 }) } as SqlExecutor;
  expect(
    await readCardSettlementsForGrant({
      grant: GRANT,
      sql: anchored,
      request: { relatedTo: "anchor", offset: 50 },
    }),
  ).toMatchObject({ status: "ok", answer: { items: [], nextOffset: null } });
  expect(present.calls[0]![0]).toContain("related_review");
  expect(present.calls[0]![1]).toEqual(["anchor", 51, 50]);
});

test("a statement's or a review's competitors page only as deep as maxRows", async () => {
  const store = forbiddenStore();
  const grant = { ...GRANT, budget: { ...GRANT.budget, maxRows: 99 } };
  for (const request of [
    { statementKey: "k", offset: 50 },
    { relatedTo: "a", offset: 50 },
  ])
    expect(await readCardSettlementsForGrant({ grant, sql: store.sql, request })).toEqual({
      status: "refused",
      error: expect.objectContaining({ code: "budget_exceeded", refs: ["budget:maxRows=99"] }),
    });
  expect(store.reads()).toBe(0);
});

test("the grouped list takes offset alone, an integer from 0 to 1,000,000", async () => {
  const store = forbiddenStore();
  for (const request of [
    [],
    "x",
    0,
    { offset: null },
    { offset: -1 },
    { offset: 1.5 },
    { offset: 1_000_001 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { offset: "0" },
    { offset: 0, proposalId: "a" },
    { statementKey: "k" },
    { relatedTo: "a" },
    { source: "myjcb" },
  ])
    expect(
      await readCardSettlementStatementsForGrant({ grant: GRANT, sql: store.sql, request }),
    ).toEqual({
      status: "refused",
      error: expect.objectContaining({
        code: "invalid_query",
        requestId: "card-settlements.statements",
        refs: ["request"],
      }),
    });
  expect(store.reads()).toBe(0);
});

test("the grouped list reads the page's own query, and an empty page is an answer", async () => {
  for (const [request, offset] of [
    [undefined, 0],
    [null, 0],
    [{}, 0],
    [{ offset: 90 }, 90],
  ] as const) {
    const store = emptyStore();
    expect(
      await readCardSettlementStatementsForGrant({ grant: GRANT, sql: store.sql, request }),
    ).toMatchObject({ status: "ok", answer: { statements: [], nextOffset: null } });
    // The statement page only: no statement, so no candidate is judged.
    expect(store.calls).toEqual([[CARD_SETTLEMENT_STATEMENT_PAGE_SQL, [11, offset]]]);
  }
});

test("the grouped list pages only as deep as maxRows, counted in statements", async () => {
  const store = forbiddenStore();
  for (const request of [{ offset: 91 }, { offset: 1_000_000 }])
    expect(
      await readCardSettlementStatementsForGrant({ grant: GRANT, sql: store.sql, request }),
    ).toEqual({
      status: "refused",
      error: expect.objectContaining({
        code: "budget_exceeded",
        requestId: "card-settlements.statements",
        refs: ["budget:maxRows=100"],
      }),
    });
  expect(store.reads()).toBe(0);
});
