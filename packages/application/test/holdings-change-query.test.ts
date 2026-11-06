// `queryHoldingsChange` (src/query/holdings-change.ts; ADR 0075) end to end
// over the migrated CORE schema: synthetic container captures with identities
// (packages/read-model/test/dated-state-fixture.ts) on two dates. Every
// account, code, quantity and time is invented.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  HOLDINGS_CHANGE_SIDE_BOUND,
  type HoldingChange,
} from "../../domain/src/holdings-change.ts";
import { decimalToString, type Quantity } from "../../domain/src/values.ts";
import { DATED_POSITIONS_SQL } from "../../read-model/src/dated-state.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import {
  HoldingsChangeError,
  queryHoldingsChange,
  type HoldingsChangeRequest,
} from "../src/query/holdings-change.ts";

function recording(store: DatedStore): SqlExecutor & { statements: string[] } {
  const sql = {
    statements: [] as string[],
    all: async <T>(text: string, args: readonly unknown[]) => {
      sql.statements.push(text);
      return store.db.query(text).all(...(args as SQLQueryBindings[])) as T[];
    },
    first: async <T>(text: string, args: readonly unknown[]) => {
      sql.statements.push(text);
      return (store.db.query(text).get(...(args as SQLQueryBindings[])) as T | null) ?? null;
    },
  };
  return sql;
}

const DOMESTIC = {
  source: "sbi-securities",
  dataset: "domestic-cash-positions",
  parser: "sbi-domestic-cash-positions",
} as const;
const FOREIGN = {
  source: "sbi-securities",
  dataset: "foreign-cash-positions",
  parser: "sbi-foreign-cash-positions",
  version: "0.3.0",
} as const;
const REQUEST: HoldingsChangeRequest = {
  from: "2026-09-01",
  to: "2026-09-10",
  today: "2026-09-12",
};

const text = (quantity: Quantity | null): string | null =>
  quantity === null || quantity.value.status !== "exact"
    ? null
    : decimalToString(quantity.value.value);
const byCode = (holdings: HoldingChange[], code: string): HoldingChange => {
  const found = holdings.find((entry) => entry.key.securityCode === code);
  if (found === undefined) throw new Error(`no holding ${code}`);
  return found;
};

/** Two dates of the domestic container, the foreign one captured only by the end. */
function world(): DatedStore {
  const store = new DatedStore();
  const start = store.capture({
    ...DOMESTIC,
    fetchedAt: "2026-08-31T23:30:00Z",
    positions: [
      { account: "sbi-a", code: "1001", quantity: "10" },
      { account: "sbi-a", code: "1002", quantity: "3" },
      { account: "sbi-a", code: "1004", quantity: "7" },
    ],
  });
  store.identify(start, "sbi-securities", "acct-sbi", "identified", ["inst-1001"]);
  const end = store.capture({
    ...DOMESTIC,
    fetchedAt: "2026-09-09T23:30:00Z",
    positions: [
      { account: "sbi-a", code: "1001", quantity: "12.5" },
      { account: "sbi-a", code: "1003", quantity: "0.25" },
      { account: "sbi-a", code: "1004", quantity: "unreadable" },
    ],
  });
  // The end capture's identity is not recorded yet: its holdings are still listed.
  void end;
  store.capture({
    ...FOREIGN,
    fetchedAt: "2026-09-05T01:00:00Z",
    positions: [{ account: "sbi-a", code: "VTX", quantity: "2.5", currency: "USD" }],
  });
  return store;
}

describe("queryHoldingsChange", () => {
  test("per provider key: the exact change, holdings on one date only, and missing captures as reasons", async () => {
    const store = world();
    const sql = recording(store);
    const result = await queryHoldingsChange(sql, REQUEST);
    expect(result).toMatchObject({
      schemaVersion: "reported-holdings-change-v1",
      policy: "holdings-change-v1",
      from: "2026-09-01",
      to: "2026-09-10",
      quantityPolicy: "decimal-v1",
      filters: { source: null, account: null },
    });
    const grown = byCode(result.holdings, "1001");
    expect(grown).toMatchObject({
      status: "compared",
      unitRef: "instrument:sbi-securities:-:1001",
      start: { state: "listed", accountId: "acct-sbi", quantityText: "10" },
      end: { state: "listed", accountId: null, accountIdentity: "not-recorded" },
    });
    expect(text(grown.change)).toBe("2.5");
    expect(byCode(result.holdings, "1002")).toMatchObject({
      status: "listed_at_start_only",
      change: null,
      end: { state: "not_listed" },
    });
    expect(byCode(result.holdings, "1003")).toMatchObject({
      status: "listed_at_end_only",
      change: null,
      start: { state: "not_listed" },
    });
    expect(byCode(result.holdings, "1004")).toMatchObject({
      status: "not_comparable",
      reasons: ["quantity_not_exact_at_end"],
      end: { state: "listed", quantity: { value: { status: "unparsed" } } },
      change: null,
    });
    expect(byCode(result.holdings, "VTX")).toMatchObject({
      status: "not_comparable",
      reasons: ["no_snapshot_at_start"],
      start: { state: "no_snapshot" },
      change: null,
    });
    expect(result.counts).toEqual({
      compared: 1,
      listed_at_start_only: 1,
      listed_at_end_only: 1,
      not_comparable: 2,
    });
    expect(result.coverage.containersWithoutSnapshot).toContainEqual({
      side: "start",
      sourceId: "sbi-securities",
      parserName: "sbi-foreign-cash-positions",
      dataset: "foreign-cash-positions",
    });
    // The end date's foreign capture is five days old: stale, still compared by capture.
    expect(result.coverage.staleSnapshots.map((entry) => [entry.side, entry.parserName])).toEqual([
      ["end", "sbi-foreign-cash-positions"],
    ]);
    expect(result.coverage.total).toBe("not-computed");
    // Reads only, and a bounded number of statements.
    expect(sql.statements.every((statement) => /^\s*(SELECT|WITH)\b/u.test(statement))).toBe(true);
    expect(sql.statements.length).toBeLessThanOrEqual(12);
    // The same store and request give the same context.
    expect((await queryHoldingsChange(recording(store), REQUEST)).contextId).toBe(result.contextId);
  });

  test("the account filter keeps holdings either date names for it, judged on the whole listing", async () => {
    const store = world();
    const result = await queryHoldingsChange(recording(store), { ...REQUEST, account: "acct-sbi" });
    expect(result.filters).toEqual({ source: null, account: "acct-sbi" });
    // Only the start capture is identified: its keys are kept, the end-only ones are not.
    expect(result.holdings.map((entry) => [entry.key.securityCode, entry.status])).toEqual([
      ["1001", "compared"],
      ["1002", "listed_at_start_only"],
      ["1004", "not_comparable"],
    ]);
    store.db.run("INSERT INTO sources(id,provider) VALUES('sbi-securities','synthetic')");
    const narrowed = await queryHoldingsChange(recording(store), {
      ...REQUEST,
      source: "sbi-securities",
    });
    expect(narrowed.holdings).toHaveLength(5);
    expect(narrowed.contextId).not.toBe(result.contextId);
  });

  test("no capture between the dates leaves every change unobserved", async () => {
    const store = new DatedStore();
    store.capture({
      ...DOMESTIC,
      fetchedAt: "2026-08-31T23:30:00Z",
      positions: [{ account: "sbi-a", code: "1001", quantity: "10" }],
    });
    const result = await queryHoldingsChange(recording(store), REQUEST);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      status: "not_comparable",
      reasons: ["same_capture_both_dates"],
      change: null,
    });
  });

  test("captures of separate fetch units are compared unit by unit", async () => {
    const store = new DatedStore();
    store.capture({
      ...DOMESTIC,
      fetchedAt: "2026-08-31T23:30:00Z",
      unitKey: "unit-a",
      positions: [{ account: "sbi-a", code: "1001", quantity: "10" }],
    });
    store.capture({
      ...DOMESTIC,
      fetchedAt: "2026-08-31T23:40:00Z",
      unitKey: "unit-b",
      positions: [{ account: "sbi-b", code: "2001", quantity: "4" }],
    });
    // Only unit b is captured again by the end date, without its holding.
    store.capture({
      ...DOMESTIC,
      fetchedAt: "2026-09-09T23:40:00Z",
      unitKey: "unit-b",
      positions: [],
    });
    const result = await queryHoldingsChange(recording(store), REQUEST);
    expect(
      result.holdings.map((entry) => [entry.key.sourceAccount, entry.status, entry.reasons]),
    ).toEqual([
      ["sbi-a", "not_comparable", ["same_capture_both_dates"]],
      ["sbi-b", "listed_at_start_only", []],
    ]);
  });

  test("refusals are closed codes, decided before reading what they guard", async () => {
    const store = world();
    const refusal = async (request: HoldingsChangeRequest) => {
      const sql = recording(store);
      try {
        await queryHoldingsChange(sql, request);
      } catch (error) {
        if (error instanceof HoldingsChangeError) return [error.code, sql.statements.length];
        throw error;
      }
      throw new Error("expected a refusal");
    };
    expect(await refusal({ ...REQUEST, from: "2026-02-30" })).toEqual(["invalid_request", 0]);
    expect(await refusal({ ...REQUEST, today: "today" })).toEqual(["invalid_request", 0]);
    expect(await refusal({ ...REQUEST, account: "" })).toEqual(["invalid_request", 0]);
    expect(await refusal({ ...REQUEST, from: "2026-09-10" })).toEqual(["invalid_range", 0]);
    expect(await refusal({ ...REQUEST, from: "2026-09-11" })).toEqual(["invalid_range", 0]);
    expect(await refusal({ ...REQUEST, to: "2026-09-13" })).toEqual(["date_in_future", 0]);
    expect(await refusal({ ...REQUEST, source: "no-such-source" })).toEqual(["unknown_source", 1]);
    expect(await refusal({ ...REQUEST, account: "acct-none" })).toEqual(["unknown_account", 1]);
  });

  test("more holdings than the bound on a date is refused, never cut", async () => {
    const store = new DatedStore();
    store.capture({
      ...DOMESTIC,
      fetchedAt: "2026-09-09T23:30:00Z",
      positions: Array.from({ length: HOLDINGS_CHANGE_SIDE_BOUND + 1 }, (_, index) => ({
        account: "sbi-a",
        code: `C${index}`,
        quantity: "1",
      })),
    });
    await expect(queryHoldingsChange(recording(store), REQUEST)).rejects.toMatchObject({
      code: "holding_limit_exceeded",
    });
  });

  test("a reported state past its row bound is refused, never cut", async () => {
    const store = world();
    const inner = recording(store);
    const overfull: SqlExecutor = {
      ...inner,
      all: async <T>(sql: string, args: readonly unknown[]) =>
        sql === DATED_POSITIONS_SQL
          ? (Array.from({ length: 5001 }, () => ({})) as T[])
          : inner.all<T>(sql, args),
    };
    await expect(queryHoldingsChange(overfull, REQUEST)).rejects.toMatchObject({
      code: "dated_state_limit_exceeded",
    });
  });
});
