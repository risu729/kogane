// Read-only rule assessment (ADR 0034). A verdict is never an acceptance.
// A future writer must independently verify policy authorization, source
// revisions and allocation availability inside its atomic write.
import { cardSettlementEligible, type CardSettlementFacts } from "./card-settlement.ts";
import type { BankAccountReference } from "./card-debit-account.ts";
import { parseLocalDate } from "./time.ts";

export const CARD_SETTLEMENT_AUTOMATION_POLICY = "card-settlement-automation-shadow-v1";

export interface SettlementAutomationScope {
  /** Reference to an owner-authorized policy, verified by the caller. */
  authorizationRef: string;
  cardAccountId: string;
  bankAccountId: string;
  validFrom: string;
  validTo: string | null;
  bank: { sourceId: string; accountType: string; branchCode: string; accountNumber: string };
}

export interface SettlementAutomationCandidate {
  statementKey: string;
  bankKey: string;
  facts: CardSettlementFacts;
  sourceCurrent: boolean;
  ownershipCurrent: boolean;
  allocationAvailable: boolean;
  /** Includes rejected/withdrawn decisions on other revisions of this pair. */
  priorDecision: boolean;
  bankAccount: BankAccountReference;
  /** Entire matching window acquired, not merely one matching transaction. */
  windowComplete: boolean;
  providerAccountEvidence: "supports" | "conflicts" | "unknown" | "absent";
}

export type SettlementAutomationBlocker =
  | "scope_not_authorized"
  | "outside_authorized_scope"
  | "source_not_current"
  | "ownership_not_established"
  | "bank_account_number_missing"
  | "bank_account_scope_mismatch"
  | "bank_account_evidence_mismatch"
  | "acquisition_incomplete"
  | "candidate_set_incomplete"
  | "statement_has_multiple_debits"
  | "debit_has_multiple_statements"
  | "allocation_unavailable"
  | "prior_decision"
  | "provider_account_conflict"
  | "provider_account_unresolved";

/** Only current source facts participate in competition. Peer keys must use
 * resolved card + payment month and the adapter's durable debit key. Duplicate
 * proposal revisions cannot manufacture a second payment. */
export function assessSettlementAutomation(
  candidate: SettlementAutomationCandidate,
  peers: readonly SettlementAutomationCandidate[],
  options: { complete: boolean; scope: SettlementAutomationScope | null },
): {
  policy: typeof CARD_SETTLEMENT_AUTOMATION_POLICY;
  outcome: "would_accept" | "blocked";
  blockers: SettlementAutomationBlocker[];
} {
  const blockers: SettlementAutomationBlocker[] = [];
  const { facts } = candidate;
  const scope = options.scope;
  if (scope === null || scope.authorizationRef.trim() === "") blockers.push("scope_not_authorized");
  else {
    const date = facts.statement.paymentDate;
    if (
      facts.statement.accountId !== scope.cardAccountId ||
      facts.bankDebit.accountId !== scope.bankAccountId ||
      date.kind !== "local-date" ||
      parseLocalDate(scope.validFrom) === null ||
      (scope.validTo !== null &&
        (parseLocalDate(scope.validTo) === null || scope.validTo < scope.validFrom)) ||
      (date.kind === "local-date" &&
        (date.value < scope.validFrom || (scope.validTo !== null && date.value > scope.validTo)))
    )
      blockers.push("outside_authorized_scope");
  }
  if (!candidate.sourceCurrent) blockers.push("source_not_current");
  if (!candidate.ownershipCurrent || !cardSettlementEligible(facts))
    blockers.push("ownership_not_established");
  const bank = candidate.bankAccount;
  if (!bank.comparable || bank.branchCode === null) blockers.push("bank_account_number_missing");
  else if (
    scope !== null &&
    (bank.sourceId !== scope.bank.sourceId ||
      bank.accountType !== scope.bank.accountType ||
      bank.branchCode !== scope.bank.branchCode ||
      bank.accountNumber !== scope.bank.accountNumber)
  )
    blockers.push("bank_account_scope_mismatch");
  if (
    bank.sourceId !== facts.bankDebit.sourceId ||
    bank.sourceAccount !== facts.bankDebit.sourceAccount ||
    (bank.comparable &&
      bank.sourceId === "smbc-bank" &&
      !bank.evidenceRefs?.some(
        (ref) =>
          ref.kind === facts.bankDebit.ref.kind &&
          ref.id === facts.bankDebit.ref.id &&
          ref.revision === facts.bankDebit.ref.revision,
      ))
  )
    blockers.push("bank_account_evidence_mismatch");
  if (!candidate.windowComplete) blockers.push("acquisition_incomplete");
  if (!options.complete) blockers.push("candidate_set_incomplete");
  const current = peers.filter((peer) => peer.sourceCurrent);
  if (
    !current.some(
      (peer) => peer.statementKey === candidate.statementKey && peer.bankKey === candidate.bankKey,
    )
  )
    if (!blockers.includes("candidate_set_incomplete")) blockers.push("candidate_set_incomplete");
  if (
    new Set(
      current
        .filter((peer) => peer.statementKey === candidate.statementKey)
        .map((peer) => peer.bankKey),
    ).size > 1
  )
    blockers.push("statement_has_multiple_debits");
  if (
    new Set(
      current.filter((peer) => peer.bankKey === candidate.bankKey).map((peer) => peer.statementKey),
    ).size > 1
  )
    blockers.push("debit_has_multiple_statements");
  if (!candidate.allocationAvailable) blockers.push("allocation_unavailable");
  if (
    candidate.priorDecision ||
    peers.some(
      (peer) =>
        peer.priorDecision &&
        peer.statementKey === candidate.statementKey &&
        peer.bankKey === candidate.bankKey,
    )
  )
    blockers.push("prior_decision");
  if (candidate.providerAccountEvidence === "conflicts") blockers.push("provider_account_conflict");
  if (candidate.providerAccountEvidence === "unknown") blockers.push("provider_account_unresolved");
  return {
    policy: CARD_SETTLEMENT_AUTOMATION_POLICY,
    outcome: blockers.length === 0 ? "would_accept" : "blocked",
    blockers,
  };
}
