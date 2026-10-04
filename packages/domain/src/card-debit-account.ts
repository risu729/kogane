// A card provider's own statement of the bank account a payment is debited
// from, and the rule that turns it into a proposed card -> bank account
// relation (ADR 0032 and its 2026-09-27 amendment). The rule only proposes: an
// operator still accepts every settlement (INV07), and nothing here makes a
// candidate eligible.
//
// The statement is MyJCB's 「カード情報」 table (read by
// `readMyJcbCardInformation`, `myjcb-card-information.ts`): bank name, branch
// name, account type and an account number whose FIRST digits are shown and
// whose remaining digits are masked. No Vpass statement API carries a debit
// account (observed absent, round 4), so Vpass has no statement.
import { validSourceFactRef, type SourceFactRef } from "./events.ts";
import type { CardSettlementFacts } from "./card-settlement.ts";

export const CARD_DEBIT_ACCOUNT_POLICY = "card-debit-account-statement-v2";

/** Account types the reader resolves from the provider's 科目 text. */
export type DebitAccountType = "ordinary" | "current";

/**
 * What the card provider displays about the debit account, verbatim, except
 * the account holder's name, which is never read: nothing uses it. `null`
 * means the reading does not have that part; it is never filled in. Kogane
 * never stores more digits than the provider shows.
 */
interface CardDebitAccountDisplay {
  bankName: string | null;
  branchName: string | null;
  /** The 科目 text as displayed, e.g. 普通. */
  accountType: string | null;
  /** The account number's leading digits the provider shows unmasked. */
  leadingDigits: string | null;
  /** How many masked characters follow the leading digits. */
  maskedDigitCount: number | null;
}

/** One `card_debit_account_statement` row (a `typed-claim` fact). */
export interface CardDebitAccountStatement {
  ref: SourceFactRef;
  sourceId: "myjcb";
  /** The card side's CORE source account, as its statement totals carry it. */
  sourceAccount: string;
  displayed: CardDebitAccountDisplay;
  /**
   * The bank's CORE source id, resolved from `displayed.bankName` through
   * `bankSourceIdForDisplayedName`; `null` when the name is not in that table.
   * A bank name is never guessed.
   */
  bankSourceId: string | null;
  /** `displayed.accountType` resolved; `null` for any other text. */
  accountType: DebitAccountType | null;
}

/**
 * The banks Kogane already models, by the name a card page displays for
 * them, compared after NFKC normalisation and whitespace removal. A name not
 * listed here (another bank, a 信用金庫, another rendering) resolves to no
 * bank: it is never matched by similarity.
 */
const BANK_SOURCE_IDS: Readonly<Record<string, string>> = {
  みずほ銀行: "mizuho-bank",
  三井住友銀行: "smbc-bank",
  SBI新生銀行: "sbi-shinsei-bank",
  ソニー銀行: "sony-bank",
};

export function bankSourceIdForDisplayedName(name: string | null): string | null {
  if (name === null) return null;
  const key = name.normalize("NFKC").replace(/\s+/gu, "");
  return Object.hasOwn(BANK_SOURCE_IDS, key) ? BANK_SOURCE_IDS[key]! : null;
}

const ACCOUNT_TYPES: Readonly<Record<string, DebitAccountType>> = {
  普通: "ordinary",
  当座: "current",
};

export function debitAccountTypeForDisplayedText(text: string | null): DebitAccountType | null {
  if (text === null) return null;
  return Object.hasOwn(ACCOUNT_TYPES, text) ? ACCOUNT_TYPES[text]! : null;
}

/** A bank-side account reference, read from the CORE source account. */
export type BankAccountReference =
  | {
      comparable: true;
      sourceId: string;
      sourceAccount: string;
      accountType: DebitAccountType;
      branchCode: string | null;
      accountNumber: string;
    }
  | {
      comparable: false;
      sourceId: string;
      sourceAccount: string;
      reason: BankReferenceReason;
    };
type BankReferenceReason =
  /** The reference names the account scope, not its number (SMBC). */
  | "reference_without_account_number"
  /** The reference carries the provider's account id, whose relation to the
   * number a card page displays nobody has observed (SBI Shinsei). */
  | "reference_layout_unverified"
  | "reference_unrecognised";

const MIZUHO_REFERENCE = /^mizuho-bank:ordinary:(\d{3}):(\d{7})$/u;
const SBI_SHINSEI_REFERENCE = /^sbi-shinsei:.+$/u;

/**
 * Reads the account-number part of a bank's CORE source account, for the
 * shapes the identity rules already accept (packages/identity/src/other.ts).
 * Only a reference whose digits are the provider's displayed account number is
 * comparable. No reference carries a branch name, so branch names are never
 * compared.
 */
export function bankAccountReference(
  sourceId: string,
  sourceAccount: string,
): BankAccountReference {
  const unusable = (reason: BankReferenceReason): BankAccountReference => ({
    comparable: false,
    sourceId,
    sourceAccount,
    reason,
  });
  switch (sourceId) {
    case "mizuho-bank": {
      const match = MIZUHO_REFERENCE.exec(sourceAccount);
      return match
        ? {
            comparable: true,
            sourceId,
            sourceAccount,
            accountType: "ordinary",
            branchCode: match[1]!,
            accountNumber: match[2]!,
          }
        : unusable("reference_unrecognised");
    }
    case "smbc-bank":
      return sourceAccount === "smbc-bank:ordinary-yen"
        ? unusable("reference_without_account_number")
        : unusable("reference_unrecognised");
    case "sbi-shinsei-bank":
      return SBI_SHINSEI_REFERENCE.test(sourceAccount)
        ? unusable("reference_layout_unverified")
        : unusable("reference_unrecognised");
    default:
      return unusable("reference_unrecognised");
  }
}

export interface CardDebitAccountProposal {
  policy: typeof CARD_DEBIT_ACCOUNT_POLICY;
  status: "proposed";
  cardSourceId: CardDebitAccountStatement["sourceId"];
  cardSourceAccount: string;
  bankSourceId: string;
  bankSourceAccount: string;
  evidenceRefs: SourceFactRef[];
  /** How many leading digits were compared: the strength of the match. */
  visibleDigitCount: number;
  rationaleCodes: CardDebitAccountRationale[];
  rejectionConditions: string[];
}
type CardDebitAccountRationale =
  | "provider_stated_debit_account"
  | "bank_agrees"
  | "account_type_agrees"
  | "branch_not_compared"
  | "leading_digits_agree"
  | "unique_among_known_accounts";
const CARD_DEBIT_ACCOUNT_REASONS = [
  "statement_invalid",
  "bank_not_resolved",
  "account_type_not_resolved",
  "account_digits_not_shown",
  "no_comparable_bank_account",
  "no_matching_account",
  "ambiguous_accounts",
  "uncomparable_account_at_bank",
] as const;
type CardDebitAccountReason = (typeof CARD_DEBIT_ACCOUNT_REASONS)[number];
export type CardDebitAccountOutcome =
  | { outcome: "proposed"; proposal: CardDebitAccountProposal }
  | { outcome: "not-proposed"; reason: CardDebitAccountReason; comparedAccounts: number };

const ASCII_DIGITS = /^[0-9]+$/u;

/**
 * Proposes the one known bank account the card provider's statement names:
 * same bank, same account type, and an account number that starts with the
 * visible leading digits. Every other case is a closed reason, never a guess:
 * no match, more than one match, or another account at that bank whose number
 * Kogane cannot compare (it could be the real one). The branch name is carried
 * as displayed and never compared: no bank reference carries one.
 */
export function proposeCardDebitAccount(
  statement: CardDebitAccountStatement,
  bankAccounts: readonly BankAccountReference[],
): CardDebitAccountOutcome {
  const none = (reason: CardDebitAccountReason, comparedAccounts = 0): CardDebitAccountOutcome => ({
    outcome: "not-proposed",
    reason,
    comparedAccounts,
  });
  if (!validSourceFactRef(statement.ref) || statement.ref.kind !== "typed-claim")
    return none("statement_invalid");
  if (statement.bankSourceId === null) return none("bank_not_resolved");
  if (statement.accountType === null) return none("account_type_not_resolved");
  const digits = statement.displayed.leadingDigits;
  if (digits === null || !ASCII_DIGITS.test(digits)) return none("account_digits_not_shown");
  const atBank = bankAccounts.filter((account) => account.sourceId === statement.bankSourceId);
  const comparable = atBank.filter((account) => account.comparable);
  if (comparable.length === 0) return none("no_comparable_bank_account");
  const matches = comparable.filter(
    (account) =>
      account.accountType === statement.accountType &&
      account.accountNumber.length >= digits.length &&
      account.accountNumber.startsWith(digits),
  );
  if (matches.length === 0) return none("no_matching_account", comparable.length);
  if (matches.length > 1) return none("ambiguous_accounts", comparable.length);
  if (comparable.length !== atBank.length)
    return none("uncomparable_account_at_bank", comparable.length);
  const match = matches[0]!;
  return {
    outcome: "proposed",
    proposal: {
      policy: CARD_DEBIT_ACCOUNT_POLICY,
      status: "proposed",
      cardSourceId: statement.sourceId,
      cardSourceAccount: statement.sourceAccount,
      bankSourceId: match.sourceId,
      bankSourceAccount: match.sourceAccount,
      evidenceRefs: [statement.ref],
      visibleDigitCount: digits.length,
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
  };
}

/**
 * Whether a proposed debit-account relation names both sides of a settlement
 * candidate. It is evidence for the reviewer, not ownership: it never sets
 * `ownerRef` or `ownershipEvidenceRefs`, so it cannot make a candidate
 * eligible (`cardSettlementEligible`).
 */
export function debitAccountSupportsCandidate(
  proposal: CardDebitAccountProposal,
  facts: CardSettlementFacts,
): boolean {
  return (
    proposal.cardSourceId === facts.statement.sourceId &&
    proposal.cardSourceAccount === facts.statement.sourceAccount &&
    proposal.bankSourceId === facts.bankDebit.sourceId &&
    proposal.bankSourceAccount === facts.bankDebit.sourceAccount
  );
}

/**
 * What one debit-account statement says about one settlement candidate, as
 * the sweep records it beside the candidate
 * (`card_settlement_debit_account_evidence`). Evidence only: the candidate's
 * facts, digest and eligibility are the same whichever outcome this is.
 *
 * - `supports`: the proposal names the candidate's card and bank account;
 * - `names_other_account`: the proposal names another account of the card's
 *   statement, so the provider states a different debit account;
 * - `not_proposed`: the rule made no proposal, for the closed `reason`.
 */
export type CardSettlementDebitAccountEvidence =
  | {
      outcome: "supports" | "names_other_account";
      reason: null;
      proposal: CardDebitAccountProposal;
    }
  | { outcome: "not_proposed"; reason: CardDebitAccountReason; proposal: null };

export function candidateDebitAccountEvidence(
  statement: CardDebitAccountStatement,
  bankAccounts: readonly BankAccountReference[],
  facts: CardSettlementFacts,
): CardSettlementDebitAccountEvidence {
  const outcome = proposeCardDebitAccount(statement, bankAccounts);
  if (outcome.outcome === "not-proposed")
    return { outcome: "not_proposed", reason: outcome.reason, proposal: null };
  return {
    outcome: debitAccountSupportsCandidate(outcome.proposal, facts)
      ? "supports"
      : "names_other_account",
    reason: null,
    proposal: outcome.proposal,
  };
}
