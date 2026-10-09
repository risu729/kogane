// `queryReconstructedState` (src/query/reconstructed-state.ts) over one
// synthetic store holding both the reported state (dated-state-fixture.ts)
// and an economic history written through CORE 0070's triggers
// (economic-history-fixture.ts): what it answers today for a bank account
// and a card account, without CORE 0070, before the log and with revisions it
// does not place, on a snapshot's boundary (B4), after history is filled in
// later (B12), and the same manifest for the same inputs (B13). Every
// account, amount and date is invented.
import { describe, expect, test } from "bun:test";
import { CARD_PURCHASE_WRITER_RELEASE } from "../../domain/src/card-purchase.ts";
import { KNOWN_WRITER_RELEASES } from "../../domain/src/reconstruction-adapter.ts";
import { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import {
  EconomicHistory,
  day,
  storeExecutor,
} from "../../read-model/test/economic-history-fixture.ts";
import {
  queryReconstructedState,
  ReconstructedStateInputError,
  type ReconstructedStateInput,
} from "../src/query/reconstructed-state.ts";

const BANK = "acct-bank";
const CARD = "acct-card";
const SMBC = { source: "smbc-bank", dataset: "balance-normalized", parser: "smbc-direct-balance" };
const NOW = "2026-04-30T00:00:00.000Z";
/** The releases the two writers seal with (a test pins them to the writers' constants). */
const SETTLEMENT_RELEASE = KNOWN_WRITER_RELEASES["card-settlement-review"][0]!;

/** A bank account with captures at both ends of March, and a card account. */
function world(endMinor = 9_000): EconomicHistory {
  const store = new DatedStore();
  const start = store.capture({
    ...SMBC,
    fetchedAt: "2026-03-01T03:00:00Z",
    balances: [{ account: "smbc-a", metric: "account_balance", instrument: "JPY", minor: 10_000 }],
  });
  store.identify(start, SMBC.source, BANK, "identified");
  const end = store.capture({
    ...SMBC,
    fetchedAt: "2026-03-31T03:00:00Z",
    balances: [
      { account: "smbc-a", metric: "account_balance", instrument: "JPY", minor: endMinor },
    ],
  });
  store.identify(end, SMBC.source, BANK, "identified");
  const statement = store.statement({
    card: "card-a",
    period: "2026-03",
    paymentDate: "2026-03-26",
    minor: 1,
    fetchedAt: "2026-03-05T01:00:00Z",
  });
  store.identify(statement, "vpass", CARD, "identified");
  return new EconomicHistory(store);
}

const input = (fields: Partial<ReconstructedStateInput> = {}): ReconstructedStateInput => ({
  account: BANK,
  from: "2026-03-01",
  to: "2026-03-31",
  basis: "cash",
  cut: null,
  now: NOW,
  ...fields,
});

/** A settlement the way the reviewed writer stores it, with a posting time row. */
function settle(
  h: EconomicHistory,
  eventId: string,
  date: string | null,
  fields: Partial<Parameters<EconomicHistory["adopt"]>[0]> = {},
) {
  h.adopt({
    eventId,
    revision: 1,
    legs: [
      { subject: BANK, amount: "1000", role: "decrease", basis: "cash-movement" },
      { subject: CARD, amount: null, role: "unresolved", basis: "obligation-change" },
    ],
    times: date === null ? [] : [["posting", day(date)]],
    knownAt: "2026-04-01T00:00:00.000Z",
    writerRelease: SETTLEMENT_RELEASE,
    ...fields,
  });
}

describe("what it answers today", () => {
  test("without CORE 0070 it is unavailable", async () => {
    const h = world();
    h.db.exec(
      "DROP VIEW unlogged_economic_revisions; DROP VIEW consumption_claim_conflicts; DROP VIEW live_consumption_claims; DROP VIEW economic_revision_claims",
    );
    const result = await queryReconstructedState(storeExecutor(h.db), input());
    expect(result).toMatchObject({
      status: "unavailable",
      reasons: ["economic_guard_missing"],
      reconstruction: null,
      manifest: null,
    });
  });

  test("an empty log is indeterminate; the reported figures are still compared", async () => {
    const h = world();
    const result = await queryReconstructedState(storeExecutor(h.db), input());
    expect(result.status).toBe("indeterminate");
    expect(result.reasons).toEqual(["log_empty", "family_not_evented", "history_coverage_unknown"]);
    expect(result.cut!.resolved).toEqual({ coreEpoch: "core-epoch-1", commitSeq: 0 });
    expect(result.cut!.requested).toEqual({ coreEpoch: "core-epoch-1", instant: NOW });
  });

  test("a bank account with a logged settlement: incomplete, the settlement applied and listed", async () => {
    const h = world();
    settle(h, "ev-settle", "2026-03-15");
    const result = await queryReconstructedState(storeExecutor(h.db), input());
    expect(result.status).toBe("incomplete");
    expect(result.reasons).toEqual(["family_not_evented", "history_coverage_unknown"]);
    const cell = result.reconstruction!.cells[0]!;
    expect(cell.applied.refs).toEqual(["ev-settle@1#0"]);
    expect(cell.reconstructed.value).toMatchObject({
      status: "exact",
      value: { coefficient: "9000", scale: 0 },
    });
    expect(cell.explanation).toMatchObject({
      status: "not_comparable",
      reasonCode: "reconstruction_incomplete",
    });
    expect(cell.explanation.remainder.value).toMatchObject({
      status: "exact",
      value: { coefficient: "0" },
    });
    expect(result.manifest!.cut).toEqual({
      requested: { coreEpoch: "core-epoch-1", commitSeq: 1 },
      resolved: { coreEpoch: "core-epoch-1", commitSeq: 1 },
      knownAt: "2026-04-01T00:00:00.000Z",
    });
  });

  test("a settlement as the writers store it today (no posting time) is listed, never placed", async () => {
    const h = world();
    settle(h, "ev-settle", null);
    const result = await queryReconstructedState(storeExecutor(h.db), input());
    expect(result.status).toBe("incomplete");
    expect(result.reasons).toEqual([
      "event_time_unknown",
      "family_not_evented",
      "history_coverage_unknown",
    ]);
    expect(result.reconstruction!.dispositions.map((row) => [row.ref, row.disposition])).toEqual([
      ["ev-settle@1#0", "unknown_effect"],
      ["ev-settle@1#1", "other_basis"],
    ]);
  });

  test("a settlement accepted before the log is indeterminate (knowledge_unlogged)", async () => {
    const h = world();
    settle(h, "ev-pre", "2026-03-15", { logged: false });
    settle(h, "ev-settle", "2026-03-16", {
      eventId: "ev-settle",
      legs: [{ subject: BANK, amount: "5", role: "decrease", basis: "cash-movement" }],
    });
    const result = await queryReconstructedState(storeExecutor(h.db), input());
    expect(result.status).toBe("indeterminate");
    expect(result.reasons).toContain("knowledge_unlogged");
    expect(result.knowledge!.unlogged).toEqual([
      { eventId: "ev-pre", revision: 1, reasonCode: "no_commit" },
    ]);
  });

  test("a pre-log settlement corrected twice before the log, then under it, is placed", async () => {
    const h = world();
    settle(h, "ev-pre", "2026-03-15", { logged: false });
    settle(h, "ev-pre", "2026-03-15", { revision: 2, logged: false });
    settle(h, "ev-pre", "2026-03-15", { revision: 3 });
    const result = await queryReconstructedState(storeExecutor(h.db), input());
    expect(result.status).toBe("incomplete");
    expect(result.knowledge!.unlogged).toEqual([]);
    expect(result.reconstruction!.cells[0]!.applied.refs).toEqual(["ev-pre@3#0"]);
  });

  test("a card account is unavailable (no reported container), its purchases listed", async () => {
    const h = world();
    h.adopt({
      eventId: "ev-purchase",
      revision: 1,
      kind: "purchase",
      state: "captured",
      legs: [
        {
          subject: `account:${CARD}`,
          amount: "700",
          role: "decrease",
          basis: "purchase-recognition",
        },
      ],
      times: [["usage", day("2026-03-10")]],
      writerRelease: CARD_PURCHASE_WRITER_RELEASE,
    });
    const result = await queryReconstructedState(storeExecutor(h.db), input({ account: CARD }));
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toEqual(["no_reported_container", "nothing_to_reconstruct"]);
    expect(result.reconstruction!.dispositions.map((row) => [row.ref, row.disposition])).toEqual([
      ["ev-purchase@1#0", "other_basis"],
    ]);
    expect(result.reconstruction!.accounts[0]).toMatchObject({
      startContainer: false,
      endContainer: false,
    });
  });

  test("an identity epoch declared after adoption needs review", async () => {
    const h = world();
    settle(h, "ev-settle", "2026-03-15");
    h.declareEpoch("identity-epoch-2");
    const result = await queryReconstructedState(storeExecutor(h.db), input());
    expect(result.status).toBe("needs_review");
    expect(result.reasons).toContain("identity_changed");
    expect(result.manifest!.identity.epoch).toBe("identity-epoch-2");
  });
});

describe("acceptance", () => {
  test("B4: a movement on the end capture's day is indeterminate, never adopted", async () => {
    const h = world(9_000);
    settle(h, "ev-settle", "2026-03-31");
    const result = await queryReconstructedState(storeExecutor(h.db), input());
    expect(result.status).toBe("indeterminate");
    expect(result.reasons).toContain("snapshot_boundary_unknown");
    expect(result.reconstruction!.cells[0]!.applied.count).toBe(0);
  });

  test("B12: history filled in later gives a new cut and a new result; the old cut's manifest is unchanged", async () => {
    const h = world(8_000);
    settle(h, "ev-1", "2026-03-15");
    const first = await queryReconstructedState(storeExecutor(h.db), input());
    settle(h, "ev-2", "2026-03-20", { knownAt: "2026-04-02T00:00:00.000Z" });
    const old = await queryReconstructedState(
      storeExecutor(h.db),
      input({ cut: first.cut!.requested }),
    );
    expect(old.contextId).toBe(first.contextId);
    expect(old.manifest).toEqual(first.manifest);
    const latest = await queryReconstructedState(storeExecutor(h.db), input());
    expect(latest.cut!.resolved.commitSeq).toBe(2);
    expect(latest.contextId).not.toBe(first.contextId);
    expect(latest.reconstruction!.cells[0]!.applied.refs).toEqual(["ev-1@1#0", "ev-2@1#0"]);
    // The late part: what entered between the end capture's cut and this one.
    expect(latest.late).toMatchObject({ entered: ["ev-1@1", "ev-2@1"], left: [] });
  });

  test("B13: the same inputs give the same manifest and context id", async () => {
    const h = world();
    settle(h, "ev-settle", "2026-03-15");
    const one = await queryReconstructedState(storeExecutor(h.db), input());
    const two = await queryReconstructedState(storeExecutor(h.db), input());
    expect(two.contextId).toBe(one.contextId);
    expect(one.manifest).toMatchObject({
      selectorRelease: "knowledge-selector-v1",
      adapterRelease: "reconstruction-adapter-b-v1",
      coverageProducer: "coverage-producer-none-v1",
      foldPolicy: "reconstruction-fold-v1",
    });
  });
});

describe("refusals", () => {
  const refused = async (fields: Partial<ReconstructedStateInput>) => {
    const h = world();
    try {
      await queryReconstructedState(storeExecutor(h.db), input(fields));
    } catch (error) {
      return error instanceof ReconstructedStateInputError ? error.code : String(error);
    }
    return "answered";
  };
  test("only the cash basis, a bounded past range and a past cut are answered", async () => {
    expect(await refused({ basis: "trade-date" })).toBe("basis_unsupported");
    expect(await refused({ from: "2025-01-01" })).toBe("range_too_long");
    expect(await refused({ to: "2026-05-01" })).toBe("range_in_future");
    expect(await refused({ from: "2026-03-31", to: "2026-03-01" })).toBe("invalid_query");
    expect(
      await refused({ cut: { coreEpoch: "core-epoch-1", instant: "2026-05-01T00:00:00.000Z" } }),
    ).toBe("cut_in_future");
    expect(await refused({ cut: { coreEpoch: "core-epoch-1", instant: "2026-04-01" } })).toBe(
      "invalid_query",
    );
  });

  test("a cut past the log or of another epoch is refused by the selector", async () => {
    const h = world();
    settle(h, "ev-settle", "2026-03-15");
    await expect(
      queryReconstructedState(
        storeExecutor(h.db),
        input({ cut: { coreEpoch: "core-epoch-1", commitSeq: 2 } }),
      ),
    ).rejects.toThrow("cut_after_log_end");
    await expect(
      queryReconstructedState(
        storeExecutor(h.db),
        input({ cut: { coreEpoch: "core-epoch-0", commitSeq: 1 } }),
      ),
    ).rejects.toThrow("cut_epoch_not_current");
  });
});
