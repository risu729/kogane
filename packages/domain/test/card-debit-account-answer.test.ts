// The per-card debit account answer (ADR 0113). Every source account,
// reading and proposal id is made up.
import { expect, test } from "bun:test";
import {
  answerCardDebitAccount,
  compareMatchedDebitAccounts,
  statedDebitAccount,
  type MatchedDebitAccount,
  type StatedReading,
} from "../src/card-debit-account-answer.ts";

const SMBC = { bankSourceId: "smbc-bank", bankSourceAccount: "smbc-bank:synthetic-a" };
const SHINSEI = {
  bankSourceId: "sbi-shinsei-bank",
  bankSourceAccount: "sbi-shinsei:synthetic-b",
};

function reading(
  id: number,
  observedAt: string,
  accounts: StatedReading["accounts"],
  reasons: StatedReading["reasons"] = [],
): StatedReading {
  return {
    readingRef: {
      kind: "typed-claim",
      id: `card_debit_account_statement:${id}`,
      revision: "reader:synthetic-1",
    },
    observedAt,
    accounts,
    visibleDigitCount: accounts.length > 0 ? 4 : null,
    reasons,
  };
}

function matched(
  account: typeof SMBC,
  proposalId: string,
  debitDate: string | null,
  statements = 1,
): MatchedDebitAccount {
  return { ...account, statements, latest: { proposalId, debitDate, period: "2098-01" } };
}

test("a source without a reader is absent for that reason, whatever it is given", () => {
  expect(statedDebitAccount(false, [reading(1, "2098-01-01T00:00:00Z", [SMBC])])).toEqual({
    status: "absent",
    reason: "source_has_no_debit_account_statement",
    latest: null,
    lastNamed: null,
  });
  expect(statedDebitAccount(true, [])).toMatchObject({
    status: "absent",
    reason: "evidence_not_recorded",
  });
});

test("the newest reading decides the status; the newest naming one is kept when it is older", () => {
  const old = reading(1, "2098-01-01T00:00:00Z", [SMBC]);
  const ambiguous = reading(2, "2098-02-01T00:00:00Z", [], ["ambiguous_accounts"]);
  const stated = statedDebitAccount(true, [ambiguous, old]);
  expect(stated).toEqual({ status: "not_named", reason: null, latest: ambiguous, lastNamed: old });
  const conflicting = reading(3, "2098-03-01T00:00:00Z", [SHINSEI, SMBC]);
  expect(statedDebitAccount(true, [old, conflicting])).toMatchObject({
    status: "conflicting",
    lastNamed: old,
  });
  // Same capture time: the greater reading id is newer.
  const twin = reading(4, "2098-01-01T00:00:00Z", [SHINSEI]);
  expect(statedDebitAccount(true, [twin, old])).toMatchObject({
    status: "named",
    latest: twin,
    lastNamed: twin,
  });
});

test("a stated account answers first, with notes on what disagrees with it", () => {
  const stated = statedDebitAccount(true, [reading(1, "2098-01-01T00:00:00Z", [SMBC])]);
  expect(answerCardDebitAccount(stated, [matched(SMBC, "p-1", "2098-01-10")], [])).toEqual({
    basis: "provider-stated",
    account: SMBC,
    readingRef: stated.lastNamed!.readingRef,
    observedAt: "2098-01-01T00:00:00Z",
    codes: [],
  });
  const settledElsewhere = answerCardDebitAccount(
    stated,
    [matched(SMBC, "p-1", "2098-01-10"), matched(SHINSEI, "p-2", "2098-02-10")],
    [],
  );
  expect(settledElsewhere).toMatchObject({
    basis: "provider-stated",
    account: SMBC,
    codes: ["settled_account_differs"],
  });
  const newerUnresolved = statedDebitAccount(true, [
    reading(1, "2098-01-01T00:00:00Z", [SMBC]),
    reading(2, "2098-02-01T00:00:00Z", [], ["no_matching_account"]),
  ]);
  expect(answerCardDebitAccount(newerUnresolved, [], [])).toMatchObject({
    basis: "provider-stated",
    account: SMBC,
    codes: ["newer_reading_unresolved"],
  });
});

test("without a stated account, the newest accepted settlement answers", () => {
  const vpass = statedDebitAccount(false, []);
  expect(
    answerCardDebitAccount(
      vpass,
      [matched(SMBC, "p-1", "2098-01-10", 3), matched(SHINSEI, "p-2", "2098-02-10")],
      [matched(SMBC, "p-9", "2098-03-10")],
    ),
  ).toEqual({
    basis: "accepted-settlement",
    account: SHINSEI,
    proposalId: "p-2",
    debitDate: "2098-02-10",
    codes: ["settled_accounts_differ"],
  });
  const conflicting = statedDebitAccount(true, [
    reading(1, "2098-01-01T00:00:00Z", [SMBC, SHINSEI]),
  ]);
  expect(answerCardDebitAccount(conflicting, [matched(SMBC, "p-1", "2098-01-10")], [])).toEqual({
    basis: "accepted-settlement",
    account: SMBC,
    proposalId: "p-1",
    debitDate: "2098-01-10",
    codes: ["stated_reading_conflicting"],
  });
});

test("undecided candidates never answer; the reason says they are all there is", () => {
  const vpass = statedDebitAccount(false, []);
  expect(answerCardDebitAccount(vpass, [], [matched(SMBC, "p-1", "2098-01-10")])).toEqual({
    basis: "unknown",
    reason: "only_unreviewed_candidates",
  });
  expect(answerCardDebitAccount(vpass, [], [])).toEqual({
    basis: "unknown",
    reason: "no_debit_account_evidence",
  });
  const conflicting = statedDebitAccount(true, [
    reading(1, "2098-01-01T00:00:00Z", [SMBC, SHINSEI]),
  ]);
  expect(answerCardDebitAccount(conflicting, [], [matched(SMBC, "p-1", "2098-01-10")])).toEqual({
    basis: "unknown",
    reason: "stated_reading_conflicting",
  });
});

test("matched accounts are ordered newest debit first, a missing date last", () => {
  const sorted = [
    matched(SMBC, "p-1", null),
    matched(SHINSEI, "p-2", "2098-01-10"),
    matched(SMBC, "p-3", "2098-02-10"),
    matched(SHINSEI, "p-4", "2098-02-10"),
  ].sort(compareMatchedDebitAccounts);
  expect(sorted.map((entry) => entry.latest.proposalId)).toEqual(["p-4", "p-3", "p-2", "p-1"]);
});
