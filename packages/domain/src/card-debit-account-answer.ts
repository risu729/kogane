// Which bank account each credit card is debited from (ADR 0113,
// docs/card-settlements.md, Debit account per card). One answer per card,
// decided only from evidence Kogane already holds, and saying which kind of
// evidence it rests on:
//
// - `provider-stated`: the card provider's own statement of the debit
//   account, as the settlement sweep compared it with the bank accounts Kogane
//   knows (`card_settlement_debit_account_evidence`, ADR 0032). Today only
//   MyJCB's 「カード情報」 table states one;
// - `accepted-settlement`: a statement/debit match the operator accepted
//   (`card-settlement.accept`). The match was proposed by equal amounts and
//   nearby dates and then decided, so it says which account paid, not which
//   account the provider names: weaker than a stated account;
// - `unknown`, with a closed reason. A candidate nobody has decided is a
//   proposal (INV07): it is listed beside the answer, never used as one.
//
// Pure: no storage, no clock. No amount and no displayed provider text is
// read or returned; accounts are CORE source accounts.
import type { CardDebitAccountReason } from "./card-debit-account.ts";
import type { SourceFactRef } from "./events.ts";

export const CARD_DEBIT_ACCOUNT_ANSWER_RULE = "card-debit-account-answer-v1";

/** The bases an answer can rest on, strongest first. */
export const CARD_DEBIT_ACCOUNT_BASES = ["provider-stated", "accepted-settlement"] as const;
export type CardDebitAccountBasis = (typeof CARD_DEBIT_ACCOUNT_BASES)[number];

/** A bank account as CORE names it: the bank adapter's source and source account. */
export interface DebitBankAccount {
  bankSourceId: string;
  bankSourceAccount: string;
}

/**
 * One reading of a provider page that states the debit account, with what the
 * sweep's rule made of it for every candidate it was compared with.
 */
export interface StatedReading {
  /** `typed-claim` `card_debit_account_statement:<id>`, revision `reader:<version>`. */
  readingRef: SourceFactRef;
  /** When the provider page was captured (the artifact's fetch time). */
  observedAt: string;
  /** Distinct accounts its evidence rows name, by bank source then account. */
  accounts: DebitBankAccount[];
  /** Leading digits the rule compared; null when it named no account. */
  visibleDigitCount: number | null;
  /** Distinct closed reasons of its `not_proposed` rows, in code order. */
  reasons: CardDebitAccountReason[];
}

/**
 * Why a card has no stated reading at all:
 *
 * - `source_has_no_debit_account_statement`: the source has no reader of a
 *   stated debit account (Vpass's statement APIs carry none);
 * - `evidence_not_recorded`: a MyJCB card whose readings the settlement sweep
 *   has compared with no candidate under the current policy and reader version
 *   (no reading yet, only refused readings, or no candidate of its statements).
 */
export const STATED_ABSENT_REASONS = [
  "source_has_no_debit_account_statement",
  "evidence_not_recorded",
] as const;
export type StatedAbsentReason = (typeof STATED_ABSENT_REASONS)[number];

/**
 * The provider-stated side of one card. `latest` is the newest reading with
 * evidence (by capture time, then reading id); `lastNamed` the newest one that
 * names exactly one account, which can be older than `latest`.
 *
 * - `named`: `latest` names exactly one account;
 * - `conflicting`: `latest` names more than one (the rule was given different
 *   known accounts for different candidates);
 * - `not_named`: `latest` names none, with its reasons;
 * - `absent`: no reading has evidence, with a closed reason.
 */
export interface StatedDebitAccount {
  status: "named" | "conflicting" | "not_named" | "absent";
  reason: StatedAbsentReason | null;
  latest: StatedReading | null;
  lastNamed: StatedReading | null;
}

/** The candidates of one card that name one bank account. */
export interface MatchedDebitAccount extends DebitBankAccount {
  /** Distinct statements (statement keys) among them. */
  statements: number;
  /** The candidate with the latest debit date (then the greatest id). */
  latest: { proposalId: string; debitDate: string | null; period: string | null };
}

/**
 * Closed notes on an answer:
 *
 * - `settled_account_differs`: a provider-stated answer, and the newest
 *   accepted settlement was debited from another account;
 * - `newer_reading_unresolved`: a provider-stated answer from `lastNamed`,
 *   while a newer reading names no account or more than one;
 * - `settled_accounts_differ`: an accepted-settlement answer, and accepted
 *   settlements of the card were debited from more than one account;
 * - `stated_reading_conflicting`: an accepted-settlement answer, and the
 *   newest stated reading names more than one account.
 */
export const CARD_DEBIT_ACCOUNT_ANSWER_CODES = [
  "settled_account_differs",
  "newer_reading_unresolved",
  "settled_accounts_differ",
  "stated_reading_conflicting",
] as const;
export type CardDebitAccountAnswerCode = (typeof CARD_DEBIT_ACCOUNT_ANSWER_CODES)[number];

/**
 * Why an answer is `unknown`, in the order checked:
 *
 * - `stated_reading_conflicting`: the newest stated reading names more than
 *   one account, and nothing else answers;
 * - `only_unreviewed_candidates`: only candidates nobody has decided name an
 *   account (listed in `proposed`, never adopted);
 * - `no_debit_account_evidence`: nothing names an account.
 */
export const CARD_DEBIT_ACCOUNT_UNKNOWN_REASONS = [
  "stated_reading_conflicting",
  "only_unreviewed_candidates",
  "no_debit_account_evidence",
] as const;
export type CardDebitAccountUnknownReason = (typeof CARD_DEBIT_ACCOUNT_UNKNOWN_REASONS)[number];

export type CardDebitAccountAnswer =
  | {
      basis: "provider-stated";
      account: DebitBankAccount;
      /** The reading the account comes from, and when its page was captured. */
      readingRef: SourceFactRef;
      observedAt: string;
      codes: CardDebitAccountAnswerCode[];
    }
  | {
      basis: "accepted-settlement";
      account: DebitBankAccount;
      /** The newest accepted settlement debited from it, and its debit date. */
      proposalId: string;
      debitDate: string | null;
      codes: CardDebitAccountAnswerCode[];
    }
  | { basis: "unknown"; reason: CardDebitAccountUnknownReason };

const sameAccount = (a: DebitBankAccount, b: DebitBankAccount): boolean =>
  a.bankSourceId === b.bankSourceId && a.bankSourceAccount === b.bankSourceAccount;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Bank source, then source account. */
export function compareDebitBankAccounts(a: DebitBankAccount, b: DebitBankAccount): number {
  return (
    compareText(a.bankSourceId, b.bankSourceId) ||
    compareText(a.bankSourceAccount, b.bankSourceAccount)
  );
}

/** The reading id of `card_debit_account_statement:<id>`, for the tie-break. */
const readingId = (reading: StatedReading): number =>
  Number(reading.readingRef.id.slice(reading.readingRef.id.lastIndexOf(":") + 1));

/** Newest first: capture time, then reading id. */
function newestFirst(a: StatedReading, b: StatedReading): number {
  return compareText(b.observedAt, a.observedAt) || readingId(b) - readingId(a);
}

/**
 * The stated side of one card from its readings with evidence (any number, in
 * any order). `hasReader` is false for a source with no stated-account reader.
 */
export function statedDebitAccount(
  hasReader: boolean,
  readings: readonly StatedReading[],
): StatedDebitAccount {
  if (!hasReader)
    return {
      status: "absent",
      reason: "source_has_no_debit_account_statement",
      latest: null,
      lastNamed: null,
    };
  const sorted = [...readings].sort(newestFirst);
  const latest = sorted[0] ?? null;
  if (latest === null)
    return { status: "absent", reason: "evidence_not_recorded", latest: null, lastNamed: null };
  const lastNamed = sorted.find((reading) => reading.accounts.length === 1) ?? null;
  const named = latest.accounts.length;
  return {
    status: named === 1 ? "named" : named > 1 ? "conflicting" : "not_named",
    reason: null,
    latest,
    lastNamed,
  };
}

/** Newest first: debit date (a missing one last), then proposal id, then account. */
export function compareMatchedDebitAccounts(
  a: MatchedDebitAccount,
  b: MatchedDebitAccount,
): number {
  const dateA = a.latest.debitDate;
  const dateB = b.latest.debitDate;
  if (dateA !== dateB) {
    if (dateA === null) return 1;
    if (dateB === null) return -1;
    return compareText(dateB, dateA);
  }
  return compareText(b.latest.proposalId, a.latest.proposalId) || compareDebitBankAccounts(a, b);
}

/**
 * The answer for one card: the provider's stated account when a reading names
 * one, else the account of the newest accepted settlement, else unknown.
 * `settled` and `proposed` are the card's accepted and undecided candidates
 * per bank account, in any order.
 */
export function answerCardDebitAccount(
  stated: StatedDebitAccount,
  settled: readonly MatchedDebitAccount[],
  proposed: readonly MatchedDebitAccount[],
): CardDebitAccountAnswer {
  const newestSettled = [...settled].sort(compareMatchedDebitAccounts)[0] ?? null;
  const lastNamed = stated.lastNamed;
  if (lastNamed !== null) {
    const account = lastNamed.accounts[0]!;
    const codes: CardDebitAccountAnswerCode[] = [];
    if (newestSettled !== null && !sameAccount(newestSettled, account))
      codes.push("settled_account_differs");
    if (stated.latest?.readingRef.id !== lastNamed.readingRef.id)
      codes.push("newer_reading_unresolved");
    return {
      basis: "provider-stated",
      account: { bankSourceId: account.bankSourceId, bankSourceAccount: account.bankSourceAccount },
      readingRef: lastNamed.readingRef,
      observedAt: lastNamed.observedAt,
      codes,
    };
  }
  if (newestSettled !== null) {
    const codes: CardDebitAccountAnswerCode[] = [];
    if (settled.length > 1) codes.push("settled_accounts_differ");
    if (stated.status === "conflicting") codes.push("stated_reading_conflicting");
    return {
      basis: "accepted-settlement",
      account: {
        bankSourceId: newestSettled.bankSourceId,
        bankSourceAccount: newestSettled.bankSourceAccount,
      },
      proposalId: newestSettled.latest.proposalId,
      debitDate: newestSettled.latest.debitDate,
      codes,
    };
  }
  if (stated.status === "conflicting")
    return { basis: "unknown", reason: "stated_reading_conflicting" };
  if (proposed.length > 0) return { basis: "unknown", reason: "only_unreviewed_candidates" };
  return { basis: "unknown", reason: "no_debit_account_evidence" };
}
