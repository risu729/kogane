// Synthetic inputs only: no page shape is read here (ADR 0032). Display text is
// placeholder; the bank references mirror the CORE shapes the identity rules
// accept, with made-up digits.
import { test, expect } from "bun:test";
import {
  bankAccountReference,
  debitAccountSupportsCandidate,
  proposeCardDebitAccount,
  type BankAccountReference,
  type CardDebitAccountStatement,
} from "../src/card-debit-account.ts";
import {
  cardSettlementCandidate,
  cardSettlementEligible,
  type CardBankDebitFact,
  type CardStatementFact,
} from "../src/card-settlement.ts";
import { exactQuantity, integerDecimal } from "../src/values.ts";

const statement: CardDebitAccountStatement = {
  ref: { kind: "typed-claim", id: "claim:1", revision: "parse_run:1" },
  sourceId: "myjcb",
  sourceAccount: "myjcb:synthetic:root",
  displayed: {
    bankName: "架空銀行",
    branchName: "架空支店",
    branchCode: null,
    accountType: "架空種別",
    maskedAccountNumber: "****321",
  },
  bankSourceId: "mizuho-bank",
  visibleTrailingDigits: "321",
};
const refs = (...accounts: [string, string][]): BankAccountReference[] =>
  accounts.map(([sourceId, sourceAccount]) => bankAccountReference(sourceId, sourceAccount));

test("bank references: only a reference carrying the displayed account number is comparable", () => {
  expect(bankAccountReference("mizuho-bank", "mizuho-bank:ordinary:001:0000321")).toEqual({
    comparable: true,
    sourceId: "mizuho-bank",
    sourceAccount: "mizuho-bank:ordinary:001:0000321",
    branchCode: "001",
    accountNumber: "0000321",
  });
  expect(bankAccountReference("smbc-bank", "smbc-bank:ordinary-yen")).toMatchObject({
    comparable: false,
    reason: "reference_without_account_number",
  });
  expect(bankAccountReference("sbi-shinsei-bank", "sbi-shinsei:0000000321")).toMatchObject({
    comparable: false,
    reason: "reference_layout_unverified",
  });
  expect(bankAccountReference("mizuho-bank", "mizuho-bank:ordinary:01:321")).toMatchObject({
    comparable: false,
    reason: "reference_unrecognised",
  });
  expect(bankAccountReference("sony-bank", "sony-bank:deposit:JPY")).toMatchObject({
    comparable: false,
    reason: "reference_unrecognised",
  });
});

test("one account at the stated bank ending in the visible digits is proposed, never accepted", () => {
  const outcome = proposeCardDebitAccount(
    statement,
    refs(
      ["mizuho-bank", "mizuho-bank:ordinary:001:0000321"],
      ["mizuho-bank", "mizuho-bank:ordinary:001:0000654"],
      ["smbc-bank", "smbc-bank:ordinary-yen"],
    ),
  );
  expect(outcome).toEqual({
    outcome: "proposed",
    proposal: {
      policy: "card-debit-account-statement-v1",
      status: "proposed",
      cardSourceId: "myjcb",
      cardSourceAccount: "myjcb:synthetic:root",
      bankSourceId: "mizuho-bank",
      bankSourceAccount: "mizuho-bank:ordinary:001:0000321",
      evidenceRefs: [statement.ref],
      visibleDigitCount: 3,
      rationaleCodes: [
        "provider_stated_debit_account",
        "bank_agrees",
        "branch_not_compared",
        "trailing_digits_agree",
        "unique_among_known_accounts",
      ],
      rejectionConditions: ["statement_changed", "bank_reference_changed"],
    },
  });
});

test("a branch code shown on both sides must agree and is then a rationale", () => {
  const withBranch = { ...statement, displayed: { ...statement.displayed, branchCode: "002" } };
  const accounts = refs(
    ["mizuho-bank", "mizuho-bank:ordinary:001:0000321"],
    ["mizuho-bank", "mizuho-bank:ordinary:002:0001321"],
  );
  const outcome = proposeCardDebitAccount(withBranch, accounts);
  expect(outcome.outcome === "proposed" && outcome.proposal.bankSourceAccount).toBe(
    "mizuho-bank:ordinary:002:0001321",
  );
  expect(outcome.outcome === "proposed" && outcome.proposal.rationaleCodes).toContain(
    "branch_code_agrees",
  );
  // Without the branch code the same mask is not unique.
  expect(proposeCardDebitAccount(statement, accounts)).toEqual({
    outcome: "not-proposed",
    reason: "ambiguous_accounts",
    comparedAccounts: 2,
  });
  expect(
    proposeCardDebitAccount(
      { ...withBranch, displayed: { ...withBranch.displayed, branchCode: "003" } },
      accounts,
    ),
  ).toEqual({ outcome: "not-proposed", reason: "no_matching_account", comparedAccounts: 2 });
});

test("missing or unreadable parts are reasons, never a guessed match", () => {
  const mizuho = refs(["mizuho-bank", "mizuho-bank:ordinary:001:0000321"]);
  expect(proposeCardDebitAccount({ ...statement, bankSourceId: null }, mizuho)).toMatchObject({
    reason: "bank_not_resolved",
  });
  for (const visibleTrailingDigits of [null, "", "３２１", "32*"])
    expect(proposeCardDebitAccount({ ...statement, visibleTrailingDigits }, mizuho)).toMatchObject({
      reason: "account_digits_not_shown",
    });
  expect(
    proposeCardDebitAccount({ ...statement, visibleTrailingDigits: "900000321" }, mizuho),
  ).toMatchObject({ reason: "no_matching_account" });
  expect(
    proposeCardDebitAccount(
      { ...statement, ref: { kind: "balance", id: "balance:1", revision: "parse_run:1" } },
      mizuho,
    ),
  ).toMatchObject({ reason: "statement_invalid" });
});

test("a bank whose references carry no comparable number yields no proposal", () => {
  expect(
    proposeCardDebitAccount(
      { ...statement, bankSourceId: "smbc-bank" },
      refs(["smbc-bank", "smbc-bank:ordinary-yen"]),
    ),
  ).toEqual({ outcome: "not-proposed", reason: "no_comparable_bank_account", comparedAccounts: 0 });
  expect(
    proposeCardDebitAccount(
      { ...statement, bankSourceId: "sbi-shinsei-bank" },
      refs(["sbi-shinsei-bank", "sbi-shinsei:0000000321"]),
    ),
  ).toMatchObject({ reason: "no_comparable_bank_account" });
});

test("an uncomparable account at the same bank blocks uniqueness", () => {
  const accounts: BankAccountReference[] = [
    ...refs(["mizuho-bank", "mizuho-bank:ordinary:001:0000321"]),
    {
      comparable: false,
      sourceId: "mizuho-bank",
      sourceAccount: "mizuho-bank:other",
      reason: "reference_unrecognised",
    },
  ];
  expect(proposeCardDebitAccount(statement, accounts)).toEqual({
    outcome: "not-proposed",
    reason: "uncomparable_account_at_bank",
    comparedAccounts: 1,
  });
});

test("a proposal supports a settlement candidate but never makes it eligible", () => {
  const date = {
    kind: "local-date",
    value: "2026-09-10",
    zone: "Asia/Tokyo",
    basis: "provider",
  } as const;
  const card: CardStatementFact = {
    ref: { kind: "balance", id: "balance:1", revision: "parse_run:1" },
    sourceId: "myjcb",
    sourceAccount: "myjcb:synthetic:root",
    accountId: "a",
    ownerRef: null,
    amount: exactQuantity("JPY", integerDecimal(3000)),
    paymentDate: date,
    period: "2026-09",
  };
  const debit: CardBankDebitFact = {
    ref: { kind: "transaction", id: "transaction:2", revision: "parse_run:2" },
    sourceId: "mizuho-bank",
    sourceAccount: "mizuho-bank:ordinary:001:0000321",
    accountId: "b",
    ownerRef: null,
    amount: card.amount,
    occurred: date,
  };
  const outcome = proposeCardDebitAccount(
    statement,
    refs(["mizuho-bank", "mizuho-bank:ordinary:001:0000321"]),
  );
  if (outcome.outcome !== "proposed") throw new Error("expected a proposal");
  const facts = cardSettlementCandidate(card, debit)!;
  expect(debitAccountSupportsCandidate(outcome.proposal, facts)).toBe(true);
  expect(facts.ownership).toBe("unknown");
  expect(cardSettlementEligible(facts)).toBe(false);
  expect(
    debitAccountSupportsCandidate(
      outcome.proposal,
      cardSettlementCandidate(card, {
        ...debit,
        sourceAccount: "mizuho-bank:ordinary:001:0000654",
      })!,
    ),
  ).toBe(false);
});
