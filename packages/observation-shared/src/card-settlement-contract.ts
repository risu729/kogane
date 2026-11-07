import type { CardSettlementReviewPage } from "../../domain/src/card-settlement-review.ts";
import { validQuantity } from "../../domain/src/values.ts";
import { validTemporalValue } from "../../domain/src/time.ts";
import { validSourceFactRef } from "../../domain/src/events.ts";
import { CARD_DEBIT_ACCOUNT_REASONS } from "../../domain/src/card-debit-account.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const texts = (value: unknown) => Array.isArray(value) && value.length <= 100 && value.every(text);
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const status = (value: unknown) =>
  ["proposed", "accepted", "rejected", "withdrawn"].includes(String(value));

/** The provider-stated debit-account evidence: read-only, never a blocker. */
function validDebitAccount(value: unknown): boolean {
  if (!record(value) || !text(value.policy)) return false;
  if (value.outcome === "absent")
    return (
      ["source_has_no_debit_account_statement", "evidence_not_recorded"].includes(
        String(value.reason),
      ) &&
      [
        value.statementRef,
        value.bankSourceId,
        value.bankSourceAccount,
        value.visibleDigitCount,
        value.recordedAt,
      ].every((field) => field === null)
    );
  if (!validSourceFactRef(value.statementRef) || !text(value.recordedAt)) return false;
  if (value.outcome === "not_proposed")
    return (
      (CARD_DEBIT_ACCOUNT_REASONS as readonly unknown[]).includes(value.reason) &&
      [value.bankSourceId, value.bankSourceAccount, value.visibleDigitCount].every(
        (field) => field === null,
      )
    );
  return (
    ["supports", "names_other_account"].includes(String(value.outcome)) &&
    value.reason === null &&
    text(value.bankSourceId) &&
    text(value.bankSourceAccount) &&
    typeof value.visibleDigitCount === "number" &&
    Number.isSafeInteger(value.visibleDigitCount) &&
    value.visibleDigitCount > 0
  );
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
      !record(row.facts) ||
      !record(row.impact) ||
      !Array.isArray(row.history) ||
      row.history.length > 20 ||
      typeof row.historyTruncated !== "boolean" ||
      !validDebitAccount(row.debitAccount) ||
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
