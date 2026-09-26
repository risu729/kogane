// `queryDatedState` (src/query/dated-state.ts) over the synthetic dated store
// (packages/read-model/test/dated-state-fixture.ts): accounts with their
// snapshots' freshness, provider figures beside each other and never added,
// payables and where each stands on the date, and the coverage that names what
// is not shown. Every account, code and amount is invented.
import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { payableStatus, snapshotFreshness } from "../../domain/src/reported-state.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import { DatedStateLimitError, queryDatedState } from "../src/query/dated-state.ts";

function executor(store: DatedStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

const SBI = {
  source: "sbi-securities",
  dataset: "domestic-cash-positions",
  parser: "sbi-domestic-cash-positions",
} as const;
const SMBC = { source: "smbc-bank", dataset: "balance-normalized", parser: "smbc-direct-balance" };
const SHINSEI = {
  source: "sbi-shinsei-bank",
  dataset: "top-accounts-balance-and-activity",
  parser: "sbi-shinsei-top-balances-and-activity",
};

/** Three containers captured on different days, one with an unreadable value. */
function holdings(): DatedStore {
  const store = new DatedStore();
  const sbi = store.capture({
    ...SBI,
    fetchedAt: "2026-09-06T01:00:00Z",
    positions: [
      { account: "sbi-a", code: "1001", quantity: "10", value: 12_000 },
      { account: "sbi-a", code: "2002", quantity: "0.5" },
    ],
  });
  store.identify(sbi, SBI.source, "acct-sbi", "identified", ["inst-1001"]);
  store.capture({
    ...SMBC,
    fetchedAt: "2026-09-10T02:00:00Z",
    balances: [
      { account: "smbc-a", metric: "account_balance", instrument: "JPY", minor: 50_000 },
      { account: "smbc-b", metric: "account_balance", instrument: "JPY", minor: null },
    ],
  });
  store.capture({
    ...SHINSEI,
    fetchedAt: "2026-09-08T02:00:00Z",
    balances: [
      { account: "shinsei-a", metric: "account_balance", instrument: "JPY", minor: 7_000 },
      { account: "shinsei-a", metric: "activity_current_balance", instrument: "JPY", minor: 7_000 },
    ],
  });
  return store;
}

describe("accounts and their snapshots", () => {
  test("freshness under dated-state-freshness-v1", () => {
    expect(snapshotFreshness("2026-09-10T14:59:59.000Z", "2026-09-10")).toEqual({
      captureDate: "2026-09-10",
      ageDays: 0,
      freshness: "same-day",
    });
    // 00:30 on 9/10 in Tokyo is still 9/9 in UTC.
    expect(snapshotFreshness("2026-09-09T15:30:00.000Z", "2026-09-10").freshness).toBe("same-day");
    expect(snapshotFreshness("2026-09-07T01:00:00.000Z", "2026-09-10")).toMatchObject({
      ageDays: 3,
      freshness: "recent",
    });
    expect(snapshotFreshness("2026-09-06T01:00:00.000Z", "2026-09-10")).toMatchObject({
      ageDays: 4,
      freshness: "stale",
    });
  });

  test("each account lists its snapshot, positions with provider valuations, and balances", async () => {
    const state = await queryDatedState(executor(holdings()), { date: "2026-09-10" });
    expect(state.cutoff).toBe("2026-09-10T15:00:00.000Z");
    expect(state.accounts.map((a) => [a.sourceId, a.sourceAccount, a.accountId])).toEqual([
      ["sbi-securities", "sbi-a", "acct-sbi"],
      ["sbi-shinsei-bank", "shinsei-a", null],
      ["smbc-bank", "smbc-a", null],
      ["smbc-bank", "smbc-b", null],
    ]);
    const sbi = state.accounts[0]!;
    expect(sbi.identityStatus).toBe("identified");
    expect(sbi.snapshots.map((s) => [s.sourceId, s.ageDays, s.freshness])).toEqual([
      ["sbi-securities", 4, "stale"],
    ]);
    expect(
      sbi.positions.map((p) => [p.securityCode, p.quantityText, p.instrument, p.valuations]),
    ).toEqual([
      [
        "1001",
        "10",
        { instrumentId: "inst-1001", status: "identified" },
        [
          {
            ref: expect.stringMatching(/^valuation:[0-9]+$/u),
            metric: "evaluation_amount",
            amount: {
              unitRef: "JPY",
              value: {
                status: "exact",
                value: { coefficient: "12000", scale: 0 },
                normalizationVersion: "decimal-v1",
              },
            },
            providerText: "12000",
            asOf: null,
          },
        ],
      ],
      ["2002", "0.5", { instrumentId: null, status: "unresolved" }, []],
    ]);
    const smbc = state.accounts[2]!;
    expect(smbc.identityStatus).toBe("not-recorded");
    expect(smbc.snapshots[0]!.freshness).toBe("same-day");
    expect(smbc.balances[0]!.metric).toMatchObject({
      metricId: "deposit.balance",
      aggregationRule: "sum-disjoint",
      overlapGroup: null,
    });
    expect(smbc.balances[0]!.instrument).toEqual({ instrumentId: null, status: "not-recorded" });
  });

  test("a value the provider row did not give stays missing, never zero", async () => {
    const state = await queryDatedState(executor(holdings()), { date: "2026-09-10" });
    const unreadable = state.accounts.find((a) => a.sourceAccount === "smbc-b")!.balances[0]!;
    expect(unreadable.amount).toEqual({
      unitRef: "JPY",
      value: { status: "unparsed", reasonCode: "stored:unparsed" },
    });
  });

  test("a balance restated after each transaction is counted apart, not listed", async () => {
    const state = await queryDatedState(executor(holdings()), { date: "2026-09-10" });
    const shinsei = state.accounts.find((a) => a.sourceId === "sbi-shinsei-bank")!;
    expect(shinsei.balances.map((b) => b.providerMetric)).toEqual(["account_balance"]);
    expect(state.coverage.excludedRows).toEqual([
      { reasonCode: "balance_after_transaction", count: 1 },
    ]);
  });

  test("nothing is added: no total, subtotal or net worth anywhere in the answer", async () => {
    const state = await queryDatedState(executor(holdings()), { date: "2026-09-10" });
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object")
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
    };
    walk(state);
    for (const key of keys) expect(key).not.toMatch(/total|sum|netWorth/iu);
    expect(state.coverage.netAssets).toBe("not-computed");
  });
});

describe("coverage", () => {
  test("containers without a snapshot, stale snapshots, the perimeter and liabilities", async () => {
    const state = await queryDatedState(executor(holdings()), { date: "2026-09-10" });
    const missing = state.coverage.containersWithoutSnapshot.map((c) => c.parserName);
    expect(missing).toContain("mizuho-account-list");
    expect(missing).toContain("st-george-balances");
    expect(missing).not.toContain("smbc-direct-balance");
    // Aggregates are excluded from the perimeter, not missing from it.
    expect(missing).not.toContain("sony-bank-gross-balance");
    expect(missing).not.toContain("sbi-account-assets-current");
    expect(state.coverage.staleSnapshots).toEqual([
      {
        ref: state.accounts[0]!.snapshots[0]!.ref,
        sourceId: "sbi-securities",
        parserName: SBI.parser,
        ageDays: 4,
      },
    ]);
    expect(state.coverage.excluded.map((e) => e.scope)).toContain("source:moneyforward");
    expect(state.coverage.liabilitiesCoverage).toBe("partial");
    expect(state.coverage.liabilitiesMissing).toContain("unbilled_card_usage");
    expect(state.coverage.payablesFromPaymentDate).toBe("2026-08-10");
  });

  test("a date before every capture lists no account and names every container", async () => {
    const state = await queryDatedState(executor(holdings()), { date: "2026-09-01" });
    expect(state.accounts).toEqual([]);
    expect(state.snapshots).toEqual([]);
    expect(state.coverage.containersWithoutSnapshot.map((c) => c.parserName)).toContain(SBI.parser);
  });

  test("a complete-empty snapshot is a snapshot with nothing held", async () => {
    const store = holdings();
    store.capture({ ...SBI, fetchedAt: "2026-09-09T01:00:00Z" });
    const state = await queryDatedState(executor(store), { date: "2026-09-10" });
    expect(state.accounts.map((a) => a.sourceId)).not.toContain("sbi-securities");
    expect(state.snapshots.find((s) => s.sourceId === "sbi-securities")).toMatchObject({
      freshness: "recent",
    });
    expect(state.coverage.containersWithoutSnapshot.map((c) => c.parserName)).not.toContain(
      SBI.parser,
    );
  });

  test("source and account filters narrow the accounts and the coverage", async () => {
    const executorFor = executor(holdings());
    const bySource = await queryDatedState(executorFor, {
      date: "2026-09-10",
      source: "smbc-bank",
    });
    expect(bySource.filters).toEqual({ source: "smbc-bank", account: null });
    expect(new Set(bySource.accounts.map((a) => a.sourceId))).toEqual(new Set(["smbc-bank"]));
    expect(bySource.coverage.containersWithoutSnapshot).toEqual([]);
    expect(bySource.coverage.staleSnapshots).toEqual([]);
    const byAccount = await queryDatedState(executorFor, {
      date: "2026-09-10",
      account: "acct-sbi",
    });
    expect(byAccount.accounts.map((a) => a.accountId)).toEqual(["acct-sbi"]);
  });

  test("the context id is a digest of the manifest", async () => {
    const executorFor = executor(holdings());
    const first = await queryDatedState(executorFor, { date: "2026-09-10" });
    const again = await queryDatedState(executorFor, { date: "2026-09-10" });
    const earlier = await queryDatedState(executorFor, { date: "2026-09-08" });
    expect(first.contextId).toMatch(/^[0-9a-f]{64}$/u);
    expect(again.contextId).toBe(first.contextId);
    expect(earlier.contextId).not.toBe(first.contextId);
    expect(first.manifest.policies).toEqual([
      "dated-state-freshness-v1",
      "dated-state-perimeter-v1",
    ]);
    expect(first.manifest.snapshotRefs).toHaveLength(3);
  });
});

describe("card payables on the date", () => {
  function cards(): { store: DatedStore } {
    const store = new DatedStore();
    // Due 9/26, debited and accepted on 9/26.
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
    // Due 9/10: a proposal only, never decided.
    const other = store.statement({
      card: "card-b",
      period: "2026-09",
      paymentDate: "2026-09-10",
      minor: 8_000,
      fetchedAt: "2026-09-02T01:00:00Z",
    });
    store.identify(other, "vpass", "acct-card-b", "identified");
    store.settle(other, { account: "acct-card-b", period: "2026-09", debitDate: "2026-09-10" });
    // No readable due date.
    store.statement({
      card: "card-c",
      period: "2026-09",
      paymentDate: null,
      minor: 1_000,
      fetchedAt: "2026-09-03T01:00:00Z",
    });
    return { store };
  }
  const statusOn = async (store: DatedStore, date: string) =>
    Object.fromEntries(
      (await queryDatedState(executor(store), { date })).payables.map((p) => [
        p.sourceAccount,
        p.status,
      ]),
    );

  test("status moves with the payment date and the reviewed debit date", async () => {
    const { store } = cards();
    expect(await statusOn(store, "2026-09-09")).toEqual({
      "card-a": "due_after_date",
      "card-b": "due_after_date",
      "card-c": "payment_date_unknown",
    });
    expect(await statusOn(store, "2026-09-10")).toEqual({
      "card-a": "due_after_date",
      "card-b": "due_unsettled",
      "card-c": "payment_date_unknown",
    });
    expect(await statusOn(store, "2026-09-25")).toMatchObject({ "card-a": "due_after_date" });
    expect(await statusOn(store, "2026-09-26")).toMatchObject({
      "card-a": "settled_on_or_before_date",
      "card-b": "due_unsettled",
    });
  });

  test("a payable carries the statement total, its capture and its review", async () => {
    const { store } = cards();
    const state = await queryDatedState(executor(store), { date: "2026-09-26" });
    const settled = state.payables.find((p) => p.sourceAccount === "card-a")!;
    expect(settled).toMatchObject({
      sourceId: "vpass",
      accountId: "acct-card",
      period: "2026-09",
      paymentDate: "2026-09-26",
      capturedAt: "2026-09-05T01:00:00.000Z",
      amount: { unitRef: "JPY", value: { status: "exact", value: { coefficient: "30000" } } },
      settlement: { reviewStatus: "accepted", debitDate: "2026-09-26" },
    });
    expect(state.payables.find((p) => p.sourceAccount === "card-c")!).toMatchObject({
      accountId: null,
      settlement: null,
    });
    // Unresolved statements are listed, never dropped.
    expect(state.payables).toHaveLength(3);
    expect(state.manifest.statementRefs).toHaveLength(3);
    expect(state.manifest.settlementRefs).toHaveLength(2);
  });

  test("a statement captured after the date is not yet a payable", async () => {
    const { store } = cards();
    expect(await statusOn(store, "2026-09-04")).toEqual({
      "card-b": "due_after_date",
      "card-c": "payment_date_unknown",
    });
  });

  test("the pure rule: settled only by an accepted review debited on or before the date", () => {
    const accepted = {
      proposalId: "p",
      reviewStatus: "accepted" as const,
      debitDate: "2026-09-24",
    };
    expect(payableStatus("2026-09-24", "2026-09-26", accepted)).toBe("settled_on_or_before_date");
    expect(payableStatus("2026-09-23", "2026-09-26", accepted)).toBe("due_after_date");
    expect(
      payableStatus("2026-09-27", "2026-09-26", { ...accepted, reviewStatus: "rejected" }),
    ).toBe("due_unsettled");
    expect(
      payableStatus("2026-09-27", "2026-09-26", { ...accepted, reviewStatus: "proposed" }),
    ).toBe("due_unsettled");
    expect(payableStatus("2026-09-27", "2026-09-26", { ...accepted, debitDate: null })).toBe(
      "due_unsettled",
    );
    expect(payableStatus("2026-09-27", null, null)).toBe("payment_date_unknown");
    expect(payableStatus("2026-09-27", "not-a-date", null)).toBe("payment_date_unknown");
    expect(payableStatus("2026-09-27", null, accepted)).toBe("settled_on_or_before_date");
  });
});

describe("bounds and input", () => {
  test("a read past the row bound is refused, never cut", async () => {
    const huge: SqlExecutor = {
      all: async <T>() => Array.from({ length: 5001 }, () => ({})) as T[],
      first: async () => null,
    };
    await expect(queryDatedState(huge, { date: "2026-09-10" })).rejects.toBeInstanceOf(
      DatedStateLimitError,
    );
  });

  test("an invalid date is refused", async () => {
    const store = new DatedStore();
    for (const date of ["2026-02-30", "2026-9-1", "", "2026-09-10T00:00:00Z"])
      await expect(queryDatedState(executor(store), { date })).rejects.toThrow("invalid_date");
  });
});
