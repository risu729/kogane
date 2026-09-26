// A small synthetic world for the reported state's wire contract and page
// tests: the answers are produced by `queryDatedState` itself over
// packages/read-model/test/dated-state-fixture.ts, so the client is tested
// against what the server really says. Every account, code and amount is
// invented.
import type { SQLQueryBindings } from "bun:sqlite";
import type { ReportedState } from "../../domain/src/reported-state.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import { queryDatedState } from "../src/query/dated-state.ts";

export function reportedStateWorld(): DatedStore {
  const store = new DatedStore();
  const domestic = store.capture({
    source: "sbi-securities",
    dataset: "domestic-cash-positions",
    parser: "sbi-domestic-cash-positions",
    fetchedAt: "2026-09-09T23:30:00Z",
    positions: [{ account: "sbi-a", code: "1001", quantity: "10", value: 12_000 }],
  });
  store.identify(domestic, "sbi-securities", "acct-sbi", "identified", ["inst-1001"]);
  store.capture({
    source: "sbi-securities",
    dataset: "foreign-cash-positions",
    parser: "sbi-foreign-cash-positions",
    version: "0.3.0",
    fetchedAt: "2026-09-05T01:00:00Z",
    positions: [{ account: "sbi-a", code: "VTX", quantity: "2.5", value: 15_025, currency: "USD" }],
  });
  store.capture({
    source: "smbc-bank",
    dataset: "balance-normalized",
    parser: "smbc-direct-balance",
    fetchedAt: "2026-09-08T02:00:00Z",
    balances: [
      { account: "smbc-a", metric: "account_balance", instrument: "JPY", minor: 50_000 },
      { account: "smbc-b", metric: "account_balance", instrument: "JPY", minor: null },
    ],
  });
  const september = store.statement({
    card: "card-a",
    period: "2026-09",
    paymentDate: "2026-09-26",
    minor: 30_000,
    fetchedAt: "2026-09-05T01:00:00Z",
  });
  store.identify(september, "vpass", "acct-card", "identified");
  store.settle(september, {
    account: "acct-card",
    period: "2026-09",
    debitDate: "2026-09-26",
    decision: "accepted",
  });
  const august = store.statement({
    card: "card-b",
    period: "2026-09",
    paymentDate: "2026-09-08",
    minor: 8_000,
    fetchedAt: "2026-09-02T01:00:00Z",
  });
  store.identify(august, "vpass", "acct-card-b", "identified");
  store.statement({
    card: "card-c",
    period: "2026-09",
    paymentDate: null,
    minor: 1_000,
    fetchedAt: "2026-09-03T01:00:00Z",
  });
  return store;
}

export function worldExecutor(store: DatedStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

/** The API body for `date`, as `GET /api/v2/reported-state` returns it. */
export async function reportedStateBody(
  store: DatedStore,
  date: string,
): Promise<ReportedState & { apiVersion: 2 }> {
  return { apiVersion: 2, ...(await queryDatedState(worldExecutor(store), { date })) };
}
