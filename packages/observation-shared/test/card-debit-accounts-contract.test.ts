// The wire contract of the per-card debit account answer (ADR 0114): closed
// codes only, and an answer that agrees with the evidence it names, so the
// page never shows an account its own evidence does not carry. Every value is
// invented.
import { expect, test } from "bun:test";
import { validApiResponse } from "../src/api-validation.ts";
import {
  CARD_DEBIT_ACCOUNTS_PATH,
  validCardDebitAccountsReview,
} from "../src/card-debit-accounts-contract.ts";

const SMBC = { bankSourceId: "smbc-bank", bankSourceAccount: "smbc-bank:synthetic-a" };
const SHINSEI = { bankSourceId: "sbi-shinsei-bank", bankSourceAccount: "sbi-shinsei:synthetic-b" };
const reading = (id: number, accounts: unknown[]) => ({
  readingRef: {
    kind: "typed-claim",
    id: `card_debit_account_statement:${id}`,
    revision: "reader:synthetic-1",
  },
  observedAt: "2098-01-12T00:00:00Z",
  accounts,
  visibleDigitCount: accounts.length > 0 ? 4 : null,
  reasons: accounts.length > 0 ? [] : ["no_matching_account"],
});
const matched = (account: typeof SMBC, proposalId: string) => ({
  ...account,
  statements: 2,
  latest: { proposalId, debitDate: "2098-01-10", period: "2098-01" },
});

function card(overrides: Record<string, unknown> = {}) {
  const named = reading(7, [SMBC]);
  return {
    card: { sourceId: "myjcb", sourceAccount: "myjcb:synthetic:root", accountId: "acct-1" },
    latestStatement: {
      ref: { kind: "balance", id: "balance:3", revision: "parse_run:2" },
      period: "2098-01",
      paymentDate: {
        kind: "local-date",
        value: "2098-01-10",
        zone: "Asia/Tokyo",
        basis: "provider",
      },
      amount: {
        unitRef: "JPY",
        value: {
          status: "exact",
          value: { coefficient: "0", scale: 0 },
          normalizationVersion: "exact-arith-v1",
        },
      },
    },
    stated: { status: "named", reason: null, latest: named, lastNamed: named },
    settled: [matched(SHINSEI, "p-2")],
    proposed: [],
    answer: {
      basis: "provider-stated",
      account: SMBC,
      readingRef: named.readingRef,
      observedAt: named.observedAt,
      codes: ["settled_account_differs"],
    },
    ...overrides,
  };
}
const page = (items: unknown[]) => ({
  apiVersion: 2,
  schemaVersion: "kogane-card-debit-accounts-v1",
  manifest: { bases: ["provider-stated", "accepted-settlement"], cardsMax: 100 },
  items,
  cardsTruncated: false,
});

test("a stated answer, a settled answer and an unknown one are each valid", () => {
  const vpassStated = {
    status: "absent",
    reason: "source_has_no_debit_account_statement",
    latest: null,
    lastNamed: null,
  };
  const settled = card({
    card: { sourceId: "vpass", sourceAccount: "vpass:card-001", accountId: null },
    stated: vpassStated,
    settled: [matched(SHINSEI, "p-2")],
    answer: {
      basis: "accepted-settlement",
      account: SHINSEI,
      proposalId: "p-2",
      debitDate: "2098-01-10",
      codes: [],
    },
  });
  const unknown = card({
    card: { sourceId: "vpass", sourceAccount: "vpass:card-002", accountId: null },
    latestStatement: null,
    stated: vpassStated,
    settled: [],
    proposed: [matched(SMBC, "p-3")],
    answer: { basis: "unknown", reason: "only_unreviewed_candidates" },
  });
  // The last named account answers while a newer reading names none, and says so.
  const older = card({
    stated: {
      status: "not_named",
      reason: null,
      latest: reading(8, []),
      lastNamed: reading(7, [SMBC]),
    },
    answer: {
      basis: "provider-stated",
      account: SMBC,
      readingRef: reading(7, [SMBC]).readingRef,
      observedAt: "2098-01-12T00:00:00Z",
      codes: ["settled_account_differs", "newer_reading_unresolved"],
    },
  });
  expect(validApiResponse(CARD_DEBIT_ACCOUNTS_PATH, page([card(), settled, unknown, older]))).toBe(
    true,
  );
});

test("an answer its evidence does not carry, or an unknown code, is refused", () => {
  const invalid = [
    // The stated answer names another account than the reading.
    card({
      answer: {
        basis: "provider-stated",
        account: SHINSEI,
        readingRef: reading(7, [SMBC]).readingRef,
        observedAt: "2098-01-12T00:00:00Z",
        codes: [],
      },
    }),
    // A settled answer while a reading names an account.
    card({
      answer: {
        basis: "accepted-settlement",
        account: SHINSEI,
        proposalId: "p-2",
        debitDate: null,
        codes: [],
      },
    }),
    // Unknown while an accepted settlement exists.
    card({
      stated: { status: "absent", reason: "evidence_not_recorded", latest: null, lastNamed: null },
      answer: { basis: "unknown", reason: "no_debit_account_evidence" },
    }),
    // Codes outside the closed lists.
    card({
      answer: {
        basis: "provider-stated",
        account: SMBC,
        readingRef: reading(7, [SMBC]).readingRef,
        observedAt: "2098-01-12T00:00:00Z",
        codes: ["guessed"],
      },
    }),
    card({ stated: { status: "absent", reason: "guessed", latest: null, lastNamed: null } }),
    // A named status whose reading names two accounts.
    card({
      stated: {
        status: "named",
        reason: null,
        latest: reading(8, [SMBC, SHINSEI]),
        lastNamed: reading(7, [SMBC]),
      },
    }),
    card({ card: { sourceId: "smbc-bank", sourceAccount: "x", accountId: null } }),
    // A named status whose newest reading is not the one that names the account.
    card({
      stated: {
        status: "named",
        reason: null,
        latest: reading(8, [SMBC]),
        lastNamed: reading(7, [SMBC]),
      },
    }),
    // A note the evidence does not carry, or one it carries left out.
    card({
      answer: {
        basis: "provider-stated",
        account: SMBC,
        readingRef: reading(7, [SMBC]).readingRef,
        observedAt: "2098-01-12T00:00:00Z",
        codes: [],
      },
    }),
    card({
      stated: {
        status: "not_named",
        reason: null,
        latest: reading(8, []),
        lastNamed: reading(7, [SMBC]),
      },
    }),
    // The stated answer's capture time is not its reading's.
    card({
      answer: {
        basis: "provider-stated",
        account: SMBC,
        readingRef: reading(7, [SMBC]).readingRef,
        observedAt: "2098-02-12T00:00:00Z",
        codes: ["settled_account_differs"],
      },
    }),
    // A settled answer with a note its evidence does not carry.
    card({
      stated: { status: "absent", reason: "evidence_not_recorded", latest: null, lastNamed: null },
      answer: {
        basis: "accepted-settlement",
        account: SHINSEI,
        proposalId: "p-2",
        debitDate: "2098-01-10",
        codes: ["settled_accounts_differ"],
      },
    }),
    // An unknown reason the evidence contradicts.
    card({
      stated: { status: "absent", reason: "evidence_not_recorded", latest: null, lastNamed: null },
      settled: [],
      proposed: [matched(SMBC, "p-3")],
      answer: { basis: "unknown", reason: "no_debit_account_evidence" },
    }),
    card({
      stated: { status: "absent", reason: "evidence_not_recorded", latest: null, lastNamed: null },
      settled: [],
      answer: { basis: "unknown", reason: "stated_reading_conflicting" },
    }),
  ];
  for (const item of invalid) expect(validCardDebitAccountsReview(page([item]))).toBe(false);
  expect(
    validCardDebitAccountsReview({ ...page([]), manifest: { bases: ["accepted-settlement"] } }),
  ).toBe(false);
  expect(validCardDebitAccountsReview(page(Array.from({ length: 101 }, () => card())))).toBe(false);
});

test("a statement total that is not exact carries its status and reason; a bare null is refused (INV05)", () => {
  const statement = card().latestStatement;
  const withTotal = (amount: unknown) => card({ latestStatement: { ...statement, amount } });
  for (const value of [
    { status: "unparsed", reasonCode: "stored:unparsed" },
    { status: "missing", reasonCode: "decimal_not_projected" },
  ])
    expect(validCardDebitAccountsReview(page([withTotal({ unitRef: "JPY", value })]))).toBe(true);
  for (const amount of [
    null,
    undefined,
    // An exact status carries a value, never a reason.
    { unitRef: "JPY", value: { status: "exact", reasonCode: "stored:exact" } },
  ])
    expect(validCardDebitAccountsReview(page([withTotal(amount)]))).toBe(false);
});
