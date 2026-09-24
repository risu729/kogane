// Reviewing one pending-to-posted card usage link (card purchase plan §1.1,
// §1.2 "Link to the pending row"). A stage-B reconciliation proposal names a
// pending (unconfirmed) provider row and a posted (posted/confirmed) row of the
// same card; card purchase recognition has made each of them its own event.
// Accepting the proposal merges the two events into one purchase (the
// pending-origin event survives, history `authorized → captured`); withdrawing
// an accepted link splits them again. Amount and date closeness never merge
// anything by itself (INV07): only a recorded decision does, a human's
// through the change lifecycle or, for a pair the provider itself linked, the
// rule's.
//
// The review rides on the existing `relation.accept` / `relation.reject`
// change kinds, as the ownership review does: the relation is
// `pending_to_posted` from the pending row to the posted row, and one evidence
// ref is the marker `reconciliation-proposal:<id>` that names the proposal.
// Nothing here reads storage; `pendingPostedReview` is the one definition of
// what a review may do, shared by the operator view and the plan.
import type { CardPurchaseKeyRole, CardPurchaseKind } from "./card-purchase.ts";
import { validSourceFactRef, type EventState, type SourceFactRef } from "./events.ts";
import type { ProposalStatus } from "./reconcile.ts";

/** The evidence ref that turns a `pending_to_posted` relation command into a proposal review. */
export const PENDING_POSTED_MARKER_PREFIX = "reconciliation-proposal:";
/** Decisions about one reconciliation proposal (0032 "Where the decisions live"). */
export const PROPOSAL_SUBJECT_PREFIX = "proposal:";
/**
 * The live revision of one recognised card purchase event, as a plan pins it:
 * `card-purchase:<event id>` answers the event's live revision, or 0 when it
 * has none (packages/storage-d1/src/core/operations.ts).
 */
export const CARD_PURCHASE_SUBJECT_PREFIX = "card-purchase:";
export const PENDING_POSTED_RELATION_KIND = "pending_to_posted";
/** The invalidation a review plan carries, so a confirmation screen can tell it apart. */
export const PENDING_POSTED_INVALIDATION = "review:card-purchase-link";

/** What a review of one candidate may do now. `withdraw` is `relation.reject` of an accepted link. */
export const PENDING_POSTED_ACTIONS = ["accept", "reject", "withdraw"] as const;
export type PendingPostedAction = (typeof PENDING_POSTED_ACTIONS)[number];

/** Why a candidate cannot be accepted (or withdrawn). Closed: a new reason is a reviewed change. */
export const PENDING_POSTED_BLOCKERS = [
  /** A side's row is not held by any live recognised event. */
  "row_not_recognized",
  /** A side's event already holds a link (several keys), or both sides are one event. */
  "already_linked",
  /** A purchase and a refund are never one event. */
  "kind_differs",
  /** The two events resolve to different card accounts or sources. */
  "account_differs",
  /** The posted row's event is not a captured charge any more. */
  "posted_not_captured",
  /** The proposal was already rejected, or its accepted link withdrawn. */
  "proposal_closed",
  /** The proposal does not name one pending row and one posted row of one card. */
  "proposal_shape_unsupported",
] as const;
export type PendingPostedBlocker = (typeof PENDING_POSTED_BLOCKERS)[number];

/** The `relation.accept` / `relation.reject` payload of one review, apart from its `reason`. */
export interface PendingPostedRelation {
  relationKind: typeof PENDING_POSTED_RELATION_KIND;
  /** The pending row, `transaction:<observation id>`. */
  fromRef: string;
  /** The posted row, `transaction:<observation id>`. */
  toRef: string;
  validFrom: null;
  validTo: null;
  /** `[reconciliation-proposal:<id>, <pending id>@<revision>, <posted id>@<revision>]`, exactly. */
  evidenceRefs: string[];
}

export function pendingPostedMarker(proposalId: string): string {
  return PENDING_POSTED_MARKER_PREFIX + proposalId;
}

export function proposalSubjectRef(proposalId: string): string {
  return PROPOSAL_SUBJECT_PREFIX + proposalId;
}

export function cardPurchaseSubjectRef(eventId: string): string {
  return CARD_PURCHASE_SUBJECT_PREFIX + eventId;
}

/** True when a relation command carries a proposal marker (and is therefore a proposal review). */
export function pendingPostedReviewRequested(evidenceRefs: readonly string[]): boolean {
  return evidenceRefs.some((ref) => ref.startsWith(PENDING_POSTED_MARKER_PREFIX));
}

/** The proposal id of exactly one marker, or null when there is none or more than one. */
export function pendingPostedProposalId(evidenceRefs: readonly string[]): string | null {
  const markers = evidenceRefs.filter((ref) => ref.startsWith(PENDING_POSTED_MARKER_PREFIX));
  if (markers.length !== 1) return null;
  const id = markers[0]!.slice(PENDING_POSTED_MARKER_PREFIX.length);
  return id.length > 0 && id.length <= 512 ? id : null;
}

const CANONICAL_TRANSACTION = /^transaction:[1-9][0-9]{0,15}$/u;
const CANONICAL_PARSE_RUN = /^parse_run:[1-9][0-9]{0,15}$/u;

/**
 * The relation end of one proposal target: the `SourceFactRef` id itself,
 * `transaction:<observation id>`, which already carries its kind. A ref whose
 * id does not start with its own kind (or is not a pinned transaction row) has
 * no canonical end.
 */
export function canonicalRelationEnd(ref: SourceFactRef): string | null {
  return validSourceFactRef(ref) &&
    ref.kind === "transaction" &&
    CANONICAL_TRANSACTION.test(ref.id) &&
    CANONICAL_PARSE_RUN.test(ref.revision)
    ? ref.id
    : null;
}

/** `<id>@<revision>`: a row pinned to the parse run the matcher read it in. */
export function pinnedRef(ref: SourceFactRef): string {
  return `${ref.id}@${ref.revision}`;
}

/** The exact evidence list a review of this proposal carries. */
export function pendingPostedEvidenceRefs(
  proposalId: string,
  pending: SourceFactRef,
  posted: SourceFactRef,
): string[] {
  return [pendingPostedMarker(proposalId), pinnedRef(pending), pinnedRef(posted)];
}

/**
 * The relation payload of a review, from the proposal's two targets (pending
 * first, as `stageBProposals` orders them). Null when a target is not a
 * canonical transaction row.
 */
export function pendingPostedRelation(
  proposalId: string,
  pending: SourceFactRef,
  posted: SourceFactRef,
): PendingPostedRelation | null {
  const fromRef = canonicalRelationEnd(pending);
  const toRef = canonicalRelationEnd(posted);
  if (fromRef === null || toRef === null || fromRef === toRef) return null;
  return {
    relationKind: PENDING_POSTED_RELATION_KIND,
    fromRef,
    toRef,
    validFrom: null,
    validTo: null,
    evidenceRefs: pendingPostedEvidenceRefs(proposalId, pending, posted),
  };
}

/** The live recognised event that holds one side's recognition key. */
export interface PendingPostedHolder {
  eventId: string;
  /** The live revision; a plan pins it as `card-purchase:<eventId>`. */
  revision: number;
  kind: CardPurchaseKind;
  state: EventState;
  accountId: string;
  sourceId: string;
  /** Every key that live revision holds. */
  keys: readonly { key: string; role: CardPurchaseKeyRole }[];
}

/** One target of a proposal, resolved against the recognition keys. */
export interface PendingPostedTarget {
  ref: SourceFactRef;
  /** The recognition key of the cited row, re-derived as 0047 does; null when unreadable. */
  recognitionKey: string | null;
  /** `pending` for an unconfirmed row, `posted` for a posted/confirmed one. */
  role: CardPurchaseKeyRole | null;
  holder: PendingPostedHolder | null;
}

export interface PendingPostedReviewInput {
  proposalStatus: ProposalStatus;
  /** The latest `entity_relations` status of the triple, or null when it has none. */
  relationStatus: string | null;
  pending: PendingPostedTarget;
  posted: PendingPostedTarget;
}

export interface PendingPostedReviewState {
  actions: PendingPostedAction[];
  blockers: PendingPostedBlocker[];
  /**
   * For a withdrawal: whether the link is merged into one event, which the
   * withdrawal splits. An accepted link nobody merged is withdrawn without
   * touching any event.
   */
  merged: boolean;
}

/** Both sides are one live event holding exactly the pending key and the posted key. */
function mergedPair(pending: PendingPostedTarget, posted: PendingPostedTarget): boolean {
  const holder = pending.holder;
  if (holder === null || posted.holder === null || holder.eventId !== posted.holder.eventId)
    return false;
  const roles = new Map(holder.keys.map((entry) => [entry.key, entry.role]));
  return (
    holder.keys.length === 2 &&
    roles.size === 2 &&
    roles.get(pending.recognitionKey ?? "") === "pending" &&
    roles.get(posted.recognitionKey ?? "") === "posted"
  );
}

function acceptBlockers(
  pending: PendingPostedTarget,
  posted: PendingPostedTarget,
): PendingPostedBlocker[] {
  const a = pending.holder;
  const b = posted.holder;
  if (a === null || b === null) return ["row_not_recognized"];
  if (
    a.eventId === b.eventId ||
    a.keys.length !== 1 ||
    b.keys.length !== 1 ||
    a.keys[0]!.role !== "pending" ||
    b.keys[0]!.role !== "posted"
  )
    return ["already_linked"];
  const blockers: PendingPostedBlocker[] = [];
  if (a.kind !== b.kind) blockers.push("kind_differs");
  if (a.accountId !== b.accountId || a.sourceId !== b.sourceId) blockers.push("account_differs");
  if (b.state !== "captured") blockers.push("posted_not_captured");
  // A pending-origin event is authorized, or retired (`unknown`) once its row
  // left the provider's display; a captured single pending key cannot exist.
  if (a.state !== "authorized" && a.state !== "unknown") blockers.push("already_linked");
  return blockers;
}

/**
 * What a review of one candidate may do now, and why not. The same answer
 * serves the operator view (buttons) and the plan (refusal):
 *
 * - a `proposed` proposal whose triple is not accepted may be rejected, and
 *   accepted when both rows are held by two single-key events of one kind and
 *   one card account, the posted one captured;
 * - an `accepted` proposal whose triple is accepted may be withdrawn; the
 *   withdrawal splits the merged event, or touches no event when none merged;
 * - anything else is closed.
 */
export function pendingPostedReview(input: PendingPostedReviewInput): PendingPostedReviewState {
  const { pending, posted } = input;
  const shaped =
    pending.role === "pending" &&
    posted.role === "posted" &&
    pending.recognitionKey !== null &&
    posted.recognitionKey !== null &&
    pending.recognitionKey !== posted.recognitionKey &&
    canonicalRelationEnd(pending.ref) !== null &&
    canonicalRelationEnd(posted.ref) !== null;
  const linked = input.relationStatus === "accepted";
  if (input.proposalStatus === "proposed" && !linked) {
    const blockers = shaped
      ? acceptBlockers(pending, posted)
      : ["proposal_shape_unsupported" as const];
    return {
      actions: blockers.length === 0 ? ["accept", "reject"] : ["reject"],
      blockers: [...new Set(blockers)],
      merged: false,
    };
  }
  if (input.proposalStatus === "accepted" && linked) {
    if (!shaped) return { actions: [], blockers: ["proposal_shape_unsupported"], merged: false };
    const merged = mergedPair(pending, posted);
    // Two single-key events (a link no merge followed) or a clean merge can
    // be withdrawn; any other holder shape is not this link's to split.
    const separate =
      pending.holder === null ||
      posted.holder === null ||
      (pending.holder.eventId !== posted.holder.eventId &&
        pending.holder.keys.length === 1 &&
        posted.holder.keys.length === 1);
    return merged || separate
      ? { actions: ["withdraw"], blockers: [], merged }
      : { actions: [], blockers: ["already_linked"], merged: false };
  }
  return {
    actions: [],
    blockers: [linked ? "already_linked" : "proposal_closed"],
    merged: false,
  };
}
