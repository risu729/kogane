// Each card's next bill and whether the account it is debited from covers it
// (ADR 0114, 2026-11-19 amendment "upcoming bills"; docs/card-settlements.md,
// Upcoming bills). Pure: no storage, no clock. The application service
// (packages/application/src/query/card-upcoming-bills.ts) hands it each card's
// newest current statement and debit-account answer (ADR 0114) and each debit
// account's provider-reported balance (the reported state for the date, ADR
// 0019); this module decides which statements are bills, groups them by debit
// account and debit date, and answers `covers` with a closed reason when it
// cannot.
//
// - A bill is a card's newest current statement whose provider due date is
//   on or after the date (Asia/Tokyo) and whose total is not an exact zero
//   or below. Any other card is listed in `notListed` with a closed reason,
//   never as a zero bill (INV05). A refund total is never summed into a
//   line: it would offset other cards' bills the bank debits in full.
// - Amounts are added with `sumQuantities` and compared with
//   `compareQuantities`: exact decimals only, one unit only (INV03). A total
//   or a balance that is not exact makes `covers` `unknown`, never a guess.
// - Nothing here writes, adopts or proposes anything (INV07): `covers`
//   compares the bills Kogane knows with what the bank last reported.
import { refundOrZeroTotal } from "./card-settlement-unmatched.ts";
import { captureDate } from "./reported-state.ts";
import {
  compareQuantities,
  decimalToString,
  sumQuantities,
  type Quantity,
  type ValueStatus,
} from "./values.ts";

export const CARD_UPCOMING_BILLS_RULE = "card-upcoming-bills-v1";
export const CARD_UPCOMING_BILLS_SCHEMA = "kogane-card-upcoming-bills-v1";

/**
 * Why a card has no bill on the date:
 *
 * - `no_statement`: no current statement total (the card is known only from a
 *   debit-account reading or a settlement candidate);
 * - `payment_date_not_published`: its newest statement has no readable
 *   provider due date, so whether it is still to be paid is unknown;
 * - `no_statement_due`: its newest statement was due before the date;
 * - `statement_settled`: its newest statement is due on or after the date,
 *   but an accepted settlement already pays it;
 * - `statement_total_refund_or_zero`: its newest statement is due on or after
 *   the date with an exact total of zero or below (a refund, or nothing to
 *   pay; the code of `card-settlement-unmatched.ts`). Nothing is debited for
 *   it, and whether the bank credits a refund is not modelled, so it never
 *   offsets another card's bill. A total that is not exact has no known sign
 *   and stays a bill (`bill_not_exact`).
 */
export const NOT_LISTED_REASONS = [
  "no_statement",
  "payment_date_not_published",
  "no_statement_due",
  "statement_settled",
  "statement_total_refund_or_zero",
] as const;
export type NotListedReason = (typeof NOT_LISTED_REASONS)[number];

/**
 * Why `covers` is `unknown`, in this order:
 *
 * - `debit_account_unknown`: the line holds the bills whose debit account
 *   ADR 0114 does not answer;
 * - `unit_mismatch`: the bills counted on the line are in more than one
 *   unit, so they are not added (INV03; the code `sumQuantities` refuses
 *   them with);
 * - `bill_not_exact`: a bill counted on the line is not exact;
 * - `balance_not_exact`: the balance is not exact, or none was reported;
 * - `balance_before_previous_debit`: the balance was captured on or before
 *   the date of a card debit already due from the account, so it may not show
 *   that debit, or on the due date of a bill the line counts, so it may
 *   already show that debit and comparing it with the bill would count the
 *   debit twice (INV06);
 * - `cards_with_unknown_account`: a bill due on or before the line's date has
 *   no known debit account and might be debited from this one;
 * - `cards_with_unknown_due_date`: a card debited from this account, or from
 *   an unknown one, has a newest statement with no readable due date that no
 *   accepted settlement pays, so it might be debited by the line's date
 *   (INV05: its total is never left out as if it were zero).
 */
export const COVERS_UNKNOWN_REASONS = [
  "debit_account_unknown",
  "unit_mismatch",
  "bill_not_exact",
  "balance_not_exact",
  "balance_before_previous_debit",
  "cards_with_unknown_account",
  "cards_with_unknown_due_date",
] as const;
export type CoversUnknownReason = (typeof COVERS_UNKNOWN_REASONS)[number];
export const COVERS = ["yes", "no", "unknown"] as const;
type Covers = (typeof COVERS)[number];
/** Always on a debit-account line: other debits from the account are not known. */
export const UPCOMING_BILL_NOTES = ["other_debits_not_modelled"] as const;
/** The answer bases of ADR 0114, and `unknown`. */
export const UPCOMING_DEBIT_ANSWERS = [
  "provider-stated",
  "accepted-settlement",
  "unknown",
] as const;
export type UpcomingDebitAnswer = (typeof UPCOMING_DEBIT_ANSWERS)[number];

/** A quantity in the compact wire form: a decimal string, or the reason there is none. */
export type CompactQuantity =
  | { value: string; unit: string; status: "exact" }
  | { unit: string; status: Exclude<ValueStatus, "exact">; reason: string };

export function compactQuantity(quantity: Quantity): CompactQuantity {
  return quantity.value.status === "exact"
    ? { value: decimalToString(quantity.value.value), unit: quantity.unitRef, status: "exact" }
    : { unit: quantity.unitRef, status: quantity.value.status, reason: quantity.value.reasonCode };
}

/** The debit account one card's answer names, as the service resolved it. */
export interface UpcomingDebitAccount {
  answer: UpcomingDebitAnswer;
  /**
   * The line the bills of this account are grouped on: the account entity
   * when the reported state maps the bank source account to exactly one,
   * else the bank source account; null when the answer is `unknown`.
   */
  key: string | null;
  /** The account entity, when resolved. */
  account: string | null;
  /** The bank source account the answer names. */
  sourceAccount: string | null;
  label: string | null;
  /** The answer's own date: the stated page's capture date, or the accepted debit date. */
  since: string | null;
  /** ADR 0114's notes on a known answer, or its unknown reason. */
  codes: string[];
}

export interface UpcomingCardInput {
  card: { source: string; sourceAccount: string; label: string | null };
  /** The card's newest current statement (ADR 0114 `latestStatement`), or null. */
  statement: { period: string | null; paymentDate: string | null; amount: Quantity } | null;
  /** Periods an accepted settlement of the card covers (its newest per bank account). */
  settledPeriods: readonly string[];
  debitAccount: UpcomingDebitAccount;
}

export interface UpcomingAccountInput {
  /** The account's provider-reported balance in the bills' unit, or the reason there is none. */
  balance: Quantity;
  /** When the reported balance was captured; null when there is none. */
  capturedAt: string | null;
  /**
   * The latest card debit from the account due on or before the date, or
   * null. The service takes it from each card's newest accepted settlement
   * per bank account, each card's newest statement already due, and each
   * answered card's latest statement of an earlier month due by the date
   * (docs/card-settlements.md, Upcoming bills).
   */
  previousDebit: string | null;
}

interface UpcomingBill {
  card: UpcomingCardInput["card"];
  statementPeriod: string | null;
  debitDate: string;
  amount: CompactQuantity;
  debitAccount: Omit<UpcomingDebitAccount, "key">;
}

export interface UpcomingDebitAccountLine {
  account: string | null;
  sourceAccount: string | null;
  label: string | null;
  debitDate: string;
  /** Bills to this account due on or before `debitDate` (from the date on). */
  bills: number;
  /** Their sum; not exact when one of them is not, or when they are in two units. */
  cardBills: CompactQuantity;
  /** Null on the line of bills with no known debit account. */
  balance: (CompactQuantity & { capturedAt: string | null }) | null;
  covers: Covers;
  reasons: CoversUnknownReason[];
  notes: (typeof UPCOMING_BILL_NOTES)[number][];
}

interface NotListedCard {
  card: string;
  source: string;
  reason: NotListedReason;
  last: { period: string | null; debitDate: string | null } | null;
}

export interface UpcomingCardBills {
  bills: UpcomingBill[];
  byDebitAccount: UpcomingDebitAccountLine[];
  notListed: NotListedCard[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a card's newest statement is a bill on `date`, or why not. */
function billOrReason(
  input: UpcomingCardInput,
  date: string,
): { bill: true } | { bill: false; reason: NotListedReason } {
  const statement = input.statement;
  if (statement === null) return { bill: false, reason: "no_statement" };
  if (statement.paymentDate === null) return { bill: false, reason: "payment_date_not_published" };
  if (statement.paymentDate < date) return { bill: false, reason: "no_statement_due" };
  if (statement.period !== null && input.settledPeriods.includes(statement.period))
    return { bill: false, reason: "statement_settled" };
  if (refundOrZeroTotal(statement.amount))
    return { bill: false, reason: "statement_total_refund_or_zero" };
  return { bill: true };
}

/**
 * The bills on `date` (a `YYYY-MM-DD` civil date in Asia/Tokyo), one line
 * per debit account and debit date, and the cards with no bill. `accounts`
 * holds the balance of every key a card's debit account names.
 */
export function upcomingCardBills(input: {
  date: string;
  cards: readonly UpcomingCardInput[];
  accounts: ReadonlyMap<string, UpcomingAccountInput>;
}): UpcomingCardBills {
  const { date } = input;
  const listed: { card: UpcomingCardInput; debitDate: string; amount: Quantity }[] = [];
  const notListed: NotListedCard[] = [];
  // The debit-account keys (null: unknown) of cards whose newest statement
  // has no readable due date and is not paid by an accepted settlement.
  const undated: (string | null)[] = [];
  for (const card of input.cards) {
    const decided = billOrReason(card, date);
    if (
      !decided.bill &&
      decided.reason === "payment_date_not_published" &&
      !(card.statement!.period !== null && card.settledPeriods.includes(card.statement!.period))
    )
      undated.push(card.debitAccount.key);
    if (decided.bill)
      listed.push({
        card,
        debitDate: card.statement!.paymentDate!,
        amount: card.statement!.amount,
      });
    else
      notListed.push({
        card: card.card.sourceAccount,
        source: card.card.source,
        reason: decided.reason,
        last:
          card.statement === null
            ? null
            : { period: card.statement.period, debitDate: card.statement.paymentDate },
      });
  }
  listed.sort(
    (a, b) =>
      compareText(a.debitDate, b.debitDate) ||
      compareText(a.card.card.source, b.card.card.source) ||
      compareText(a.card.card.sourceAccount, b.card.card.sourceAccount),
  );
  const bills: UpcomingBill[] = listed.map(({ card, debitDate, amount }) => {
    const { key: _key, ...debitAccount } = card.debitAccount;
    return {
      card: card.card,
      statementPeriod: card.statement!.period,
      debitDate,
      amount: compactQuantity(amount),
      debitAccount,
    };
  });

  // One line per debit account and debit date, in date order; a line counts
  // every bill to its account due on or before its date, so a later line
  // never forgets an earlier debit from the same account.
  const lines = new Map<string, { key: string | null; debitDate: string }>();
  for (const { card, debitDate } of listed) {
    const key = card.debitAccount.key;
    lines.set(JSON.stringify([key, debitDate]), { key, debitDate });
  }
  const unknownDates = listed
    .filter(({ card }) => card.debitAccount.key === null)
    .map(({ debitDate }) => debitDate);
  const byDebitAccount = [...lines.values()]
    .sort(
      (a, b) =>
        compareText(a.debitDate, b.debitDate) ||
        (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) ||
        compareText(a.key ?? "", b.key ?? ""),
    )
    .map(({ key, debitDate }): UpcomingDebitAccountLine => {
      const counted = listed.filter(
        (bill) => bill.card.debitAccount.key === key && bill.debitDate <= debitDate,
      );
      const named = counted[0]!.card.debitAccount;
      const unit = counted[0]!.amount.unitRef;
      const reasons = new Set<CoversUnknownReason>();
      const sum = sumQuantities(
        unit,
        counted.map(({ amount }) => amount),
      );
      // Every reason that holds is named: bills in another unit than the
      // line's first (the code `sumQuantities` refuses them with), and bills
      // that are not exact. The sum's reason is the first of the two.
      const mixed = counted.some(({ amount }) => amount.unitRef !== unit);
      if (mixed) reasons.add("unit_mismatch");
      if (counted.some(({ amount }) => amount.value.status !== "exact"))
        reasons.add("bill_not_exact");
      const cardBills: CompactQuantity = sum.ok
        ? compactQuantity(sum.quantity)
        : { unit, status: "missing", reason: mixed ? "unit_mismatch" : "bill_not_exact" };
      let balance: UpcomingDebitAccountLine["balance"] = null;
      let order: -1 | 0 | 1 | null = null;
      if (key === null) reasons.add("debit_account_unknown");
      else {
        const account = input.accounts.get(key);
        if (account === undefined) throw new Error("upcoming_bill_account_missing");
        balance = { ...compactQuantity(account.balance), capturedAt: account.capturedAt };
        if (account.balance.value.status !== "exact" || account.balance.unitRef !== unit)
          reasons.add("balance_not_exact");
        const captured = account.capturedAt === null ? null : captureDate(account.capturedAt);
        // A capture time with no capture date cannot be placed against the
        // previous debit or a bill's due date, so it is refused rather than
        // compared as if it came after them.
        if (account.capturedAt !== null && captured === null)
          throw new Error("invalid_capture_time");
        // A balance captured on a counted bill's own due date (only the date
        // itself: no capture is later) may come before or after the bank
        // takes it; compared with that bill, a capture after it would count
        // the debit twice (INV06).
        if (
          captured !== null &&
          ((account.previousDebit !== null && captured <= account.previousDebit) ||
            counted.some((bill) => bill.debitDate === captured))
        )
          reasons.add("balance_before_previous_debit");
        if (unknownDates.some((unknown) => unknown <= debitDate))
          reasons.add("cards_with_unknown_account");
        if (undated.some((other) => other === null || other === key))
          reasons.add("cards_with_unknown_due_date");
        if (sum.ok && reasons.size === 0) {
          const compared = compareQuantities(account.balance, sum.quantity);
          if (compared.ok) order = compared.order;
          else reasons.add("balance_not_exact");
        }
      }
      return {
        account: named.account,
        sourceAccount: named.sourceAccount,
        label: named.label,
        debitDate,
        bills: counted.length,
        cardBills,
        balance,
        covers: order === null || reasons.size > 0 ? "unknown" : order >= 0 ? "yes" : "no",
        reasons: COVERS_UNKNOWN_REASONS.filter((reason) => reasons.has(reason)),
        notes: [...UPCOMING_BILL_NOTES],
      };
    });
  notListed.sort((a, b) => compareText(a.source, b.source) || compareText(a.card, b.card));
  return { bills, byDebitAccount, notListed };
}
