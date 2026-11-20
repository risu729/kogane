// The wire shape of `GET /api/v2/reconciliation/card-debit-accounts?view=upcoming`
// (docs/card-settlements.md, Upcoming bills; ADR 0114's 2026-11-19
// amendment), checked by the browser before it renders the `次回の引落`
// section. Every code is checked against the domain's closed lists, and each
// `covers` against the figures beside it, so the page never shows a yes or a
// no its own figures do not carry.
import {
  COVERS,
  COVERS_UNKNOWN_REASONS,
  NOT_LISTED_REASONS,
  UPCOMING_BILL_NOTES,
  UPCOMING_DEBIT_ANSWERS,
} from "../../domain/src/card-upcoming-bills.ts";
import { parseLocalDate } from "../../domain/src/time.ts";
import { compareDecimals, decimalFromString, VALUE_STATUSES } from "../../domain/src/values.ts";

const CARDS_LIMIT = 100;

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableText = (value: unknown): boolean => value === null || text(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value) &&
  parseLocalDate(value) !== null;
const nullableDate = (value: unknown): boolean => value === null || date(value);
const oneOf = (values: readonly string[], value: unknown): value is string =>
  typeof value === "string" && values.includes(value);
const codes = (values: readonly string[], value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((code) => oneOf(values, code)) &&
  // In the closed list's order, each once.
  value.join() === values.filter((code) => value.includes(code)).join();

/** A compact quantity: exact decimal text, or a status and a reason, never a zero. */
function validQuantity(value: unknown): value is Record<string, any> {
  if (!record(value) || !text(value.unit) || !oneOf(VALUE_STATUSES, value.status)) return false;
  return value.status === "exact"
    ? text(value.value) && decimalFromString(value.value).ok && !("reason" in value)
    : text(value.reason) && !("value" in value);
}

/** An exact bill is above zero: a refund or zero total is not a bill, so never netted. */
function positiveIfExact(value: Record<string, any>): boolean {
  if (value.status !== "exact") return true;
  const decimal = decimalFromString(value.value);
  return decimal.ok && BigInt(decimal.value.coefficient) > 0n;
}

function validBill(value: unknown, asked: string): boolean {
  if (!record(value) || !record(value.card) || !record(value.debitAccount)) return false;
  const account = value.debitAccount;
  const unknown = account.answer === "unknown";
  return (
    oneOf(["vpass", "myjcb"], value.card.source) &&
    text(value.card.sourceAccount) &&
    nullableText(value.card.label) &&
    nullableText(value.statementPeriod) &&
    date(value.debitDate) &&
    value.debitDate >= asked &&
    validQuantity(value.amount) &&
    positiveIfExact(value.amount) &&
    oneOf(UPCOMING_DEBIT_ANSWERS, account.answer) &&
    nullableText(account.account) &&
    nullableText(account.label) &&
    nullableDate(account.since) &&
    Array.isArray(account.codes) &&
    account.codes.every(text) &&
    (unknown
      ? account.account === null &&
        account.sourceAccount === null &&
        account.label === null &&
        account.since === null &&
        account.codes.length === 1
      : text(account.sourceAccount))
  );
}

/** `covers` agrees with its reasons and figures: yes or no only on exact figures. */
function validLine(value: unknown, asked: string): boolean {
  if (!record(value)) return false;
  const unknownAccount = value.account === null && value.sourceAccount === null;
  if (
    !nullableText(value.account) ||
    !nullableText(value.sourceAccount) ||
    !nullableText(value.label) ||
    !date(value.debitDate) ||
    value.debitDate < asked ||
    typeof value.bills !== "number" ||
    !Number.isSafeInteger(value.bills) ||
    value.bills < 1 ||
    !validQuantity(value.cardBills) ||
    !oneOf(COVERS, value.covers) ||
    !codes(COVERS_UNKNOWN_REASONS, value.reasons) ||
    !Array.isArray(value.notes) ||
    value.notes.join() !== UPCOMING_BILL_NOTES.join()
  )
    return false;
  if (unknownAccount !== value.reasons.includes("debit_account_unknown")) return false;
  if (unknownAccount) {
    if (value.balance !== null) return false;
  } else if (
    !validQuantity(value.balance) ||
    !nullableText(value.balance.capturedAt) ||
    (value.balance.status === "exact" && value.balance.capturedAt === null)
  )
    return false;
  if (value.covers === "unknown") return value.reasons.length > 0;
  if (
    value.reasons.length > 0 ||
    value.cardBills.status !== "exact" ||
    value.balance.status !== "exact" ||
    value.balance.unit !== value.cardBills.unit
  )
    return false;
  const balance = decimalFromString(value.balance.value);
  const bills = decimalFromString(value.cardBills.value);
  if (!balance.ok || !bills.ok) return false;
  return compareDecimals(balance.value, bills.value) >= 0 === (value.covers === "yes");
}

function validNotListed(value: unknown): boolean {
  return (
    record(value) &&
    text(value.card) &&
    oneOf(["vpass", "myjcb"], value.source) &&
    oneOf(NOT_LISTED_REASONS, value.reason) &&
    (value.reason === "no_statement"
      ? value.last === null
      : record(value.last) &&
        nullableText(value.last.period) &&
        nullableDate(value.last.debitDate) &&
        (value.reason === "payment_date_not_published") === (value.last.debitDate === null))
  );
}

/** Validate the wire shape of the upcoming view. */
export function validUpcomingCardBills(value: unknown): boolean {
  return (
    record(value) &&
    value.schemaVersion === "kogane-card-upcoming-bills-v1" &&
    value.view === "upcoming" &&
    date(value.date) &&
    value.zone === "Asia/Tokyo" &&
    Array.isArray(value.rules) &&
    value.rules.join() === "card-upcoming-bills-v1,card-debit-account-answer-v1" &&
    value.cardsMax === CARDS_LIMIT &&
    typeof value.cardsTruncated === "boolean" &&
    Array.isArray(value.bills) &&
    Array.isArray(value.notListed) &&
    value.bills.length + value.notListed.length <= CARDS_LIMIT &&
    value.bills.every((bill: unknown) => validBill(bill, value.date)) &&
    Array.isArray(value.byDebitAccount) &&
    value.byDebitAccount.every((line: unknown) => validLine(line, value.date)) &&
    // Every bill is counted on a line of its account and date.
    value.bills.every((bill: Record<string, any>) =>
      value.byDebitAccount.some(
        (line: Record<string, any>) =>
          line.debitDate === bill.debitDate &&
          line.account === bill.debitAccount.account &&
          // A line of an account entity may name another of its source accounts.
          (bill.debitAccount.account !== null ||
            line.sourceAccount === bill.debitAccount.sourceAccount),
      ),
    ) &&
    value.notListed.every(validNotListed)
  );
}
