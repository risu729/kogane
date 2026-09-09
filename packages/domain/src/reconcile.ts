// Matching candidates (addendum 07 section 3). This module only ever produces
// *proposals*: a candidate set with the reasons it was proposed and the
// conditions that would reject it. It never returns an accepted relation, and
// it never merges two claims — acceptance is a decision recorded in the
// decision log (INV07).
//
// Stage A is duplicate evidence of the same provider row, stage B is a revision
// or a second display inside one provider, stage C is an economic
// correspondence across sources. Provider-identifier equality is only ever
// evaluated inside one identifier namespace: source, credential epoch and
// account namespace must all agree, because provider ids are reused and some
// are run-scoped.
import type { RelationKind } from "./decisions.ts";
import { hasExactKeys, isOneOf, isRecord, isRefList, isText } from "./guards.ts";
import { validSourceFactRef, type SourceFactRef } from "./events.ts";
import { daysBetween, parseLocalDate, type TemporalValue } from "./time.ts";
import { compareQuantities, type Quantity } from "./values.ts";

/**
 * The relation kinds a reconciliation proposal may ask for. Deliberately a
 * subset of `RelationKind`, so an accepted proposal can always become an
 * `entity_relations` row without widening that table's closed kind list.
 * Settlement is not here: it is a first-class `settlement_relations` row with
 * its own allocated amount, not a bare edge between two claims.
 */
export const RECONCILIATION_KINDS = [
  "provider_same",
  "pending_to_posted",
  "supersedes",
  "supports",
  "contradicts",
  "funded_by",
  "statement_covers",
] as const satisfies readonly RelationKind[];
export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number];

export const PROPOSAL_STAGES = ["A", "B", "C"] as const;
export type ProposalStage = (typeof PROPOSAL_STAGES)[number];
export const PROPOSAL_METHODS = ["rule", "manual", "ai"] as const;
export type ProposalMethod = (typeof PROPOSAL_METHODS)[number];
export const PROPOSAL_STATUSES = ["proposed", "accepted", "rejected", "withdrawn"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * Why a candidate was proposed. These are codes, not a score: a confidence
 * number is at most an ordering aid and is never evidence or authority
 * (addendum 07 section 3), so this module produces none.
 */
export const RATIONALE_CODES = [
  "provider_link_id_equal",
  "provider_identifier_equal",
  "collector_fingerprint_identifier",
  "same_identifier_namespace",
  "same_source_account",
  "same_statement_period",
  "amount_equal",
  "amount_opposite_sign",
  "date_within_window",
  "status_pending_to_posted",
  "counterparty_equal",
  "owner_established_self",
  "multiple_candidates",
  "no_provider_link_id",
] as const;
export type RationaleCode = (typeof RATIONALE_CODES)[number];

/** What must be re-checked before acceptance, and what would reject the candidate. */
export const REJECTION_CONDITION_CODES = [
  "identifier_namespace_differs",
  "credential_epoch_differs",
  "counterparty_differs",
  "amount_differs",
  "unit_differs",
  "owner_not_established",
  "date_outside_window",
  "provider_link_absent",
  "candidate_not_unique",
] as const;
export type RejectionConditionCode = (typeof REJECTION_CONDITION_CODES)[number];

export interface ReconciliationProposal {
  proposalId: string;
  kind: ReconciliationKind;
  stage: ProposalStage;
  /** The claims the proposal is about, in a stable order. */
  targetRefs: SourceFactRef[];
  method: ProposalMethod;
  /** Version of the matcher that produced it, so the same input reproduces it. */
  policyRelease: string;
  rationaleCodes: RationaleCode[];
  rejectionConditions: RejectionConditionCode[];
  evidenceRefs: string[];
  status: ProposalStatus;
  /** Set when a decision accepted or rejected it; null while it is only a candidate. */
  decisionRevisionRef: string | null;
  /**
   * True only when the provider itself linked the two claims inside one
   * verified namespace. Heuristics and AI are never auto-acceptable, whatever
   * else agrees (addendum 07 section 3 stage D).
   */
  autoAcceptable: boolean;
}

export const RECONCILIATION_POLICY_RELEASE = "reconciliation-rules-v1";

/** Where a provider identifier came from; a collector fingerprint is not a provider id. */
export const IDENTIFIER_ORIGINS = ["provider", "collector-fingerprint", "unknown"] as const;
export type IdentifierOrigin = (typeof IDENTIFIER_ORIGINS)[number];

/** The namespace a provider identifier is valid in. Equality outside it means nothing. */
export interface IdentifierScope {
  sourceId: string;
  /** Credential/connection epoch: a re-authenticated connection is a new epoch. */
  credentialEpoch: string;
  accountNamespace: string;
}

export const SETTLEMENT_STATES = ["pending", "posted", "unknown"] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/** One normalized claim the matcher compares. Nothing here is provider text a rule keys on. */
export interface MatchFact {
  ref: SourceFactRef;
  scope: IdentifierScope;
  sourceAccount: string;
  /** An identifier the provider itself issued for the row. */
  externalId: string | null;
  identifierOrigin: IdentifierOrigin;
  /** An identifier the provider states links this row to another one. */
  providerLinkId: string | null;
  settlementState: SettlementState;
  quantity: Quantity;
  occurred: TemporalValue;
  counterparty: string | null;
  /** Statement or billing period the provider grouped the row under. */
  statementPeriod: string | null;
  /**
   * The owning party identity has established for the account, or null when it
   * has not. Null is never read as "mine" (UC23).
   */
  ownerRef: string | null;
}

export interface MatchOptions {
  /** Maximum civil-day distance for stage B/C date closeness. */
  dayWindow: number;
  policyRelease: string;
}
export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  dayWindow: 5,
  policyRelease: RECONCILIATION_POLICY_RELEASE,
};

export function sameScope(a: IdentifierScope, b: IdentifierScope): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.credentialEpoch === b.credentialEpoch &&
    a.accountNamespace === b.accountNamespace
  );
}

function scopeMismatch(a: IdentifierScope, b: IdentifierScope): RejectionConditionCode[] {
  const codes: RejectionConditionCode[] = [];
  if (a.sourceId !== b.sourceId || a.accountNamespace !== b.accountNamespace)
    codes.push("identifier_namespace_differs");
  if (a.credentialEpoch !== b.credentialEpoch) codes.push("credential_epoch_differs");
  return codes;
}

function localDay(value: TemporalValue): string | null {
  if (value.kind === "local-date") return value.value;
  if (value.kind === "instant") return value.value.slice(0, 10);
  return null;
}

/**
 * Civil-day distance, or null when either side is not anchored to a day. A
 * period or an unknown time yields null rather than a guessed day, so a rule
 * that needs closeness simply does not fire.
 */
export function dayDistance(a: TemporalValue, b: TemporalValue): number | null {
  const left = localDay(a);
  const right = localDay(b);
  if (left === null || right === null) return null;
  const x = parseLocalDate(left);
  const y = parseLocalDate(right);
  if (!x || !y) return null;
  return Math.abs(daysBetween(x, y));
}

function amountsEqual(a: Quantity, b: Quantity): boolean {
  const order = compareQuantities(a, b);
  return order.ok && order.order === 0;
}

function amountsOpposite(a: Quantity, b: Quantity): boolean {
  if (a.unitRef !== b.unitRef) return false;
  if (a.value.status !== "exact" || b.value.status !== "exact") return false;
  const left = a.value.value;
  const right = b.value.value;
  if (left.coefficient === "0" || right.coefficient === "0") return false;
  return (
    left.coefficient.startsWith("-") !== right.coefficient.startsWith("-") &&
    left.coefficient.replace("-", "") === right.coefficient.replace("-", "") &&
    left.scale === right.scale
  );
}

function pairId(kind: ReconciliationKind, left: SourceFactRef, right: SourceFactRef): string {
  return `${kind}:${left.kind}/${left.id}@${left.revision}:${right.kind}/${right.id}@${right.revision}`;
}

function proposal(input: {
  kind: ReconciliationKind;
  stage: ProposalStage;
  left: MatchFact;
  right: MatchFact;
  rationaleCodes: RationaleCode[];
  rejectionConditions: RejectionConditionCode[];
  autoAcceptable: boolean;
  policyRelease: string;
}): ReconciliationProposal {
  return {
    proposalId: pairId(input.kind, input.left.ref, input.right.ref),
    kind: input.kind,
    stage: input.stage,
    targetRefs: [input.left.ref, input.right.ref],
    method: "rule",
    policyRelease: input.policyRelease,
    rationaleCodes: input.rationaleCodes,
    rejectionConditions: input.rejectionConditions,
    evidenceRefs: [
      `${input.left.ref.kind}:${input.left.ref.id}`,
      `${input.right.ref.kind}:${input.right.ref.id}`,
    ],
    // A rule never writes an acceptance; the job records the decision.
    status: "proposed",
    decisionRevisionRef: null,
    autoAcceptable: input.autoAcceptable,
  };
}

/**
 * Stage A — the same provider row observed twice. Only an identifier the
 * provider issued, inside one namespace, is strong enough to accept
 * automatically; a collector fingerprint is proposed and reviewed.
 */
export function stageAProposals(
  facts: readonly MatchFact[],
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
): ReconciliationProposal[] {
  const out: ReconciliationProposal[] = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const left = facts[i]!;
      const right = facts[j]!;
      if (left.externalId === null || left.externalId !== right.externalId) continue;
      const mismatch = scopeMismatch(left.scope, right.scope);
      if (mismatch.length > 0) continue; // Outside its namespace the id proves nothing.
      const provider =
        left.identifierOrigin === "provider" && right.identifierOrigin === "provider";
      const rationale: RationaleCode[] = ["provider_identifier_equal", "same_identifier_namespace"];
      if (!provider) rationale.push("collector_fingerprint_identifier");
      if (amountsEqual(left.quantity, right.quantity)) rationale.push("amount_equal");
      out.push(
        proposal({
          kind: "provider_same",
          stage: "A",
          left,
          right,
          rationaleCodes: rationale,
          rejectionConditions: provider
            ? ["identifier_namespace_differs", "credential_epoch_differs"]
            : [
                "identifier_namespace_differs",
                "credential_epoch_differs",
                "provider_link_absent",
                "amount_differs",
              ],
          autoAcceptable: provider,
          policyRelease: options.policyRelease,
        }),
      );
    }
  }
  return out;
}

/**
 * Stage B — a pending row and the posted row that replaced it inside one
 * provider. Amount and date closeness alone can only produce a candidate: two
 * purchases of the same amount on the same day must not be collapsed (SC03,
 * UC13). Only an explicit provider link id makes the pair auto-acceptable.
 */
export function stageBProposals(
  facts: readonly MatchFact[],
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
): ReconciliationProposal[] {
  const pending = facts.filter((fact) => fact.settlementState === "pending");
  const posted = facts.filter((fact) => fact.settlementState === "posted");
  const out: ReconciliationProposal[] = [];
  const candidatesPerPending = new Map<string, number>();
  const drafts: {
    left: MatchFact;
    right: MatchFact;
    rationale: RationaleCode[];
    rejections: RejectionConditionCode[];
    linked: boolean;
  }[] = [];
  for (const left of pending) {
    for (const right of posted) {
      if (!sameScope(left.scope, right.scope) || left.sourceAccount !== right.sourceAccount)
        continue;
      const linked = left.providerLinkId !== null && left.providerLinkId === right.providerLinkId;
      const distance = dayDistance(left.occurred, right.occurred);
      const closeInTime = distance !== null && distance <= options.dayWindow;
      const samePeriod =
        left.statementPeriod !== null && left.statementPeriod === right.statementPeriod;
      if (!linked && !(closeInTime || samePeriod)) continue;
      const rationale: RationaleCode[] = [
        "status_pending_to_posted",
        "same_identifier_namespace",
        "same_source_account",
      ];
      if (linked) rationale.push("provider_link_id_equal");
      else rationale.push("no_provider_link_id");
      if (samePeriod) rationale.push("same_statement_period");
      if (closeInTime) rationale.push("date_within_window");
      if (amountsEqual(left.quantity, right.quantity)) rationale.push("amount_equal");
      if (
        left.counterparty !== null &&
        right.counterparty !== null &&
        left.counterparty === right.counterparty
      )
        rationale.push("counterparty_equal");
      const rejections: RejectionConditionCode[] = linked
        ? ["identifier_namespace_differs", "credential_epoch_differs"]
        : [
            "provider_link_absent",
            "counterparty_differs",
            "amount_differs",
            "candidate_not_unique",
          ];
      drafts.push({ left, right, rationale, rejections, linked });
      // Ambiguity is counted among heuristic candidates only: a pair the
      // provider itself linked is not weakened by a look-alike row.
      if (!linked)
        candidatesPerPending.set(left.ref.id, (candidatesPerPending.get(left.ref.id) ?? 0) + 1);
    }
  }
  for (const draft of drafts) {
    const ambiguous = !draft.linked && (candidatesPerPending.get(draft.left.ref.id) ?? 0) > 1;
    out.push(
      proposal({
        kind: "pending_to_posted",
        stage: "B",
        left: draft.left,
        right: draft.right,
        rationaleCodes: ambiguous ? [...draft.rationale, "multiple_candidates"] : draft.rationale,
        rejectionConditions: ambiguous
          ? [...new Set<RejectionConditionCode>([...draft.rejections, "candidate_not_unique"])]
          : draft.rejections,
        // Only a provider-stated link is ever automatic; a look-alike row is
        // its own candidate and never becomes one.
        autoAcceptable: draft.linked,
        policyRelease: options.policyRelease,
      }),
    );
  }
  return out;
}

/**
 * Stage C — an economic correspondence across sources (a bank debit funding a
 * card statement, a payout and the bank credit that carries it). Equal amounts
 * on nearby dates never establish ownership: without an established owner on
 * both sides the pair stays a candidate with `owner_not_established` (UC23,
 * SC05).
 */
export function stageCProposals(
  facts: readonly MatchFact[],
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
): ReconciliationProposal[] {
  const out: ReconciliationProposal[] = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const left = facts[i]!;
      const right = facts[j]!;
      if (left.scope.sourceId === right.scope.sourceId) continue;
      if (left.quantity.unitRef !== right.quantity.unitRef) continue;
      if (!amountsOpposite(left.quantity, right.quantity)) continue;
      const distance = dayDistance(left.occurred, right.occurred);
      if (distance === null || distance > options.dayWindow) continue;
      const bothOwned =
        left.ownerRef !== null && right.ownerRef !== null && left.ownerRef === right.ownerRef;
      const rationale: RationaleCode[] = ["amount_opposite_sign", "date_within_window"];
      if (bothOwned) rationale.push("owner_established_self");
      const rejections: RejectionConditionCode[] = ["amount_differs", "date_outside_window"];
      if (!bothOwned) rejections.push("owner_not_established");
      rejections.push("provider_link_absent");
      out.push(
        proposal({
          kind: "funded_by",
          stage: "C",
          left,
          right,
          rationaleCodes: rationale,
          rejectionConditions: rejections,
          // Cross-source correspondences are always reviewed at this stage.
          autoAcceptable: false,
          policyRelease: options.policyRelease,
        }),
      );
    }
  }
  return out;
}

/** All three stages over one bounded fact set, in a deterministic order. */
export function matchProposals(
  facts: readonly MatchFact[],
  options: MatchOptions = DEFAULT_MATCH_OPTIONS,
): ReconciliationProposal[] {
  return [
    ...stageAProposals(facts, options),
    ...stageBProposals(facts, options),
    ...stageCProposals(facts, options),
  ].sort((a, b) => (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0));
}

/** Canonical identity of a proposal, for the idempotency digest a writer stores. */
export function proposalIdentity(proposal: ReconciliationProposal): Record<string, unknown> {
  return {
    kind: proposal.kind,
    stage: proposal.stage,
    method: proposal.method,
    policyRelease: proposal.policyRelease,
    targetRefs: proposal.targetRefs.map((ref) => `${ref.kind}/${ref.id}@${ref.revision}`),
  };
}

export function validReconciliationProposal(value: unknown): value is ReconciliationProposal {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "proposalId",
      "kind",
      "stage",
      "targetRefs",
      "method",
      "policyRelease",
      "rationaleCodes",
      "rejectionConditions",
      "evidenceRefs",
      "status",
      "decisionRevisionRef",
      "autoAcceptable",
    ]) &&
    isText(value.proposalId, 512) &&
    isOneOf(RECONCILIATION_KINDS)(value.kind) &&
    isOneOf(PROPOSAL_STAGES)(value.stage) &&
    Array.isArray(value.targetRefs) &&
    value.targetRefs.length >= 2 &&
    value.targetRefs.every(validSourceFactRef) &&
    isOneOf(PROPOSAL_METHODS)(value.method) &&
    isText(value.policyRelease, 128) &&
    Array.isArray(value.rationaleCodes) &&
    value.rationaleCodes.every(isOneOf(RATIONALE_CODES)) &&
    Array.isArray(value.rejectionConditions) &&
    value.rejectionConditions.every(isOneOf(REJECTION_CONDITION_CODES)) &&
    isRefList(value.evidenceRefs) &&
    isOneOf(PROPOSAL_STATUSES)(value.status) &&
    (value.decisionRevisionRef === null || isText(value.decisionRevisionRef, 256)) &&
    typeof value.autoAcceptable === "boolean" &&
    // A rule proposal is auto-acceptable only with a provider-issued link.
    (!value.autoAcceptable ||
      value.rationaleCodes.includes("provider_link_id_equal") ||
      value.rationaleCodes.includes("provider_identifier_equal"))
  );
}
