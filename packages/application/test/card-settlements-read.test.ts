import { expect, test } from "bun:test";
import {
  readCardOwnershipForGrant,
  readCardSettlementsForGrant,
} from "../src/query/card-settlements-read.ts";
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
