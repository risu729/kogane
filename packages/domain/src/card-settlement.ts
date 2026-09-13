// Statement payment and observed bank debit correspondence. Matching only
// proposes a review; approval never follows from amount/date similarity.
import { validSourceFactRef, type SourceFactRef } from "./events.ts";
import { daysBetween, parseLocalDate, validTemporalValue, type TemporalValue } from "./time.ts";
import {
  compareQuantities,
  exactQuantity,
  integerDecimal,
  validQuantity,
  type Quantity,
} from "./values.ts";

export interface CardStatementFact {
  ref: SourceFactRef;
  sourceId: "vpass" | "myjcb";
  sourceAccount: string;
  accountId: string | null;
  ownerRef: string | null;
  /** Provider's authoritative payment total; never the sum of purchase rows. */
  amount: Quantity;
  paymentDate: TemporalValue;
  period: string | null;
}
export interface CardBankDebitFact {
  ref: SourceFactRef;
  sourceId: string;
  sourceAccount: string;
  accountId: string | null;
  ownerRef: string | null;
  /** Positive magnitude of a verified debit, not an unsigned unknown movement. */
  amount: Quantity;
  occurred: TemporalValue;
}
export type CardSettlementStatus = "proposed" | "accepted" | "rejected" | "withdrawn";
export interface CardSettlementFacts {
  statement: CardStatementFact;
  bankDebit: CardBankDebitFact;
  rationaleCodes: string[];
  rejectionConditions: string[];
  ownership: "established-same" | "unknown" | "different";
  ownershipEvidenceRefs: string[];
  /** The payment total does not tell us which part, if any, is a fee. */
  feeBreakdown: "unknown";
}
export interface CardSettlementReview {
  proposalId: string;
  revision: number;
  status: CardSettlementStatus;
  facts: CardSettlementFacts;
  decisionRevisionId: string | null;
  eventId: string | null;
  obligationId: string | null;
  settlementId: string | null;
  createdAt: string;
}
export interface CardSettlementImpact {
  bankDebitAlreadyObserved: Quantity;
  addedCashMovement: Quantity;
  addedPurchaseExpense: Quantity;
  liabilityAllocation: Quantity;
  allocationState: "proposed" | "accepted" | "not-applied";
  feeBreakdown: "unknown";
  netWorthDelta: null;
  liabilityBalanceDelta: null;
}
export const CARD_SETTLEMENT_POLICY = "card-statement-settlement-v1";
export const CARD_SETTLEMENT_DAY_WINDOW = 3;

function positive(quantity: Quantity): boolean {
  return quantity.value.status === "exact" && BigInt(quantity.value.value.coefficient) > 0n;
}
function dateGap(a: TemporalValue, b: TemporalValue): number | null {
  if (!validTemporalValue(a) || !validTemporalValue(b)) return null;
  if (a.kind !== "local-date" || b.kind !== "local-date") return null;
  const first = parseLocalDate(a.value);
  const second = parseLocalDate(b.value);
  return first === null || second === null ? null : Math.abs(daysBetween(first, second));
}

/** Pure candidate filter: absent amount/date/direction is never filled in. */
export function cardSettlementCandidate(
  statement: CardStatementFact,
  bankDebit: CardBankDebitFact,
  ownershipEvidenceRefs: readonly string[] = [],
): CardSettlementFacts | null {
  if (
    !validQuantity(statement.amount) ||
    !validQuantity(bankDebit.amount) ||
    !positive(statement.amount) ||
    !positive(bankDebit.amount)
  )
    return null;
  const equality = compareQuantities(statement.amount, bankDebit.amount);
  if (!equality.ok || equality.order !== 0) return null;
  const gap = dateGap(statement.paymentDate, bankDebit.occurred);
  if (gap === null || gap > CARD_SETTLEMENT_DAY_WINDOW) return null;
  const ownership =
    statement.ownerRef === null || bankDebit.ownerRef === null
      ? "unknown"
      : statement.ownerRef === bankDebit.ownerRef
        ? "established-same"
        : "different";
  return {
    statement,
    bankDebit,
    rationaleCodes: [
      "authoritative_statement_total",
      "observed_bank_debit",
      "amount_equal",
      "date_within_window",
    ],
    rejectionConditions: [
      "statement_changed",
      "bank_debit_changed",
      "allocation_already_used",
      ...(ownership === "established-same"
        ? []
        : [ownership === "different" ? "owner_differs" : "owner_not_established"]),
    ],
    ownership,
    ownershipEvidenceRefs: [...ownershipEvidenceRefs],
    feeBreakdown: "unknown",
  };
}

/** Eligibility still needs fresh publication/ownership/allocation guards at commit. */
export function cardSettlementEligible(facts: CardSettlementFacts): boolean {
  return (
    facts.ownership === "established-same" &&
    facts.statement.accountId !== null &&
    facts.bankDebit.accountId !== null &&
    facts.statement.ownerRef !== null &&
    facts.statement.ownerRef === facts.bankDebit.ownerRef &&
    facts.ownershipEvidenceRefs.length > 0 &&
    cardSettlementCandidate(facts.statement, facts.bankDebit) !== null
  );
}

export function cardSettlementImpact(
  facts: CardSettlementFacts,
  status: CardSettlementStatus,
): CardSettlementImpact {
  const zero = exactQuantity(facts.statement.amount.unitRef, integerDecimal(0));
  return {
    bankDebitAlreadyObserved: facts.bankDebit.amount,
    addedCashMovement: zero,
    addedPurchaseExpense: zero,
    liabilityAllocation:
      status === "accepted" || status === "proposed" ? facts.statement.amount : zero,
    allocationState:
      status === "accepted" ? "accepted" : status === "proposed" ? "proposed" : "not-applied",
    feeBreakdown: "unknown",
    netWorthDelta: null,
    liabilityBalanceDelta: null,
  };
}

/** Fail closed on malformed stored facts instead of inventing a review amount. */
export function validCardSettlementFacts(value: unknown): value is CardSettlementFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const facts = value as CardSettlementFacts;
  const statement = facts.statement;
  const debit = facts.bankDebit;
  if (
    !statement ||
    !debit ||
    !validSourceFactRef(statement.ref) ||
    !validSourceFactRef(debit.ref) ||
    !validQuantity(statement.amount) ||
    !validQuantity(debit.amount) ||
    !validTemporalValue(statement.paymentDate) ||
    !validTemporalValue(debit.occurred) ||
    statement.ref.kind !== "balance" ||
    debit.ref.kind !== "transaction"
  )
    return false;
  if (statement.sourceId !== "vpass" && statement.sourceId !== "myjcb") return false;
  if (
    typeof statement.sourceAccount !== "string" ||
    typeof debit.sourceAccount !== "string" ||
    typeof debit.sourceId !== "string"
  )
    return false;
  if (
    ![statement.accountId, statement.ownerRef, debit.accountId, debit.ownerRef].every(
      (item) => item === null || typeof item === "string",
    )
  )
    return false;
  if (!(statement.period === null || typeof statement.period === "string")) return false;
  if (
    !["established-same", "unknown", "different"].includes(facts.ownership) ||
    facts.feeBreakdown !== "unknown"
  )
    return false;
  if (
    ![facts.rationaleCodes, facts.rejectionConditions, facts.ownershipEvidenceRefs].every(
      (items) => Array.isArray(items) && items.every((item) => typeof item === "string"),
    )
  )
    return false;
  return cardSettlementCandidate(statement, debit) !== null;
}
