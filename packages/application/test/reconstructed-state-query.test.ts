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
import { canonicalDigest } from "../../domain/src/context.ts";
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
import type { ReconstructedCell } from "../../domain/src/reconstruction.ts";
import {
  DATED_BALANCES_SQL,
  DATED_POSITIONS_SQL,
  DATED_SNAPSHOTS_SQL,
  DATED_STATEMENTS_SQL,
} from "../../read-model/src/dated-state.ts";
import { ACCOUNTS_SOURCES_SQL } from "../../read-model/src/economic-selector.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";

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
  accounts: [BANK],
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
    expect(result.cutStanding).toBe("provisional");
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
    const result = await queryReconstructedState(storeExecutor(h.db), input({ accounts: [CARD] }));
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
    expect([first.cutStanding, old.cutStanding]).toEqual(["final", "final"]);
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
      adapterRelease: "reconstruction-adapter-b-v2",
      coverageProducer: "coverage-producer-none-v1",
      foldPolicy: "reconstruction-fold-v1",
    });
  });
});

test("the query context pins the changed B interpretation in both manifest layers", async () => {
  const h = world(9_000);
  settle(h, "ev-legacy", null);
  h.adopt({
    eventId: "ev-legacy",
    revision: 2,
    state: "unknown",
    unknownReason: "conflicting_evidence",
    legs: [],
    knownAt: "2026-04-02T00:00:00.000Z",
    writerRelease: SETTLEMENT_RELEASE,
    supersedes: [{ eventId: "ev-legacy", revision: 1 }],
  });
  settle(h, "ev-v2", "2026-03-15", {
    knownAt: "2026-04-03T00:00:00.000Z",
    writerRelease: "card-statement-settlement-v2:economic-guard-v1",
  });
  const result = await queryReconstructedState(storeExecutor(h.db), input());
  expect(result.status).toBe("incomplete");
  const cell = result.reconstruction!.cells.find((row) => row.accountId === BANK)!;
  expect(cell.applied.refs).toEqual(["ev-v2@1#0"]);
  expect(cell.reconstructed.value).toMatchObject({
    status: "exact",
    value: { coefficient: "9000", scale: 0 },
  });
  const inner = result.reconstruction!.manifest;
  const outer = result.manifest!;
  expect(inner.adapterRelease).toBe("reconstruction-adapter-b-v2");
  expect(outer.adapterRelease).toBe("reconstruction-adapter-b-v2");
  expect(outer.innerManifestDigest).toBe(await canonicalDigest(inner));
  expect(result.contextId).toBe(await canonicalDigest(outer));
  // Both version pins contribute to identity. This is a contract-identity
  // comparison, not a re-execution or mutation of the old reader or stored rows.
  const oldInnerVersion = await canonicalDigest({
    ...inner,
    adapterRelease: "reconstruction-adapter-b-v1",
  });
  expect(oldInnerVersion).not.toBe(outer.innerManifestDigest);
  expect(
    await canonicalDigest({
      ...outer,
      adapterRelease: "reconstruction-adapter-b-v1",
    }),
  ).not.toBe(result.contextId);
  expect(
    await canonicalDigest({
      ...outer,
      innerManifestDigest: oldInnerVersion,
    }),
  ).not.toBe(result.contextId);
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

describe("a scope of several accounts (ADR 0116)", () => {
  const SAVINGS = "acct-savings";
  const SHINSEI = {
    source: "sbi-shinsei-bank",
    dataset: "top-accounts-balance-and-activity",
    parser: "sbi-shinsei-top-balances-and-activity",
  };

  /** The bank world beside a savings account at another provider, reported at both ends. */
  function scoped(endCapture = "2026-03-31T03:00:00Z"): EconomicHistory {
    const h = world(9_000);
    for (const [fetchedAt, minor] of [
      ["2026-03-01T03:00:00Z", 50_000],
      [endCapture, 49_900],
    ] as const) {
      const capture = h.store.capture({
        ...SHINSEI,
        fetchedAt,
        balances: [{ account: "shinsei-a", metric: "account_balance", instrument: "JPY", minor }],
      });
      h.store.identify(capture, SHINSEI.source, SAVINGS, "identified");
    }
    settle(h, "ev-settle", "2026-03-15");
    h.adopt({
      eventId: "ev-savings",
      revision: 1,
      legs: [
        { subject: SAVINGS, amount: "100", role: "decrease", basis: "cash-movement" },
        { subject: CARD, amount: null, role: "unresolved", basis: "obligation-change" },
      ],
      times: [["posting", day("2026-03-20")]],
      knownAt: "2026-04-01T00:00:00.000Z",
      writerRelease: SETTLEMENT_RELEASE,
    });
    return h;
  }

  /** What one cell says (the scope's own knowledge, such as its set version, differs by scope). */
  const figures = (cell: ReconstructedCell) => ({
    accountId: cell.accountId,
    unitRef: cell.unitRef,
    start: cell.start,
    reconstructed: cell.reconstructed,
    applied: cell.applied,
    gaps: cell.gaps,
    explanation: cell.explanation,
  });

  test("each account's cells are what its one-account read answers; nothing is added across them", async () => {
    const sql = storeExecutor(scoped().db);
    const both = await queryReconstructedState(sql, input({ accounts: [SAVINGS, BANK] }));
    expect(both.accounts).toEqual([BANK, SAVINGS]);
    expect(both.manifest!.accounts).toEqual([BANK, SAVINGS]);
    expect(both.reconstruction!.accounts.map((account) => account.accountId)).toEqual([
      BANK,
      SAVINGS,
    ]);
    expect(both.reconstruction!.netWorth).toBe("not-computed");
    for (const account of [BANK, SAVINGS]) {
      const one = await queryReconstructedState(sql, input({ accounts: [account] }));
      expect(one.accounts).toEqual([account]);
      expect(
        both.reconstruction!.cells.filter((cell) => cell.accountId === account).map(figures),
      ).toEqual(one.reconstruction!.cells.map(figures));
    }
    const savings = both.reconstruction!.cells.find((cell) => cell.accountId === SAVINGS)!;
    expect(savings.unitRef).toBe("JPY");
    expect(savings.reconstructed.value).toMatchObject({
      status: "exact",
      value: { coefficient: "49900", scale: 0 },
    });
    expect(savings.applied.refs).toEqual(["ev-savings@1#0"]);
    // Both end captures share one instant, so the late part is the scope's.
    expect(both.lateUnavailable).toBeNull();
    expect(both.late!.entered).toEqual(["ev-savings@1", "ev-settle@1"]);
  });

  test("the order asked in changes nothing", async () => {
    const sql = storeExecutor(scoped().db);
    const one = await queryReconstructedState(sql, input({ accounts: [SAVINGS, BANK] }));
    const two = await queryReconstructedState(sql, input({ accounts: [BANK, SAVINGS] }));
    expect(two.contextId).toBe(one.contextId);
    expect(two).toEqual(one);
  });

  test("an account without a reported container makes the scope unavailable; the others are still folded", async () => {
    const sql = storeExecutor(scoped().db);
    const result = await queryReconstructedState(sql, input({ accounts: [BANK, CARD] }));
    expect(result.status).toBe("unavailable");
    expect(result.reasons[0]).toBe("no_reported_container");
    expect(result.reasons).toContain("nothing_to_reconstruct");
    expect(
      result.reconstruction!.accounts.map((account) => [
        account.accountId,
        account.startContainer,
        account.cells,
      ]),
    ).toEqual([
      [BANK, true, 1],
      [CARD, false, 0],
    ]);
    expect(result.reconstruction!.cells.map((cell) => cell.accountId)).toEqual([BANK]);
  });

  test("end captures at different instants leave the late part to each account's own read", async () => {
    const result = await queryReconstructedState(
      storeExecutor(scoped("2026-03-31T05:00:00Z").db),
      input({ accounts: [BANK, SAVINGS] }),
    );
    expect(result.late).toBeNull();
    expect(result.lateUnavailable).toBe("end_captures_differ");
  });

  test("one read of each reported date and one selector load, however many accounts", async () => {
    const h = scoped();
    const counted = (counts: Map<string, number>): SqlExecutor => {
      const inner = storeExecutor(h.db);
      const count = (sql: string) => counts.set(sql, (counts.get(sql) ?? 0) + 1);
      return {
        all: <T>(sql: string, args: readonly unknown[]) => {
          count(sql);
          return inner.all<T>(sql, args);
        },
        first: <T>(sql: string, args: readonly unknown[]) => {
          count(sql);
          return inner.first<T>(sql, args);
        },
      };
    };
    const one = new Map<string, number>();
    await queryReconstructedState(counted(one), input({ accounts: [BANK] }));
    const three = new Map<string, number>();
    await queryReconstructedState(counted(three), input({ accounts: [BANK, SAVINGS, CARD] }));
    // Each reported date is read once, the accounts' sources once.
    for (const sql of [
      DATED_BALANCES_SQL,
      DATED_POSITIONS_SQL,
      DATED_SNAPSHOTS_SQL,
      DATED_STATEMENTS_SQL,
    ])
      expect([one.get(sql), three.get(sql)]).toEqual([2, 2]);
    expect([one.get(ACCOUNTS_SOURCES_SQL), three.get(ACCOUNTS_SOURCES_SQL)]).toEqual([1, 1]);
    // Every other statement runs as often as for one account; the card's
    // statement adds one settlement-review read per date, bound as one list.
    for (const [sql, runs] of three)
      expect([sql.slice(0, 40), runs]).toEqual([
        sql.slice(0, 40),
        one.get(sql) ?? Math.min(runs, 2),
      ]);
  });

  test("an empty, repeated or too long scope is refused, never narrowed", async () => {
    const sql = storeExecutor(scoped().db);
    for (const accounts of [
      [],
      [BANK, BANK],
      Array.from({ length: 21 }, (_, index) => `acct-${String(index)}`),
    ])
      await expect(queryReconstructedState(sql, input({ accounts }))).rejects.toThrow(
        "invalid_query",
      );
  });

  test("on random stores, each account's cells in a scope are its own answer's, except a late part the scope does not have", async () => {
    const BANKS = [SMBC, SHINSEI];
    const STATUS_ORDER = ["unavailable", "indeterminate", "needs_review", "incomplete", "complete"];
    let lateOnlyCells = 0;
    let checkedCells = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      let state = seed;
      const next = () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
      };
      const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
      const someDay = () =>
        new Date(Date.UTC(2026, 1, 26) + Math.floor(next() * 37) * 86_400_000)
          .toISOString()
          .slice(0, 10);
      const store = new DatedStore();
      const accounts = Array.from(
        { length: 1 + Math.floor(next() * 4) },
        (_, index) => `acct-r${String(index)}`,
      );
      for (const [index, account] of accounts.entries()) {
        // Now and then an account no reported container lists.
        if (next() < 0.2) continue;
        const bank = pick(BANKS);
        for (let capture = Math.floor(next() * 4); capture > 0; capture -= 1) {
          const date = next() < 0.5 ? pick(["2026-02-28", "2026-03-01", "2026-03-31"]) : someDay();
          const captured = store.capture({
            ...bank,
            fetchedAt: `${date}T${pick(["03:00:00Z", "12:00:00Z", "14:59:59Z", "15:00:00Z"])}`,
            balances: [
              {
                account: `p-${String(index)}`,
                metric: "account_balance",
                instrument: "JPY",
                minor: next() < 0.1 ? null : Math.floor(next() * 100_000),
              },
            ],
          });
          store.identify(captured, bank.source, account, pick(["identified", "provider-local"]));
        }
      }
      const h = new EconomicHistory(store);
      for (const account of [...accounts, CARD])
        if (h.db.query("SELECT 1 FROM accounts WHERE id=?").get(account) === null)
          h.account(account);
      let clock = Date.parse("2026-03-02T00:00:00.000Z");
      for (let event = Math.floor(next() * 7); event > 0; event -= 1) {
        const account = pick(accounts);
        const other = pick([...accounts, CARD]);
        const revisions = next() < 0.25 ? 2 : 1;
        const logged = next() < 0.85;
        for (let revision = 1; revision <= revisions; revision += 1) {
          clock += Math.floor(next() * 5 * 86_400_000);
          const time = next();
          h.adopt({
            eventId: `ev-${String(event)}`,
            revision,
            legs:
              next() < 0.3 && other !== account
                ? [
                    {
                      subject: account,
                      amount: String(Math.floor(next() * 5_000)),
                      role: "decrease",
                      basis: "cash-movement",
                    },
                    {
                      subject: other,
                      amount: next() < 0.5 ? null : String(Math.floor(next() * 5_000)),
                      role: "increase",
                      basis: "cash-movement",
                    },
                  ]
                : [
                    {
                      subject: account,
                      amount: next() < 0.1 ? null : String(Math.floor(next() * 5_000)),
                      role: pick(["decrease", "increase"] as const),
                      basis: "cash-movement",
                    },
                    { subject: CARD, amount: null, role: "unresolved", basis: "obligation-change" },
                  ],
            times:
              time < 0.1
                ? []
                : [["posting", day(time < 0.3 ? pick(["2026-03-01", "2026-03-31"]) : someDay())]],
            knownAt: new Date(clock).toISOString(),
            writerRelease: SETTLEMENT_RELEASE,
            logged: revision === revisions ? logged : true,
          });
        }
      }
      const sql = storeExecutor(h.db);
      const scope = [...accounts, CARD];
      const all = await queryReconstructedState(sql, input({ accounts: scope }));
      // Never a total: the fold's net worth stays not computed.
      expect(all.reconstruction?.netWorth ?? "not-computed").toBe("not-computed");
      for (const account of scope) {
        const alone = await queryReconstructedState(sql, input({ accounts: [account] }));
        // The scope's reasons hold every account's, and its status is at least as grave.
        for (const reason of alone.reasons)
          expect([seed, account, reason, all.reasons.includes(reason)]).toEqual([
            seed,
            account,
            reason,
            true,
          ]);
        expect(STATUS_ORDER.indexOf(all.status)).toBeLessThanOrEqual(
          STATUS_ORDER.indexOf(alone.status),
        );
        const mine = (cells: readonly ReconstructedCell[] | undefined) =>
          (cells ?? []).filter((cell) => cell.accountId === account);
        const scoped = mine(all.reconstruction?.cells);
        const own = mine(alone.reconstruction?.cells);
        expect([seed, account, scoped.length]).toEqual([seed, account, own.length]);
        for (const [index, cell] of scoped.entries()) {
          checkedCells += 1;
          const ownCell = own[index]!;
          // The late part is the scope's: with end captures at different
          // instants it is not computed for the scope (ADR 0116, decision 5).
          if (all.lateUnavailable !== null && alone.lateUnavailable === null) {
            if (
              JSON.stringify(cell.explanation.lateRecorded) !==
              JSON.stringify(ownCell.explanation.lateRecorded)
            )
              lateOnlyCells += 1;
            expect(cell.explanation.lateRecorded).toBeNull();
            expect([
              seed,
              account,
              { ...cell, explanation: { ...cell.explanation, lateRecorded: null } },
            ]).toEqual([
              seed,
              account,
              { ...ownCell, explanation: { ...ownCell.explanation, lateRecorded: null } },
            ]);
          } else expect([seed, account, cell]).toEqual([seed, account, ownCell]);
        }
        expect(all.reconstruction?.accounts.find((entry) => entry.accountId === account)).toEqual(
          alone.reconstruction?.accounts[0],
        );
      }
    }
    expect(checkedCells).toBeGreaterThan(40);
    expect(lateOnlyCells).toBeGreaterThan(0);
  }, 120_000);
});
