// The wire shape of `GET /api/v2/reconciliation/card-debit-accounts`
// (docs/card-settlements.md, Debit account per card; ADR 0114), checked by the
// browser before it renders the cards. Every code is checked against the
// domain's closed lists, and every answer against the evidence beside it, so
// the page never shows an answer its own evidence does not carry; the client
// recomputes nothing.
import { CARD_DEBIT_ACCOUNT_REASONS } from "../../domain/src/card-debit-account.ts";
import {
  CARD_DEBIT_ACCOUNT_ANSWER_CODES,
  CARD_DEBIT_ACCOUNT_UNKNOWN_REASONS,
  STATED_ABSENT_REASONS,
} from "../../domain/src/card-debit-account-answer.ts";
import { validSourceFactRef } from "../../domain/src/events.ts";
import { validTemporalValue } from "../../domain/src/time.ts";
import { validQuantity } from "../../domain/src/values.ts";

/** The path the browser reads the cards from. */
export const CARD_DEBIT_ACCOUNTS_PATH = "/api/v2/reconciliation/card-debit-accounts";
const CARDS_LIMIT = 100;

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableText = (value: unknown): boolean => value === null || text(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const oneOf = (values: readonly string[], value: unknown): boolean =>
  typeof value === "string" && values.includes(value);
const codes = (values: readonly string[], value: unknown): boolean =>
  Array.isArray(value) && value.every((code) => oneOf(values, code));
const sameAccount = (a: Record<string, any>, b: Record<string, any>): boolean =>
  a.bankSourceId === b.bankSourceId && a.bankSourceAccount === b.bankSourceAccount;

const validAccount = (value: unknown): value is Record<string, any> =>
  record(value) && text(value.bankSourceId) && text(value.bankSourceAccount);

function validReading(value: unknown): value is Record<string, any> {
  return (
    record(value) &&
    validSourceFactRef(value.readingRef) &&
    value.readingRef.kind === "typed-claim" &&
    text(value.observedAt) &&
    Array.isArray(value.accounts) &&
    value.accounts.every(validAccount) &&
    (value.accounts.length === 0
      ? value.visibleDigitCount === null
      : positive(value.visibleDigitCount)) &&
    codes(CARD_DEBIT_ACCOUNT_REASONS, value.reasons)
  );
}

function validStated(value: unknown): value is Record<string, any> {
  if (!record(value)) return false;
  if (value.status === "absent")
    return (
      oneOf(STATED_ABSENT_REASONS, value.reason) &&
      value.latest === null &&
      value.lastNamed === null
    );
  if (value.reason !== null || !validReading(value.latest)) return false;
  if (
    value.lastNamed !== null &&
    !(validReading(value.lastNamed) && value.lastNamed.accounts.length === 1)
  )
    return false;
  const named = value.latest.accounts.length;
  return value.status === "named"
    ? named === 1 &&
        value.lastNamed !== null &&
        value.lastNamed.readingRef.id === value.latest.readingRef.id
    : value.status === "conflicting"
      ? named > 1
      : value.status === "not_named" && named === 0;
}

const validMatched = (value: unknown): boolean =>
  validAccount(value) &&
  positive(value.statements) &&
  record(value.latest) &&
  text(value.latest.proposalId) &&
  nullableText(value.latest.debitDate) &&
  nullableText(value.latest.period);

/** Exactly the notes whose condition holds, in the closed list's order. */
const exactCodes = (value: unknown, holds: Record<string, boolean>): boolean =>
  codes(CARD_DEBIT_ACCOUNT_ANSWER_CODES, value) &&
  (value as string[]).join() ===
    CARD_DEBIT_ACCOUNT_ANSWER_CODES.filter((code) => holds[code] === true).join();

/**
 * The answer, its notes and its unknown reason agree with the evidence beside
 * it: the client never decides an answer, and one the evidence does not carry
 * is refused, never shown.
 */
function validAnswer(value: unknown, item: Record<string, any>): boolean {
  if (!record(value)) return false;
  const stated = item.stated;
  const newestSettled = item.settled[0];
  if (value.basis === "unknown") {
    if (stated.lastNamed !== null || newestSettled !== undefined) return false;
    const reason =
      stated.status === "conflicting"
        ? "stated_reading_conflicting"
        : item.proposed.length > 0
          ? "only_unreviewed_candidates"
          : "no_debit_account_evidence";
    return oneOf(CARD_DEBIT_ACCOUNT_UNKNOWN_REASONS, value.reason) && value.reason === reason;
  }
  if (!validAccount(value.account)) return false;
  if (value.basis === "provider-stated")
    return (
      stated.lastNamed !== null &&
      sameAccount(value.account, stated.lastNamed.accounts[0]) &&
      validSourceFactRef(value.readingRef) &&
      value.readingRef.id === stated.lastNamed.readingRef.id &&
      value.observedAt === stated.lastNamed.observedAt &&
      exactCodes(value.codes, {
        settled_account_differs:
          newestSettled !== undefined && !sameAccount(newestSettled, value.account),
        newer_reading_unresolved: stated.latest.readingRef.id !== stated.lastNamed.readingRef.id,
      })
    );
  return (
    value.basis === "accepted-settlement" &&
    stated.lastNamed === null &&
    newestSettled !== undefined &&
    sameAccount(value.account, newestSettled) &&
    value.proposalId === newestSettled.latest.proposalId &&
    value.debitDate === newestSettled.latest.debitDate &&
    exactCodes(value.codes, {
      settled_accounts_differ: item.settled.length > 1,
      stated_reading_conflicting: stated.status === "conflicting",
    })
  );
}

/** Validate the wire shape only. */
export function validCardDebitAccountsReview(value: unknown): boolean {
  if (
    !record(value) ||
    value.schemaVersion !== "kogane-card-debit-accounts-v1" ||
    !record(value.manifest) ||
    !Array.isArray(value.manifest.bases) ||
    value.manifest.bases.join() !== "provider-stated,accepted-settlement" ||
    !Array.isArray(value.items) ||
    value.items.length > CARDS_LIMIT ||
    typeof value.cardsTruncated !== "boolean"
  )
    return false;
  return value.items.every((item: unknown) => {
    if (!record(item) || !record(item.card)) return false;
    const statement = item.latestStatement;
    return (
      oneOf(["vpass", "myjcb"], item.card.sourceId) &&
      text(item.card.sourceAccount) &&
      nullableText(item.card.accountId) &&
      (statement === null ||
        (record(statement) &&
          validSourceFactRef(statement.ref) &&
          nullableText(statement.period) &&
          (statement.paymentDate === null || validTemporalValue(statement.paymentDate)) &&
          (statement.amount === null || validQuantity(statement.amount)))) &&
      validStated(item.stated) &&
      Array.isArray(item.settled) &&
      item.settled.every(validMatched) &&
      Array.isArray(item.proposed) &&
      item.proposed.every(validMatched) &&
      validAnswer(item.answer, item)
    );
  });
}
