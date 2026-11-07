// `readEconomicEvents` and its grant rule (plan D19): the request rules both
// `GET /api/v2/activity`/`/api/v2/obligations` and `kogane.events.read` use.
// The read itself is the read model's (packages/read-model/test/events.test.ts);
// here an empty store proves which requests reach it. Every value is invented.
import { expect, test } from "bun:test";
import {
  economicEventsGrantRefusal,
  readEconomicEvents,
} from "../src/query/economic-events-read.ts";
import type { Grant } from "../src/grants.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";

const GRANT: Grant = {
  principal: "synthetic-events-reader",
  capabilities: ["records.read"],
  scopes: { sources: "*", accounts: "*" },
  budget: { maxRows: 100, maxProposalTargets: 1, maxExplainDepth: 1 },
};

function emptyStore() {
  const statements: { sql: string; args: readonly unknown[] }[] = [];
  const sql: SqlExecutor = {
    all: async <T>(text: string, args: readonly unknown[]): Promise<T[]> => {
      statements.push({ sql: text, args });
      return [];
    },
    first: async <T>(text: string, args: readonly unknown[]): Promise<T | null> => {
      statements.push({ sql: text, args });
      return null;
    },
  };
  return { sql, statements };
}

test("a valid request reads one page and keeps its basis", async () => {
  for (const [list, query, basis] of [
    ["activity", "", "cash-movement"],
    ["activity", "basis=purchase-recognition&offset=200", "purchase-recognition"],
    ["obligations", "offset=1000000", undefined],
  ] as const) {
    const store = emptyStore();
    const outcome = await readEconomicEvents(store.sql, list, new URLSearchParams(query));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) continue;
    expect(outcome.body.apiVersion).toBe(2);
    expect("basis" in outcome.body ? outcome.body.basis : undefined).toBe(basis);
    expect(outcome.body.items).toEqual([]);
    expect(outcome.body.nextCursor).toBeNull();
    expect(store.statements.length).toBeGreaterThan(0);
  }
});

test("an invalid request is refused with the routes' code before any read", async () => {
  for (const [list, query, refusal] of [
    ["activity", "basis=tax", "invalid_query"],
    ["activity", "basis=", "invalid_query"],
    ["activity", "basis=cash-movement&basis=cash-movement", "invalid_query"],
    ["activity", `basis=${"x".repeat(65)}`, "invalid_query"],
    ["activity", "cursor=200", "invalid_query"],
    ["obligations", "basis=cash-movement", "invalid_query"],
    ["activity", "offset=-1", "invalid_offset"],
    ["activity", "offset=01", "invalid_offset"],
    ["activity", "offset=1.5", "invalid_offset"],
    ["obligations", "offset=1000001", "invalid_offset"],
    ["obligations", "offset=1e3", "invalid_offset"],
  ] as const) {
    const store = emptyStore();
    expect(await readEconomicEvents(store.sql, list, new URLSearchParams(query)), query).toEqual({
      ok: false,
      refusal,
    });
    expect(store.statements, query).toEqual([]);
  }
});

test("only records.read over the whole store may read", () => {
  expect(economicEventsGrantRefusal(GRANT)).toBeNull();
  expect(economicEventsGrantRefusal({ ...GRANT, capabilities: ["summary.read"] })).toMatchObject({
    code: "unauthorized",
    requestId: "events.read",
    refs: ["capability:records.read"],
  });
  expect(
    economicEventsGrantRefusal({
      ...GRANT,
      scopes: { sources: ["synthetic-source"], accounts: ["synthetic-account"] },
    }),
  ).toMatchObject({
    code: "evidence_restricted",
    requestId: "events.read",
    refs: ["scope:source", "scope:account"],
  });
});
