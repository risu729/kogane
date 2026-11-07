import {
  CARD_DEBIT_ACCOUNT_STATEMENT_REFUSALS,
  SOURCE_STATES_NO_DEBIT_ACCOUNT,
  type CardSettlementReviewPage,
} from "../../domain/src/card-settlement-review.ts";
import { CARD_DEBIT_ACCOUNT_REASONS } from "../../domain/src/card-debit-account.ts";
import { validQuantity } from "../../domain/src/values.ts";
import { validTemporalValue } from "../../domain/src/time.ts";
import { validSourceFactRef } from "../../domain/src/events.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const texts = (value: unknown) => Array.isArray(value) && value.length <= 100 && value.every(text);
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const status = (value: unknown) =>
  ["proposed", "accepted", "rejected", "withdrawn"].includes(String(value));

const oneOf = (values: readonly string[], value: unknown) =>
  typeof value === "string" && values.includes(value);
const DEBIT_ACCOUNT_KEYS = [
  "bankSourceAccount",
  "bankSourceId",
  "outcome",
  "policy",
  "reason",
  "recordedAt",
  "visibleDigitCount",
];

/**
 * The provider-stated debit account of one review (ADR 0032): every key
 * present, and each outcome with exactly the values it carries, its reason
 * from its own closed set.
 */
function validDebitAccount(value: unknown): boolean {
  if (!record(value) || Object.keys(value).sort().join() !== DEBIT_ACCOUNT_KEYS.join())
    return false;
  const named =
    text(value.bankSourceId) &&
    text(value.bankSourceAccount) &&
    value.bankSourceId.length > 0 &&
    value.bankSourceAccount.length > 0 &&
    typeof value.visibleDigitCount === "number" &&
    Number.isSafeInteger(value.visibleDigitCount) &&
    value.visibleDigitCount > 0;
  const unnamed =
    value.bankSourceId === null &&
    value.bankSourceAccount === null &&
    value.visibleDigitCount === null;
  const recorded = text(value.policy) && text(value.recordedAt);
  const unrecorded = value.policy === null && value.recordedAt === null;
  switch (value.outcome) {
    case "supports":
    case "names_other_account":
      return value.reason === null && named && recorded;
    case "not_proposed":
      return oneOf(CARD_DEBIT_ACCOUNT_REASONS, value.reason) && unnamed && recorded;
    case "statement_refused":
      return oneOf(CARD_DEBIT_ACCOUNT_STATEMENT_REFUSALS, value.reason) && unnamed && unrecorded;
    case "not_recorded":
      return value.reason === null && unnamed && unrecorded;
    case "not_stated_by_source":
      return value.reason === SOURCE_STATES_NO_DEBIT_ACCOUNT && unnamed && unrecorded;
    default:
      return false;
  }
}

/** Validate the wire shape only. Financial effects are never recalculated by a client. */
export function validCardSettlementReviewPage(value: unknown): value is CardSettlementReviewPage {
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextOffset === null || revision(value.nextOffset)) ||
    !record(value.coverage) ||
    value.coverage.scope !== "card-statement-bank-debit-candidates" ||
    value.coverage.completeTransactionHistory !== false ||
    value.coverage.netAssets !== "unknown" ||
    value.coverage.limit !== 50
  )
    return false;
  return value.items.every((row: unknown) => {
    if (
      !record(row) ||
      !text(row.proposalId) ||
      !revision(row.revision) ||
      !status(row.status) ||
      !texts(row.acceptanceBlockers) ||
      !validDebitAccount(row.debitAccount) ||
      !record(row.facts) ||
      !record(row.impact) ||
      !Array.isArray(row.history) ||
      row.history.length > 20 ||
      typeof row.historyTruncated !== "boolean" ||
      !text(row.createdAt) ||
      ![row.decisionRevisionId, row.eventId, row.obligationId, row.settlementId].every(nullableText)
    )
      return false;
    const facts = row.facts;
    const statement = facts.statement;
    const bank = facts.bankDebit;
    if (
      !record(statement) ||
      !record(bank) ||
      !["vpass", "myjcb"].includes(String(statement.sourceId)) ||
      // Only a Vpass statement states no debit account (ADR 0032).
      (statement.sourceId === "vpass") !==
        ((row.debitAccount as Record<string, unknown>).outcome === "not_stated_by_source") ||
      !text(bank.sourceId) ||
      ![statement.sourceAccount, bank.sourceAccount].every(text) ||
      ![
        statement.accountId,
        statement.ownerRef,
        bank.accountId,
        bank.ownerRef,
        statement.period,
      ].every(nullableText) ||
      !validSourceFactRef(statement.ref) ||
      !validSourceFactRef(bank.ref) ||
      !validQuantity(statement.amount) ||
      !validQuantity(bank.amount) ||
      !validTemporalValue(statement.paymentDate) ||
      !validTemporalValue(bank.occurred) ||
      !["established-same", "unknown", "different"].includes(String(facts.ownership)) ||
      ![facts.rationaleCodes, facts.rejectionConditions, facts.ownershipEvidenceRefs].every(
        texts,
      ) ||
      facts.feeBreakdown !== "unknown"
    )
      return false;
    const impact = row.impact;
    return (
      [
        impact.bankDebitAlreadyObserved,
        impact.addedCashMovement,
        impact.addedPurchaseExpense,
        impact.liabilityAllocation,
      ].every(validQuantity) &&
      ["proposed", "accepted", "not-applied"].includes(String(impact.allocationState)) &&
      impact.feeBreakdown === "unknown" &&
      impact.netWorthDelta === null &&
      impact.liabilityBalanceDelta === null &&
      row.history.every(
        (entry: unknown) =>
          record(entry) &&
          revision(entry.revision) &&
          entry.revision > 0 &&
          ["accepted", "rejected", "withdrawn"].includes(String(entry.status)) &&
          text(entry.decisionRevisionId) &&
          text(entry.createdAt),
      )
    );
  });
}
