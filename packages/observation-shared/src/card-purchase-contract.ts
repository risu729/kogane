// The wire shape of `GET /api/v2/card-purchases`. Shape only: the client never
// recalculates a figure, and a response that adds a combined total, calls a
// settlement a purchase expense or claims complete history is refused rather
// than displayed.
import {
  CARD_PURCHASE_ACTIONS,
  CARD_PURCHASE_SOURCES,
  CARD_USAGE_EXCLUSIONS,
} from "../../domain/src/card-purchase.ts";
import {
  CARD_PURCHASE_STATEMENT_REASONS,
  type CardPurchasePage,
} from "../../domain/src/card-purchase-view.ts";
import {
  EVENT_STATES,
  UNKNOWN_STATE_REASONS,
  validSourceFactRef,
} from "../../domain/src/events.ts";
import {
  PENDING_POSTED_ACTIONS,
  PENDING_POSTED_BLOCKERS,
  PENDING_POSTED_RELATION_KIND,
  pendingPostedRelation,
} from "../../domain/src/pending-posted-review.ts";
import {
  PROPOSAL_STATUSES,
  RATIONALE_CODES,
  REJECTION_CONDITION_CODES,
} from "../../domain/src/reconcile.ts";
import { validLocalDateText, validTemporalValue } from "../../domain/src/time.ts";
import { validQuantity } from "../../domain/src/values.ts";

const CARD_PURCHASE_PAGE_LIMIT = 50;
const CARD_PURCHASE_HISTORY_LIMIT = 20;
const CARD_PURCHASE_CANDIDATE_LIMIT = 10;
const EVENT_ID = /^(?:purchase|refund)_[0-9a-f]{64}$/u;
const PERIOD = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/u;
const UNIT_KEYS = ["unitRef", "captured", "authorized", "capturedRefunds", "authorizedRefunds"];
const SUMMARY_KEYS = [
  "units",
  "unresolved",
  "events",
  "statementTotals",
  "settlementAddsPurchaseExpense",
];
const STATEMENT_TOTAL_KEYS = ["sourceId", "accountId", "period", "ref", "total"];
const COVERAGE_KEYS = [
  "scope",
  "completeTransactionHistory",
  "unsupportedShapes",
  "unrecognizedCurrentRows",
  "limit",
];
const ITEM_KEYS = [
  "eventId",
  "revision",
  "kind",
  "state",
  "unknownReason",
  "sourceId",
  "accountId",
  "usageDate",
  "statementPeriod",
  "amount",
  "lastKnownAmount",
  "sourceRows",
  "statement",
  "settlement",
  "history",
  "historyTruncated",
  "candidates",
  "explanationRefs",
];
const CANDIDATE_KEYS = [
  "proposalId",
  "proposalStatus",
  "proposalRevision",
  "relationStatus",
  "relationRevision",
  "providerLinked",
  "rationaleCodes",
  "rejectionConditions",
  "pending",
  "posted",
  "actions",
  "blockers",
  "relation",
];
const CANDIDATE_SIDE_KEYS = ["ref", "eventId", "revision", "state", "displayedAmount", "usageDate"];
const RELATION_KEYS = ["relationKind", "fromRef", "toRef", "validFrom", "validTo", "evidenceRefs"];

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/**
 * Exactly these fields: a figure the contract does not name (a combined
 * total, a statement-versus-purchases difference) is refused, not ignored.
 */
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const member =
  (choices: readonly string[]) =>
  (value: unknown): boolean =>
    text(value) && choices.includes(value);
const list = (value: unknown, bound: number): value is unknown[] =>
  Array.isArray(value) && value.length <= bound;
const period = (value: unknown) => text(value) && PERIOD.test(value);
const nullableQuantity = (value: unknown) => value === null || validQuantity(value);

function validSourceRow(value: unknown): boolean {
  return (
    record(value) &&
    member(["posted", "pending"])(value.role) &&
    validSourceFactRef(value.ref) &&
    nullableText(value.usageDate) &&
    nullableText(value.counterparty) &&
    typeof value.current === "boolean" &&
    nullableText(value.rawLocator)
  );
}

function validStatement(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.status === "unlinked")
    return (
      exactKeys(value, ["status", "reasonCode"]) &&
      member(CARD_PURCHASE_STATEMENT_REASONS)(value.reasonCode)
    );
  return (
    value.status === "linked" &&
    exactKeys(value, ["status", "ref", "period", "paymentDate", "providerTotal"]) &&
    validSourceFactRef(value.ref) &&
    period(value.period) &&
    validTemporalValue(value.paymentDate) &&
    validQuantity(value.providerTotal)
  );
}

function validSettlement(value: unknown): boolean {
  if (value === null) return true;
  if (
    !record(value) ||
    !exactKeys(value, [
      "proposalId",
      "reviewStatus",
      "decisionRevisionId",
      "settlementEventId",
      "allocationId",
      "bankDebit",
    ]) ||
    !text(value.proposalId) ||
    !member(["proposed", "accepted", "rejected", "withdrawn"])(value.reviewStatus) ||
    ![value.decisionRevisionId, value.settlementEventId, value.allocationId].every(nullableText)
  )
    return false;
  // Only an accepted review carries its settlement event, allocation and bank
  // debit; every decided review names its decision, a proposed one none.
  const accepted = value.reviewStatus === "accepted";
  if (
    (value.reviewStatus === "proposed") !== (value.decisionRevisionId === null) ||
    accepted !== (value.settlementEventId !== null) ||
    accepted !== (value.allocationId !== null) ||
    accepted !== (value.bankDebit !== null)
  )
    return false;
  const debit = value.bankDebit;
  return (
    debit === null ||
    (record(debit) &&
      exactKeys(debit, ["ref", "sourceId", "amount", "occurred"]) &&
      validSourceFactRef(debit.ref) &&
      text(debit.sourceId) &&
      validQuantity(debit.amount) &&
      validTemporalValue(debit.occurred))
  );
}

function validHistoryEntry(value: unknown): boolean {
  return (
    record(value) &&
    count(value.revision) &&
    value.revision > 0 &&
    member(CARD_PURCHASE_ACTIONS)(value.action) &&
    member(EVENT_STATES)(value.state) &&
    (value.unknownReason === null || member(UNKNOWN_STATE_REASONS)(value.unknownReason)) &&
    text(value.decisionRevisionId) &&
    text(value.createdAt)
  );
}

function validCandidateSide(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, CANDIDATE_SIDE_KEYS)) return false;
  // A side names its live event with that event's revision and state, or none of them.
  const held = value.eventId !== null;
  return (
    validSourceFactRef(value.ref) &&
    (held ? text(value.eventId) && EVENT_ID.test(value.eventId) : true) &&
    (held ? count(value.revision) && value.revision > 0 : value.revision === null) &&
    (held ? member(EVENT_STATES)(value.state) : value.state === null) &&
    nullableQuantity(value.displayedAmount) &&
    (value.usageDate === null || validLocalDateText(value.usageDate))
  );
}

const distinct = (value: readonly unknown[]): boolean => new Set(value).size === value.length;

function validCandidate(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, CANDIDATE_KEYS)) return false;
  const relation = value.relation;
  if (
    !text(value.proposalId) ||
    !member(PROPOSAL_STATUSES)(value.proposalStatus) ||
    !count(value.proposalRevision) ||
    !(
      value.relationStatus === null ||
      member(["proposed", "accepted", "rejected", "released"])(value.relationStatus)
    ) ||
    !count(value.relationRevision) ||
    typeof value.providerLinked !== "boolean" ||
    !list(value.rationaleCodes, RATIONALE_CODES.length) ||
    !value.rationaleCodes.every(member(RATIONALE_CODES)) ||
    !list(value.rejectionConditions, REJECTION_CONDITION_CODES.length) ||
    !value.rejectionConditions.every(member(REJECTION_CONDITION_CODES)) ||
    !validCandidateSide(value.pending) ||
    !validCandidateSide(value.posted) ||
    !list(value.actions, PENDING_POSTED_ACTIONS.length) ||
    !value.actions.every(member(PENDING_POSTED_ACTIONS)) ||
    !distinct(value.actions) ||
    !list(value.blockers, PENDING_POSTED_BLOCKERS.length) ||
    !value.blockers.every(member(PENDING_POSTED_BLOCKERS)) ||
    !distinct(value.blockers) ||
    !record(relation) ||
    !exactKeys(relation, RELATION_KEYS) ||
    relation.relationKind !== PENDING_POSTED_RELATION_KIND ||
    relation.validFrom !== null ||
    relation.validTo !== null ||
    !list(relation.evidenceRefs, 3) ||
    !relation.evidenceRefs.every(text)
  )
    return false;
  // The payload a review plans is exactly the one the proposal's targets give:
  // a client never builds the relation ends or the evidence itself.
  const pending = value.pending as { ref: Parameters<typeof pendingPostedRelation>[1] };
  const posted = value.posted as { ref: Parameters<typeof pendingPostedRelation>[2] };
  const expected = pendingPostedRelation(value.proposalId, pending.ref, posted.ref);
  const evidence: readonly unknown[] = relation.evidenceRefs;
  return (
    expected !== null &&
    relation.fromRef === expected.fromRef &&
    relation.toRef === expected.toRef &&
    evidence.length === expected.evidenceRefs.length &&
    expected.evidenceRefs.every((ref, index) => evidence[index] === ref)
  );
}

function validItem(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ITEM_KEYS)) return false;
  const unknown = value.state === "unknown";
  return (
    text(value.eventId) &&
    EVENT_ID.test(value.eventId) &&
    count(value.revision) &&
    value.revision > 0 &&
    member(["purchase", "refund"])(value.kind) &&
    member(EVENT_STATES)(value.state) &&
    (unknown ? member(UNKNOWN_STATE_REASONS)(value.unknownReason) : value.unknownReason === null) &&
    member(CARD_PURCHASE_SOURCES)(value.sourceId) &&
    text(value.accountId) &&
    validLocalDateText(value.usageDate) &&
    (value.statementPeriod === null || period(value.statementPeriod)) &&
    // An unresolved event has no live leg, so it has no amount to add.
    (unknown ? value.amount === null : validQuantity(value.amount)) &&
    nullableQuantity(value.lastKnownAmount) &&
    list(value.sourceRows, 10) &&
    value.sourceRows.every(validSourceRow) &&
    validStatement(value.statement) &&
    validSettlement(value.settlement) &&
    // A settlement is reached only through a linked statement.
    (value.settlement === null ||
      (record(value.statement) && value.statement.status === "linked")) &&
    list(value.history, CARD_PURCHASE_HISTORY_LIMIT) &&
    value.history.every(validHistoryEntry) &&
    typeof value.historyTruncated === "boolean" &&
    list(value.candidates, CARD_PURCHASE_CANDIDATE_LIMIT) &&
    value.candidates.every(validCandidate) &&
    list(value.explanationRefs, 100) &&
    value.explanationRefs.every(text)
  );
}

/** Validate the wire shape only. Financial figures are never recalculated by a client. */
export function validCardPurchasePage(value: unknown): value is CardPurchasePage {
  if (
    !record(value) ||
    !list(value.items, CARD_PURCHASE_PAGE_LIMIT) ||
    !(value.nextOffset === null || count(value.nextOffset)) ||
    !record(value.summary) ||
    !exactKeys(value.summary, SUMMARY_KEYS) ||
    !record(value.coverage) ||
    !exactKeys(value.coverage, COVERAGE_KEYS)
  )
    return false;
  const { summary, coverage } = value;
  return (
    // Per unit, states apart: a unit that carries any other field (a combined
    // total, a difference) is refused.
    list(summary.units, 100) &&
    summary.units.every(
      (unit) =>
        record(unit) &&
        exactKeys(unit, UNIT_KEYS) &&
        text(unit.unitRef) &&
        [unit.captured, unit.authorized, unit.capturedRefunds, unit.authorizedRefunds].every(
          validQuantity,
        ),
    ) &&
    count(summary.unresolved) &&
    count(summary.events) &&
    list(summary.statementTotals, 1000) &&
    summary.statementTotals.every(
      (entry) =>
        record(entry) &&
        exactKeys(entry, STATEMENT_TOTAL_KEYS) &&
        member(CARD_PURCHASE_SOURCES)(entry.sourceId) &&
        text(entry.accountId) &&
        period(entry.period) &&
        validSourceFactRef(entry.ref) &&
        validQuantity(entry.total),
    ) &&
    summary.settlementAddsPurchaseExpense === false &&
    coverage.scope === "card-purchase-recognition" &&
    coverage.completeTransactionHistory === false &&
    list(coverage.unsupportedShapes, CARD_USAGE_EXCLUSIONS.length) &&
    coverage.unsupportedShapes.every(member(CARD_USAGE_EXCLUSIONS)) &&
    count(coverage.unrecognizedCurrentRows) &&
    coverage.limit === CARD_PURCHASE_PAGE_LIMIT &&
    value.items.every(validItem)
  );
}
