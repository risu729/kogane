// The wire shape of `GET /api/v2/reconciliation/card-statements-unmatched`
// (docs/card-settlements.md, Statements without a candidate), checked by the
// browser before it renders the list. Every code is checked against the
// domain's closed lists, so the page never shows a reason it does not know
// as if it did; the client recomputes nothing.
import {
  ALLOCATION_OUTCOME_CODES,
  ALLOCATION_STATEMENT_REFUSALS,
  CARD_STATEMENT_ALLOCATION_DEBITS_MAX,
  CARD_STATEMENT_ALLOCATION_SIZE_MAX,
} from "../../domain/src/card-settlement-allocation.ts";
import { UNMATCHED_STATEMENT_CODES } from "../../domain/src/card-settlement-unmatched.ts";
import { validSourceFactRef } from "../../domain/src/events.ts";
import { validTemporalValue } from "../../domain/src/time.ts";
import { validQuantity } from "../../domain/src/values.ts";

/** The path the browser reads the list from. */
export const CARD_STATEMENTS_UNMATCHED_PATH = "/api/v2/reconciliation/card-statements-unmatched";
const PAGE_LIMIT = 50;
/** `n` choose `k`, exact for the small bounds below. */
const choose = (n: number, k: number): number => (k === 0 ? 1 : (choose(n - 1, k - 1) * n) / k);
/**
 * Allocations one statement's planner answer may list: the planner lists
 * every exact allocation of one to `CARD_STATEMENT_ALLOCATION_SIZE_MAX`
 * debits among at most `CARD_STATEMENT_ALLOCATION_DEBITS_MAX`, uncapped, so
 * the bound is the number of such debit sets (5,488).
 */
export const UNMATCHED_ALLOCATIONS_LIMIT = Array.from(
  { length: CARD_STATEMENT_ALLOCATION_SIZE_MAX },
  (_, index) => choose(CARD_STATEMENT_ALLOCATION_DEBITS_MAX, index + 1),
).reduce((sum, value) => sum + value, 0);

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): boolean => value === null || text(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const oneOf = (values: readonly string[], value: unknown): boolean =>
  text(value) && values.includes(value);

function validPlanner(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value)) return false;
  if (value.status === "run_refused") return value.code === "input_bound_exceeded";
  if (value.status === "refused") return oneOf(ALLOCATION_STATEMENT_REFUSALS, value.code);
  return (
    oneOf(["proposed", "needs_review", "unsupported"], value.status) &&
    Array.isArray(value.codes) &&
    value.codes.every((code: unknown) => oneOf(ALLOCATION_OUTCOME_CODES, code)) &&
    Array.isArray(value.allocations) &&
    value.allocations.length <= UNMATCHED_ALLOCATIONS_LIMIT &&
    value.allocations.every(
      (allocation: unknown) =>
        record(allocation) &&
        oneOf(["single-debit", "multiple-debits"], allocation.kind) &&
        oneOf(["established-same", "unknown", "different"], allocation.ownership) &&
        Array.isArray(allocation.rejectionConditions) &&
        allocation.rejectionConditions.every(text) &&
        Array.isArray(allocation.members) &&
        allocation.members.length >= 1 &&
        allocation.members.length <= CARD_STATEMENT_ALLOCATION_SIZE_MAX &&
        allocation.members.every(
          (member: unknown) =>
            record(member) &&
            validSourceFactRef(member.ref) &&
            text(member.sourceId) &&
            text(member.sourceAccount) &&
            nullableText(member.accountId) &&
            validQuantity(member.amount),
        ),
    )
  );
}

/** Validate the wire shape only. */
export function validUnmatchedCardStatementsReview(value: unknown): boolean {
  if (
    !record(value) ||
    value.schemaVersion !== "kogane-card-statements-unmatched-v1" ||
    !record(value.manifest) ||
    value.manifest.acceptance !== "single-debit-candidates-only" ||
    !Array.isArray(value.items) ||
    value.items.length > PAGE_LIMIT ||
    !(value.nextOffset === null || count(value.nextOffset))
  )
    return false;
  return value.items.every((item: unknown) => {
    if (!record(item) || !record(item.statement)) return false;
    const statement = item.statement;
    return (
      validSourceFactRef(statement.ref) &&
      text(statement.sourceId) &&
      text(statement.sourceAccount) &&
      nullableText(statement.accountId) &&
      nullableText(statement.period) &&
      (statement.amount === null || validQuantity(statement.amount)) &&
      (statement.paymentDate === null || validTemporalValue(statement.paymentDate)) &&
      oneOf(UNMATCHED_STATEMENT_CODES, item.code) &&
      (item.debitsInWindow === null || count(item.debitsInWindow)) &&
      item.acceptable === false &&
      validPlanner(item.planner)
    );
  });
}
