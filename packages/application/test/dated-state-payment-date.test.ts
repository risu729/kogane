// A statement whose due date has the `YYYY-MM-DD` shape but names no day
// (2026-02-30) in `queryDatedState` (src/query/dated-state.ts): it has no
// readable due date, so the payable window places it by its capture time, as
// a statement without one, and a listed one stands as `payment_date_unknown`
// (INV05), never due before the window by its text. Every card and amount is
// invented.
import type { SQLQueryBindings } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import { queryDatedState } from "../src/query/dated-state.ts";

function executor(store: DatedStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

test("an impossible due date is an undated statement: listed as unknown when recent, counted as undated when old", async () => {
  const store = new DatedStore();
  // Captured recently: its text sorts before the window (2026-08-10), but it
  // is no date, so it is listed by its capture time with an unknown status.
  store.statement({
    card: "card-a",
    period: "2026-02",
    paymentDate: "2026-02-30",
    minor: 1_000,
    fetchedAt: "2026-09-05T01:00:00Z",
  });
  // Captured before the 45-day bound: its text sorts inside the window, but
  // it is no date, so it is counted as undated and captured before the bound.
  store.statement({
    card: "card-b",
    period: "2026-09",
    paymentDate: "2026-09-31",
    minor: 2_000,
    fetchedAt: "2026-06-05T01:00:00Z",
  });
  // A real due date before the window, for contrast.
  store.statement({
    card: "card-c",
    period: "2026-06",
    paymentDate: "2026-06-30",
    minor: 3_000,
    fetchedAt: "2026-09-05T01:00:00Z",
  });
  const state = await queryDatedState(executor(store), { date: "2026-09-10" });
  expect(state.coverage.payablesFromPaymentDate).toBe("2026-08-10");
  expect(state.payables.map((p) => [p.sourceAccount, p.paymentDate, p.status])).toEqual([
    ["card-a", "2026-02-30", "payment_date_unknown"],
  ]);
  expect(state.coverage.statementsBeforeWindow).toEqual([
    { sourceId: "vpass", reasonCode: "due_before_window", count: 1 },
    { sourceId: "vpass", reasonCode: "undated_captured_before_window", count: 1 },
  ]);
});
