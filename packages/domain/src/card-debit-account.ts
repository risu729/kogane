// A card provider's own statement of the bank account a payment is debited
// from, and the rule that turns it into a proposed card -> bank account
// relation (ADR 0032). The rule only proposes: an operator still accepts every
// settlement (INV07), and nothing here makes a candidate eligible.
//
// No reader emits these statements yet. The MyJCB page block and the Vpass
// field that would carry them have not been observed in a fixture, so the
// display fields are typed here and filled by a reader only once the shape is
// known (docs/card-settlements.md, Provider-stated debit accounts).
import { validSourceFactRef, type SourceFactRef } from "./events.ts";
import type { CardSettlementFacts } from "./card-settlement.ts";

const CARD_DEBIT_ACCOUNT_POLICY = "card-debit-account-statement-v1";

/**
 * What the card provider displays about the debit account, verbatim. `null`
 * means the page does not show that part; it is never filled in. The account
 * number is the provider's masked rendering (ADR 0029 class b/c): Kogane never
 * stores more digits than the provider shows.
 */
interface CardDebitAccountDisplay {
  bankName: string | null;
  branchName: string | null;
  branchCode: string | null;
  accountType: string | null;
  maskedAccountNumber: string | null;
}

/** One `card_debit_account_statement` observation (a `typed-claim` fact). */
export interface CardDebitAccountStatement {
  ref: SourceFactRef;
  sourceId: "myjcb" | "vpass";
  /** The card side's CORE source account, as its statement totals carry it. */
  sourceAccount: string;
  displayed: CardDebitAccountDisplay;
  /**
   * The bank's CORE source id, resolved by the reader from `displayed.bankName`
   * through a table of observed renderings; `null` when the rendering is not in
   * that table. A bank name is never guessed.
   */
  bankSourceId: string | null;
  /**
   * The trailing account digits the provider shows unmasked, as ASCII digits;
   * `null` when the reader cannot tell which digits are visible.
   */
  visibleTrailingDigits: string | null;
}

/** A bank-side account reference, read from the CORE source account. */
export type BankAccountReference =
  | {
      comparable: true;
      sourceId: string;
      sourceAccount: string;
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
 * comparable.
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
  visibleDigitCount: number;
  rationaleCodes: CardDebitAccountRationale[];
  rejectionConditions: string[];
}
type CardDebitAccountRationale =
  | "provider_stated_debit_account"
  | "bank_agrees"
  | "branch_code_agrees"
  | "branch_not_compared"
  | "trailing_digits_agree"
  | "unique_among_known_accounts";
type CardDebitAccountReason =
  | "statement_invalid"
  | "bank_not_resolved"
  | "account_digits_not_shown"
  | "no_comparable_bank_account"
  | "no_matching_account"
  | "ambiguous_accounts"
  | "uncomparable_account_at_bank";
export type CardDebitAccountOutcome =
  | { outcome: "proposed"; proposal: CardDebitAccountProposal }
  | { outcome: "not-proposed"; reason: CardDebitAccountReason; comparedAccounts: number };

const ASCII_DIGITS = /^[0-9]+$/u;

/**
 * Proposes the one known bank account the card provider's statement names:
 * same bank, same branch code when both sides show one, and an account number
 * ending in the visible digits. Every other case is a closed reason, never a
 * guess: no match, more than one match, or another account at that bank whose
 * number Kogane cannot compare (it could be the real one).
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
  const digits = statement.visibleTrailingDigits;
  if (digits === null || !ASCII_DIGITS.test(digits)) return none("account_digits_not_shown");
  const atBank = bankAccounts.filter((account) => account.sourceId === statement.bankSourceId);
  const comparable = atBank.filter((account) => account.comparable);
  if (comparable.length === 0) return none("no_comparable_bank_account");
  const branch = statement.displayed.branchCode;
  const matches = comparable.filter(
    (account) =>
      account.accountNumber.length >= digits.length &&
      account.accountNumber.endsWith(digits) &&
      (branch === null || account.branchCode === null || account.branchCode === branch),
  );
  if (matches.length === 0) return none("no_matching_account", comparable.length);
  if (matches.length > 1) return none("ambiguous_accounts", comparable.length);
  if (comparable.length !== atBank.length)
    return none("uncomparable_account_at_bank", comparable.length);
  const match = matches[0]!;
  const branchCompared = branch !== null && match.branchCode !== null;
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
        branchCompared ? "branch_code_agrees" : "branch_not_compared",
        "trailing_digits_agree",
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
