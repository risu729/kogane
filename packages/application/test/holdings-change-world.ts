// A small synthetic world for the reported holdings change's wire contract
// and page tests: the answers are produced by `queryHoldingsChange` itself
// over packages/read-model/test/dated-state-fixture.ts, so the client is
// tested against what the server really says. Every account, code and
// quantity is invented.
import type { HoldingsChange } from "../../domain/src/holdings-change.ts";
import { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import { queryHoldingsChange } from "../src/query/holdings-change.ts";
import { worldExecutor } from "./reported-state-world.ts";

const DOMESTIC = {
  source: "sbi-securities",
  dataset: "domestic-cash-positions",
  parser: "sbi-domestic-cash-positions",
} as const;

/**
 * From 2026-09-01 to 2026-09-10: a grown, an unchanged and a reduced holding,
 * one listed only at the start, one only at the end, one whose end quantity is
 * unreadable, and a foreign holding whose container was first captured after
 * the start (and is stale by the end).
 */
export function holdingsChangeWorld(): DatedStore {
  const store = new DatedStore();
  const start = store.capture({
    ...DOMESTIC,
    fetchedAt: "2026-08-31T23:30:00Z",
    positions: [
      { account: "sbi-a", code: "1001", quantity: "10" },
      { account: "sbi-a", code: "1002", quantity: "3" },
      { account: "sbi-a", code: "1004", quantity: "7" },
      { account: "sbi-a", code: "1005", quantity: "4" },
      { account: "sbi-a", code: "1006", quantity: "5" },
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
      { account: "sbi-a", code: "1005", quantity: "4" },
      { account: "sbi-a", code: "1006", quantity: "1.5" },
    ],
  });
  store.identify(end, "sbi-securities", "acct-sbi", "identified", ["inst-1001"]);
  store.capture({
    source: "sbi-securities",
    dataset: "foreign-cash-positions",
    parser: "sbi-foreign-cash-positions",
    version: "0.3.0",
    fetchedAt: "2026-09-05T01:00:00Z",
    positions: [{ account: "sbi-a", code: "VTX", quantity: "2.5", currency: "USD" }],
  });
  return store;
}

/** The API body, as `GET /api/v2/reported-holdings-change` returns it. */
export async function holdingsChangeBody(
  store: DatedStore,
  request: { from: string; to: string; today?: string; source?: string; account?: string },
): Promise<HoldingsChange & { apiVersion: 2 }> {
  return {
    apiVersion: 2,
    ...(await queryHoldingsChange(worldExecutor(store), {
      today: "2026-09-12",
      ...request,
    })),
  };
}
