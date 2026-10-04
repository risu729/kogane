// Synthetic inputs only: no page shape is read here (ADR 0032 and its
// 2026-09-27 amendment). Display text is placeholder; the bank references
// mirror the CORE shapes the identity rules accept, with made-up digits.
import { test, expect } from "bun:test";
import {
  bankAccountReference,
  bankSourceIdForDisplayedName,
  candidateDebitAccountEvidence,
  debitAccountSupportsCandidate,
  debitAccountTypeForDisplayedText,
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
    accountType: "普通",
    leadingDigits: "1234",
    maskedDigitCount: 3,
  },
  bankSourceId: "mizuho-bank",
  accountType: "ordinary",
};
const withDigits = (leadingDigits: string | null): CardDebitAccountStatement => ({
  ...statement,
  displayed: { ...statement.displayed, leadingDigits },
});
const refs = (...accounts: [string, string][]): BankAccountReference[] =>
  accounts.map(([sourceId, sourceAccount]) => bankAccountReference(sourceId, sourceAccount));

test("bank references: only a reference carrying the displayed account number is comparable", () => {
  expect(bankAccountReference("mizuho-bank", "mizuho-bank:ordinary:001:1234000")).toEqual({
    comparable: true,
    sourceId: "mizuho-bank",
    sourceAccount: "mizuho-bank:ordinary:001:1234000",
    accountType: "ordinary",
    branchCode: "001",
    accountNumber: "1234000",
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

test("displayed bank names resolve only through the table of modelled banks", () => {
  expect(bankSourceIdForDisplayedName("みずほ銀行")).toBe("mizuho-bank");
  expect(bankSourceIdForDisplayedName(" 三井住友 銀行 ")).toBe("smbc-bank");
  // NFKC: a full-width rendering of the same letters is the same name.
  expect(bankSourceIdForDisplayedName("ＳＢＩ新生銀行")).toBe("sbi-shinsei-bank");
  for (const name of [null, "", "架空銀行", "みずほ", "三井住友信託銀行"])
    expect(bankSourceIdForDisplayedName(name)).toBeNull();
  expect(debitAccountTypeForDisplayedText("普通")).toBe("ordinary");
  expect(debitAccountTypeForDisplayedText("当座")).toBe("current");
  expect(debitAccountTypeForDisplayedText("貯蓄")).toBeNull();
  expect(debitAccountTypeForDisplayedText(null)).toBeNull();
});

test("one account at the stated bank starting with the visible digits is proposed, never accepted", () => {
  const outcome = proposeCardDebitAccount(
    statement,
    refs(
      ["mizuho-bank", "mizuho-bank:ordinary:001:1234000"],
      ["mizuho-bank", "mizuho-bank:ordinary:001:0001234"],
      ["smbc-bank", "smbc-bank:ordinary-yen"],
    ),
  );
  expect(outcome).toEqual({
    outcome: "proposed",
    proposal: {
      policy: "card-debit-account-statement-v3",
      status: "proposed",
      cardSourceId: "myjcb",
      cardSourceAccount: "myjcb:synthetic:root",
      bankSourceId: "mizuho-bank",
      bankSourceAccount: "mizuho-bank:ordinary:001:1234000",
      evidenceRefs: [statement.ref],
      visibleDigitCount: 4,
      rationaleCodes: [
        "provider_stated_debit_account",
        "bank_agrees",
        "account_type_agrees",
        "branch_not_compared",
        "leading_digits_agree",
        "unique_among_known_accounts",
      ],
      rejectionConditions: ["statement_changed", "bank_reference_changed"],
    },
  });
});

test("the visible digits are a prefix: an account ending in them does not match", () => {
  // The mask direction of ADR 0032 as first written (trailing digits) is not
  // what MyJCB shows; an account whose LAST digits are 1234 is no match.
  expect(
    proposeCardDebitAccount(statement, refs(["mizuho-bank", "mizuho-bank:ordinary:001:0001234"])),
  ).toEqual({ outcome: "not-proposed", reason: "no_matching_account", comparedAccounts: 1 });
});

test("two accounts sharing the prefix are ambiguous, whatever their branch", () => {
  // No bank reference carries a branch name, so the displayed branch never
  // separates two accounts with the same leading digits.
  expect(
    proposeCardDebitAccount(
      statement,
      refs(
        ["mizuho-bank", "mizuho-bank:ordinary:001:1234000"],
        ["mizuho-bank", "mizuho-bank:ordinary:002:1234999"],
      ),
    ),
  ).toEqual({ outcome: "not-proposed", reason: "ambiguous_accounts", comparedAccounts: 2 });
});

test("the account type must agree", () => {
  const current: CardDebitAccountStatement = {
    ...statement,
    displayed: { ...statement.displayed, accountType: "当座" },
    accountType: "current",
  };
  expect(
    proposeCardDebitAccount(current, refs(["mizuho-bank", "mizuho-bank:ordinary:001:1234000"])),
  ).toEqual({ outcome: "not-proposed", reason: "no_matching_account", comparedAccounts: 1 });
  expect(
    proposeCardDebitAccount(
      { ...statement, accountType: null },
      refs(["mizuho-bank", "mizuho-bank:ordinary:001:1234000"]),
    ),
  ).toMatchObject({ reason: "account_type_not_resolved" });
});

test("missing or unreadable parts are reasons, never a guessed match", () => {
  const mizuho = refs(["mizuho-bank", "mizuho-bank:ordinary:001:1234000"]);
  expect(proposeCardDebitAccount({ ...statement, bankSourceId: null }, mizuho)).toMatchObject({
    reason: "bank_not_resolved",
  });
  for (const digits of [null, "", "１２３４", "12*4"])
    expect(proposeCardDebitAccount(withDigits(digits), mizuho)).toMatchObject({
      reason: "account_digits_not_shown",
    });
  expect(proposeCardDebitAccount(withDigits("12340000"), mizuho)).toMatchObject({
    reason: "no_matching_account",
  });
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
      refs(["sbi-shinsei-bank", "sbi-shinsei:1234000"]),
    ),
  ).toMatchObject({ reason: "no_comparable_bank_account" });
});

test("an uncomparable account at the same bank blocks uniqueness", () => {
  const accounts: BankAccountReference[] = [
    ...refs(["mizuho-bank", "mizuho-bank:ordinary:001:1234000"]),
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
  sourceAccount: "mizuho-bank:ordinary:001:1234000",
  accountId: "b",
  ownerRef: null,
  amount: card.amount,
  occurred: date,
};

test("a proposal supports a settlement candidate but never makes it eligible", () => {
  const outcome = proposeCardDebitAccount(
    statement,
    refs(["mizuho-bank", "mizuho-bank:ordinary:001:1234000"]),
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
        sourceAccount: "mizuho-bank:ordinary:001:5678000",
      })!,
    ),
  ).toBe(false);
});

test("candidate evidence: supports, names another account, or a closed reason", () => {
  const known = refs(
    ["mizuho-bank", "mizuho-bank:ordinary:001:1234000"],
    ["mizuho-bank", "mizuho-bank:ordinary:001:5678000"],
  );
  const facts = cardSettlementCandidate(card, debit)!;
  const before = JSON.stringify(facts);
  expect(candidateDebitAccountEvidence(statement, known, facts)).toMatchObject({
    outcome: "supports",
    reason: null,
  });
  const other = cardSettlementCandidate(card, {
    ...debit,
    sourceAccount: "mizuho-bank:ordinary:001:5678000",
  })!;
  expect(candidateDebitAccountEvidence(statement, known, other)).toMatchObject({
    outcome: "names_other_account",
    proposal: { bankSourceAccount: "mizuho-bank:ordinary:001:1234000" },
  });
  expect(
    candidateDebitAccountEvidence({ ...statement, bankSourceId: "smbc-bank" }, known, facts),
  ).toEqual({ outcome: "not_proposed", reason: "no_comparable_bank_account", proposal: null });
  // Evidence never touches the candidate's facts or eligibility.
  expect(JSON.stringify(facts)).toBe(before);
  expect(cardSettlementEligible(facts)).toBe(false);
});
