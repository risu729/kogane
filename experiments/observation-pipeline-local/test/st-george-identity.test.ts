import { afterEach, expect, test } from "bun:test";
import { stGeorgeTransactions } from "../../../packages/parsers/src/parsers/st-george.ts";
import { currentTransactions } from "../src/queries.ts";
import { closeStores, database, snapshot } from "./snapshot-fixture.ts";

afterEach(closeStores);

test("repeated St.George snapshots deduplicate without collapsing identical rows within a capture", () => {
  const row = {
    dateText: "12/09/2026",
    description: "Synthetic transaction",
    category: "",
    debitText: "1.00",
    creditText: "",
    balanceText: "99.00",
  };
  const input = {
    schema: "st-george-browser-v1",
    observedAt: "2026-09-13T00:00:00Z",
    currency: "AUD",
    currencyEvidence: "source-configured",
    accounts: [
      {
        accountKey: "a".repeat(64),
        label: "Synthetic",
        currentBalanceText: "99.00",
        availableBalanceText: "99.00",
        openingBalanceText: null,
        closingBalanceText: null,
        historyState: "observed",
        pendingState: "unknown",
        transactions: [row, { ...row }],
      },
    ],
  };
  const parsed = stGeorgeTransactions.parse(new TextEncoder().encode(JSON.stringify(input)), {
    id: 1,
    sourceId: "st-george",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "account-snapshot",
    artifactKey: "account-snapshot.json",
    url: null,
    mime: "application/json",
    fetchedAt: input.observedAt,
    sha256: "0".repeat(64),
  });
  const store = database();
  const options = {
    source: "st-george",
    parser: stGeorgeTransactions.name,
    parserVersion: stGeorgeTransactions.version,
    dataset: "account-snapshot",
    observations: parsed.observations,
    coverage: parsed.coverage![0]!,
  };
  snapshot(store, { ...options, time: "2026-09-13T00:00:00Z" });
  expect(currentTransactions(store)).toHaveLength(2);
  snapshot(store, { ...options, time: "2026-09-13T01:00:00Z" });
  expect(currentTransactions(store)).toHaveLength(2);
  const rows = currentTransactions(store);
  expect(new Set(rows.map((entry) => entry.external_id)).size).toBe(2);
});
