// Account correspondence candidates between an aggregator connection and a
// direct provider's accounts (ADR 0077, docs/identity.md).
//
// A MoneyForward account identity (ADR 0027) names one provider connection
// registered at MoneyForward: one account-detail page that can list several
// products. The only stored evidence that such a connection and a direct
// collector's accounts belong to the same provider connection is a current,
// confirmed `account_connection_reviews` row: a verifier compared the
// connection's displayed branch and account number with the direct
// provider's own account reference, and pinned the exact direct source
// accounts that the direct overview of the same run listed
// (docs/account-connections.md). This module reads those rows and *proposes*
// one `connection_contains` relation per (connection, direct source account)
// pair. Nothing here writes: accepting or rejecting a pair is a person's
// `relation.accept` / `relation.reject` through the change lifecycle (INV07),
// and the status read here comes from the relations stored by those commands.
//
// It never proposes `same_account`. No recorded MoneyForward field names a
// leaf account: the aggregator's observations are connection-scoped. So each
// pair states why no same-account candidate exists (closed reasons), and a
// connection whose evidence names several direct accounts never chooses one
// of them. A display name, a label or an amount is never read as evidence.
import type { StoredRelationStatus } from "./decisions.ts";

/** The policy every answer names, so a later rule change is a new context. */
export const ACCOUNT_CANDIDATE_POLICY = "account-candidates-v1";

/** Current connection reviews one answer may read; the review table's own reader stops at 64 too. */
export const ACCOUNT_CONNECTION_REVIEW_LIMIT = 64;
/** Aggregator source accounts one answer may read; a larger store is refused, never cut. */
export const AGGREGATOR_ACCOUNT_LIMIT = 1_000;
/** Newest relation rows (per kind and pair of references) one answer may read. */
export const ACCOUNT_RELATION_LIMIT = 10_000;

/** The evidence a candidate can rest on: a current confirmed connection review. */
export const ACCOUNT_CANDIDATE_EVIDENCE = ["connection-review-confirmed"] as const;
type AccountCandidateEvidence = (typeof ACCOUNT_CANDIDATE_EVIDENCE)[number];

/**
 * A candidate's status, from stored relations only: `accepted` or `rejected`
 * when the newest `connection_contains` relation for the pair says so;
 * otherwise (none, proposed or released) `proposed`.
 */
export const ACCOUNT_CANDIDATE_STATUSES = ["proposed", "accepted", "rejected"] as const;
type AccountCandidateStatus = (typeof ACCOUNT_CANDIDATE_STATUSES)[number];

/**
 * Why accepting a candidate is withheld. Rejecting (keeping apart, or
 * withdrawing an acceptance) is still offered.
 * - `evidence-ineligible`: the review's evidence artifacts are no longer in
 *   the financial views (a run excluded or no longer successful);
 * - `direct-account-in-several-connections`: the direct source account is
 *   named by the current eligible confirmed reviews of more than one
 *   aggregator connection, so none is chosen.
 */
export const ACCOUNT_CANDIDATE_HOLDS = [
  "evidence-ineligible",
  "direct-account-in-several-connections",
] as const;
type AccountCandidateHold = (typeof ACCOUNT_CANDIDATE_HOLDS)[number];

/**
 * Why no `same_account` candidate exists for a pair. Every pair names the
 * first; a connection whose evidence names two or more direct source accounts
 * also names the second.
 */
export const SAME_ACCOUNT_REASONS = [
  "aggregator-account-connection-scoped",
  "several-direct-accounts",
] as const;
type SameAccountReason = (typeof SAME_ACCOUNT_REASONS)[number];

/** A connection review's state now: the review's status unless its evidence left the views. */
export const ACCOUNT_CONNECTION_STATES = [
  "confirmed",
  "unresolved",
  "evidence-ineligible",
] as const;
type AccountConnectionState = (typeof ACCOUNT_CONNECTION_STATES)[number];

/**
 * Why an aggregator source account is listed without a candidate:
 * - `no-connection-review`: no current review of any producer names its
 *   identity value;
 * - `reference-unrecognized`: its stored reference is not one
 *   `moneyforward-me:<identity>` value, so it names no connection.
 */
export const UNREVIEWED_REASONS = ["no-connection-review", "reference-unrecognized"] as const;
type UnreviewedReason = (typeof UNREVIEWED_REASONS)[number];

/** One current connection review as stored (`current_account_connection_reviews`). */
export interface ConnectionReviewFact {
  producerId: string;
  /** The aggregator account identity value the review is keyed by. */
  connectionKey: string;
  revision: number;
  status: "confirmed" | "unresolved";
  /** The view's own eligibility recheck of the review's evidence artifacts. */
  evidenceEligible: boolean;
  /** The reviewer's label for the connection (not provider text, not evidence). */
  label: string;
  relatedSourceId: string | null;
  directProducerId: string | null;
  /** The exact direct source accounts the review pinned; empty unless confirmed. */
  directSourceAccountIds: readonly string[];
  /** The detail, direct and branch artifacts the review pinned, those present. */
  artifactIds: readonly number[];
}

/** One aggregator source account: a `moneyforward-me` reference of any producer. */
export interface AggregatorAccountFact {
  sourceAccountId: string;
  producerId: string;
  /** The identity value its reference names, or null when the reference is not one. */
  connectionKey: string | null;
}

/** The newest stored relation of one kind between two references. */
export interface AccountRelationFact {
  kind: "connection_contains" | "same_account";
  fromRef: string;
  toRef: string;
  status: StoredRelationStatus;
}

export interface AccountCandidateInput {
  reviews: readonly ConnectionReviewFact[];
  aggregatorAccounts: readonly AggregatorAccountFact[];
  relations: readonly AccountRelationFact[];
}

/** The change lifecycle payload (without `reason`) a candidate names. */
export interface AccountCandidateCommand {
  kind: "relation.accept" | "relation.reject";
  payload: {
    relationKind: "connection_contains";
    fromRef: string;
    toRef: string;
    validFrom: null;
    validTo: null;
    evidenceRefs: string[];
  };
}

export interface AccountCandidate {
  /** `account-candidate:<connectionRef>|source_account:<id>`, stable for one pair. */
  candidateId: string;
  /** `connection:<producer>/<connection key>`, the relation's `fromRef`. */
  connectionRef: string;
  producerId: string;
  connectionKey: string;
  reviewRevision: number;
  relatedSourceId: string | null;
  directSourceAccountId: string;
  /** Aggregator source accounts (any producer) whose identity value is the connection key. */
  aggregatorSourceAccountIds: string[];
  relation: "connection_contains";
  evidence: AccountCandidateEvidence[];
  evidenceEligible: boolean;
  status: AccountCandidateStatus;
  hold: AccountCandidateHold | null;
  sameAccount: {
    proposed: false;
    reasons: SameAccountReason[];
    /** Newest `same_account` relations already stored between an aggregator side and the direct side. */
    recorded: { fromRef: string; toRef: string; status: StoredRelationStatus }[];
  };
  /**
   * `accept` when no hold applies and the pair is not accepted; `reject`
   * (keep apart, or withdraw an acceptance) unless the pair is rejected.
   */
  commands: { accept: AccountCandidateCommand | null; reject: AccountCandidateCommand | null };
  /** The review and the artifacts it pinned. */
  evidenceRefs: string[];
}

export interface AccountConnectionEntry {
  connectionRef: string;
  producerId: string;
  connectionKey: string;
  revision: number;
  label: string;
  state: AccountConnectionState;
  relatedSourceId: string | null;
  directSourceAccountIds: string[];
  aggregatorSourceAccountIds: string[];
  evidenceRefs: string[];
}

export interface UnreviewedAggregatorAccount {
  sourceAccountId: string;
  producerId: string;
  connectionKey: string | null;
  reason: UnreviewedReason;
}

export interface AccountCandidateSet {
  policy: typeof ACCOUNT_CANDIDATE_POLICY;
  candidates: AccountCandidate[];
  connections: AccountConnectionEntry[];
  unreviewed: UnreviewedAggregatorAccount[];
  summary: {
    connections: Record<AccountConnectionState, number>;
    candidates: Record<AccountCandidateStatus, number>;
    /** Proposed candidates whose acceptance is withheld. */
    held: number;
    unreviewedAggregatorAccounts: number;
    /** Always 0: this policy never proposes `same_account`. */
    sameAccountProposed: 0;
    /** Pairs with at least one stored `same_account` relation, whatever its status. */
    sameAccountRecorded: number;
  };
}

/** A store past one of the bounds; the answer is refused whole. */
export class AccountCandidateLimitError extends Error {
  constructor(readonly bound: "reviews" | "aggregatorAccounts" | "relations") {
    super(`account candidate bound exceeded: ${bound}`);
    this.name = "AccountCandidateLimitError";
  }
}

const relationKey = (kind: string, fromRef: string, toRef: string): string =>
  JSON.stringify([kind, fromRef, toRef]);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `connection:<producer>/<key>`: the reference migration 0029 wrote for a reviewed connection. */
export function connectionRef(producerId: string, connectionKey: string): string {
  return `connection:${producerId}/${connectionKey}`;
}

function evidenceRefsOf(review: ConnectionReviewFact): string[] {
  return [
    `account-connection-review:${review.producerId}/${review.connectionKey}@${String(review.revision)}`,
    ...review.artifactIds.map((id) => `fetch_artifact:${String(id)}`),
  ];
}

function stateOf(review: ConnectionReviewFact): AccountConnectionState {
  return review.evidenceEligible ? review.status : "evidence-ineligible";
}

/**
 * The candidates, connections and unreviewed aggregator accounts of one
 * store. Pure: the same facts in any order give the same answer.
 */
export function accountCandidates(input: AccountCandidateInput): AccountCandidateSet {
  if (input.reviews.length > ACCOUNT_CONNECTION_REVIEW_LIMIT)
    throw new AccountCandidateLimitError("reviews");
  if (input.aggregatorAccounts.length > AGGREGATOR_ACCOUNT_LIMIT)
    throw new AccountCandidateLimitError("aggregatorAccounts");
  if (input.relations.length > ACCOUNT_RELATION_LIMIT)
    throw new AccountCandidateLimitError("relations");
  const seen = new Set<string>();
  for (const review of input.reviews) {
    const key = JSON.stringify([review.producerId, review.connectionKey]);
    if (seen.has(key)) throw new Error("duplicate current connection review");
    seen.add(key);
  }

  const relations = new Map<string, StoredRelationStatus>();
  for (const relation of input.relations)
    relations.set(relationKey(relation.kind, relation.fromRef, relation.toRef), relation.status);

  const aggregatorsByKey = new Map<string, string[]>();
  for (const account of input.aggregatorAccounts) {
    if (account.connectionKey === null) continue;
    const list = aggregatorsByKey.get(account.connectionKey) ?? [];
    list.push(account.sourceAccountId);
    aggregatorsByKey.set(account.connectionKey, list);
  }
  for (const list of aggregatorsByKey.values()) list.sort(byText);
  const aggregatorsOf = (key: string): string[] => [...(aggregatorsByKey.get(key) ?? [])];

  // Which aggregator connections (identity values) claim each direct source
  // account through a current, eligible, confirmed review. Two producers'
  // reviews of one identity value are one connection.
  const claims = new Map<string, Set<string>>();
  for (const review of input.reviews) {
    if (review.status !== "confirmed" || !review.evidenceEligible) continue;
    for (const direct of review.directSourceAccountIds) {
      const set = claims.get(direct) ?? new Set<string>();
      set.add(review.connectionKey);
      claims.set(direct, set);
    }
  }

  const candidates: AccountCandidate[] = [];
  const connections: AccountConnectionEntry[] = [];
  for (const review of input.reviews) {
    const ref = connectionRef(review.producerId, review.connectionKey);
    const evidenceRefs = evidenceRefsOf(review);
    const aggregators = aggregatorsOf(review.connectionKey);
    const directs = [...review.directSourceAccountIds].sort(byText);
    connections.push({
      connectionRef: ref,
      producerId: review.producerId,
      connectionKey: review.connectionKey,
      revision: review.revision,
      label: review.label,
      state: stateOf(review),
      relatedSourceId: review.relatedSourceId,
      directSourceAccountIds: directs,
      aggregatorSourceAccountIds: aggregators,
      evidenceRefs,
    });
    if (review.status !== "confirmed") continue;
    for (const direct of directs) {
      const toRef = `source_account:${direct}`;
      const stored = relations.get(relationKey("connection_contains", ref, toRef));
      const status: AccountCandidateStatus =
        stored === "accepted" ? "accepted" : stored === "rejected" ? "rejected" : "proposed";
      const hold: AccountCandidateHold | null = !review.evidenceEligible
        ? "evidence-ineligible"
        : (claims.get(direct)?.size ?? 0) > 1
          ? "direct-account-in-several-connections"
          : null;
      const command = (kind: AccountCandidateCommand["kind"]): AccountCandidateCommand => ({
        kind,
        payload: {
          relationKind: "connection_contains",
          fromRef: ref,
          toRef,
          validFrom: null,
          validTo: null,
          evidenceRefs: [...evidenceRefs],
        },
      });
      const recorded: AccountCandidate["sameAccount"]["recorded"] = [];
      for (const aggregator of aggregators) {
        const aggregatorRef = `source_account:${aggregator}`;
        for (const [fromRef, sideTo] of [
          [aggregatorRef, toRef],
          [toRef, aggregatorRef],
        ] as const) {
          const same = relations.get(relationKey("same_account", fromRef, sideTo));
          if (same !== undefined) recorded.push({ fromRef, toRef: sideTo, status: same });
        }
      }
      candidates.push({
        candidateId: `account-candidate:${ref}|${toRef}`,
        connectionRef: ref,
        producerId: review.producerId,
        connectionKey: review.connectionKey,
        reviewRevision: review.revision,
        relatedSourceId: review.relatedSourceId,
        directSourceAccountId: direct,
        aggregatorSourceAccountIds: aggregators,
        relation: "connection_contains",
        evidence: ["connection-review-confirmed"],
        evidenceEligible: review.evidenceEligible,
        status,
        hold,
        sameAccount: {
          proposed: false,
          reasons:
            directs.length > 1
              ? ["aggregator-account-connection-scoped", "several-direct-accounts"]
              : ["aggregator-account-connection-scoped"],
          recorded,
        },
        commands: {
          accept: hold === null && status !== "accepted" ? command("relation.accept") : null,
          reject: status !== "rejected" ? command("relation.reject") : null,
        },
        evidenceRefs,
      });
    }
  }
  candidates.sort((a, b) => byText(a.candidateId, b.candidateId));
  connections.sort((a, b) => byText(a.connectionRef, b.connectionRef));

  const reviewedKeys = new Set(input.reviews.map((review) => review.connectionKey));
  const unreviewed: UnreviewedAggregatorAccount[] = input.aggregatorAccounts
    .filter((account) => account.connectionKey === null || !reviewedKeys.has(account.connectionKey))
    .map((account) => ({
      sourceAccountId: account.sourceAccountId,
      producerId: account.producerId,
      connectionKey: account.connectionKey,
      reason:
        account.connectionKey === null
          ? ("reference-unrecognized" as const)
          : ("no-connection-review" as const),
    }))
    .sort((a, b) => byText(a.sourceAccountId, b.sourceAccountId));

  const count = <T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> =>
    Object.fromEntries(
      keys.map((key) => [key, values.filter((value) => value === key).length]),
    ) as Record<T, number>;
  return {
    policy: ACCOUNT_CANDIDATE_POLICY,
    candidates,
    connections,
    unreviewed,
    summary: {
      connections: count(
        connections.map((entry) => entry.state),
        ACCOUNT_CONNECTION_STATES,
      ),
      candidates: count(
        candidates.map((candidate) => candidate.status),
        ACCOUNT_CANDIDATE_STATUSES,
      ),
      held: candidates.filter(
        (candidate) => candidate.status === "proposed" && candidate.hold !== null,
      ).length,
      unreviewedAggregatorAccounts: unreviewed.length,
      sameAccountProposed: 0,
      sameAccountRecorded: candidates.filter(
        (candidate) => candidate.sameAccount.recorded.length > 0,
      ).length,
    },
  };
}
