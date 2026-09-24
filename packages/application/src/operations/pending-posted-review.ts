// Reviewing a pending-to-posted card usage link through the change lifecycle
// (card purchase plan §1.1, §1.2; docs/change-lifecycle.md). The review rides
// on `relation.accept` / `relation.reject` with the evidence marker
// `reconciliation-proposal:<id>`, as the ownership review rides on
// `card-settlement:<id>`: no new change kind, no rebuild of `change_plans`.
//
//   * `relation.accept` of a proposed candidate merges the two recognised
//     events into one purchase (the pending-origin event survives);
//   * `relation.reject` of a proposed candidate rejects it and touches no
//     event;
//   * `relation.reject` of an accepted link withdraws it and splits the
//     merged event back into two.
//
// The plan pins the proposal (`proposal:<id>`, its decision count), the
// relation triple and each side's live holder (`card-purchase:<event id>`),
// and the commit re-checks them all inside the one batch that records the
// relation decision, the `proposal:` decision, the proposal's resolution and
// the events' revisions (`pendingPostedWrites`), under the receipt guard.
import type {
  CardPurchaseMergeDraft,
  CardPurchaseSplitDraft,
} from "../../../domain/src/card-purchase.ts";
import {
  cardPurchaseSubjectRef,
  pendingPostedMarker,
  pendingPostedProposalId,
  PENDING_POSTED_INVALIDATION,
  PENDING_POSTED_RELATION_KIND,
  proposalSubjectRef,
  type PendingPostedBlocker,
} from "../../../domain/src/pending-posted-review.ts";
import {
  cardPurchaseMergeGuard,
  cardPurchaseMergeWrites,
  cardPurchaseSplitGuard,
  cardPurchaseSplitWrites,
} from "../../../storage-d1/src/atomic/card-purchase-recognition.ts";
import {
  commandKey,
  type ChangeKind,
  type CommandStore,
  type CommitGuard,
  type PlanTarget,
  type PreparedWrite,
  type Principal,
  type RelationPayload,
} from "../command/contract.ts";
import { commandError, type CommandErrorCode, type CommandResult } from "../command/errors.ts";
import {
  loadPendingPostedCandidates,
  type LoadedCandidate,
} from "../query/card-purchase-candidates.ts";
import { candidateMerge, candidateSplit } from "./card-purchase-links.ts";
import type { ResolvedPlan } from "./targets.ts";

/** What a review does, decided from the proposal and the relation, never from the caller. */
export type PendingPostedMode = "accept" | "reject" | "withdraw";

export interface PendingPostedReview {
  mode: PendingPostedMode;
  proposalId: string;
  /** Decisions recorded on `proposal:<id>` when the plan was read. */
  proposalRevision: number;
  sourceId: string | null;
  targets: PlanTarget[];
  precondition: CommitGuard;
  merge: CardPurchaseMergeDraft | null;
  split: CardPurchaseSplitDraft | null;
}

const BLOCKER_ERRORS: Record<PendingPostedBlocker, CommandErrorCode> = {
  row_not_recognized: "incomplete_evidence",
  already_linked: "stale_context",
  kind_differs: "unsupported_semantics",
  account_differs: "needs_scope_resolution",
  posted_not_captured: "stale_context",
  proposal_closed: "stale_context",
  proposal_shape_unsupported: "unsupported_semantics",
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** The pin and diff line of one side's live event. */
function holderTarget(
  eventId: string,
  currentRevision: number,
  current: string | null,
  proposed: string | null,
): PlanTarget {
  return {
    subjectRef: cardPurchaseSubjectRef(eventId),
    currentRevision,
    currentTargetRef: current,
    proposedTargetRef: proposed,
  };
}

const at = (eventId: string, revision: number) => `event:${eventId}@${revision}`;

/**
 * Validate a marked relation command against its proposal and resolve what
 * it would do. `operationId` is null while planning; the commit passes its
 * own, which the event decisions are keyed by.
 */
export async function preparePendingPostedReview(
  store: CommandStore,
  kind: ChangeKind,
  relation: RelationPayload,
  operationId: string | null,
): Promise<CommandResult<{ review: PendingPostedReview }>> {
  const proposalId = pendingPostedProposalId(relation.evidenceRefs);
  if (
    proposalId === null ||
    (kind !== "relation.accept" && kind !== "relation.reject") ||
    relation.relationKind !== PENDING_POSTED_RELATION_KIND ||
    relation.validFrom !== null ||
    relation.validTo !== null
  )
    return commandError("invalid_command");
  const marker = pendingPostedMarker(proposalId);
  const [candidate]: LoadedCandidate[] = await loadPendingPostedCandidates(store, { proposalId });
  if (candidate === undefined) return commandError("target_missing", [marker]);
  const { view } = candidate;
  // The ends and the evidence are the proposal's own, canonical, in order.
  if (relation.fromRef !== view.relation.fromRef || relation.toRef !== view.relation.toRef)
    return commandError("invalid_command", [marker]);
  if (!sameList(relation.evidenceRefs, view.relation.evidenceRefs))
    return commandError("incomplete_evidence", [marker]);

  const mode: PendingPostedMode | null =
    kind === "relation.accept"
      ? view.actions.includes("accept")
        ? "accept"
        : null
      : view.actions.includes("withdraw")
        ? "withdraw"
        : view.actions.includes("reject")
          ? "reject"
          : null;
  if (mode === null) {
    const blocker = view.blockers[0];
    return commandError(blocker ? BLOCKER_ERRORS[blocker] : "stale_context", [marker]);
  }

  const pending = candidate.pending.holder;
  const posted = candidate.posted.holder;
  let merge: CardPurchaseMergeDraft | null = null;
  let split: CardPurchaseSplitDraft | null = null;
  if (mode === "accept") {
    merge = await candidateMerge(store, candidate.pending, candidate.posted, operationId);
    if (merge === null) return commandError("unsupported_semantics", [marker]);
  } else if (mode === "withdraw" && candidate.merged) {
    split = await candidateSplit(store, candidate.pending, candidate.posted, operationId);
    if (split === null) return commandError("stale_context", [marker]);
  }

  // Every side with a live event is pinned, whatever the action: a reviewer
  // decides about the events the screen showed, and the screen finds them
  // through these subjects.
  const holders: PlanTarget[] = [];
  if (merge !== null) {
    const next = at(merge.draft.revision.eventId, merge.draft.revision.revision);
    holders.push(
      holderTarget(
        merge.survivor.eventId,
        merge.survivor.revision,
        at(merge.survivor.eventId, merge.survivor.revision),
        next,
      ),
      holderTarget(
        merge.absorbed.eventId,
        merge.absorbed.revision,
        at(merge.absorbed.eventId, merge.absorbed.revision),
        next,
      ),
    );
  } else if (split !== null) {
    holders.push(
      holderTarget(
        split.survivor.eventId,
        split.survivor.revision,
        at(split.survivor.eventId, split.survivor.revision),
        at(split.retire.revision.eventId, split.retire.revision.revision),
      ),
      holderTarget(
        split.absorbed.eventId,
        0,
        at(split.survivor.eventId, split.survivor.revision),
        at(split.restore.revision.eventId, split.restore.revision.revision),
      ),
    );
  } else {
    const seen = new Set<string>();
    for (const holder of [pending, posted])
      if (holder !== null && !seen.has(holder.eventId)) {
        seen.add(holder.eventId);
        const current = at(holder.eventId, holder.revision);
        holders.push(holderTarget(holder.eventId, holder.revision, current, current));
      }
  }

  const proposalStatus =
    mode === "accept" ? "accepted" : mode === "reject" ? "rejected" : "withdrawn";
  const expectedStatus = mode === "withdraw" ? "accepted" : "proposed";
  const proposalGuard: CommitGuard = {
    sql: "EXISTS(SELECT 1 FROM reconciliation_proposals WHERE id=? AND kind=? AND status=?)",
    binds: [proposalId, PENDING_POSTED_RELATION_KIND, expectedStatus],
  };
  const eventGuard = merge
    ? cardPurchaseMergeGuard(merge)
    : split
      ? cardPurchaseSplitGuard(split)
      : null;
  return {
    ok: true,
    review: {
      mode,
      proposalId,
      proposalRevision: view.proposalRevision,
      sourceId: pending?.sourceId ?? posted?.sourceId ?? null,
      targets: [
        {
          subjectRef: proposalSubjectRef(proposalId),
          currentRevision: view.proposalRevision,
          currentTargetRef: view.proposalStatus,
          proposedTargetRef: proposalStatus,
        },
        ...holders,
      ],
      precondition: eventGuard
        ? {
            sql: `(${proposalGuard.sql}) AND (${eventGuard.sql})`,
            binds: [...proposalGuard.binds, ...eventGuard.binds],
          }
        : proposalGuard,
      merge,
      split,
    },
  };
}

/** The plan of a marked relation command: the relation's own plan plus the review's pins. */
export async function pendingPostedReviewPlan(
  store: CommandStore,
  kind: ChangeKind,
  relation: RelationPayload,
  base: ResolvedPlan,
): Promise<CommandResult<{ resolved: ResolvedPlan }>> {
  const prepared = await preparePendingPostedReview(store, kind, relation, null);
  if (!prepared.ok) return prepared;
  const { review } = prepared;
  const targets = [...base.targets, ...review.targets];
  return {
    ok: true,
    resolved: {
      targets,
      expectedRevisions: Object.fromEntries(
        targets.map((target) => [target.subjectRef, target.currentRevision]),
      ),
      simulation: {
        ...base.simulation,
        targets,
        affectedScopes: review.sourceId === null ? [] : [review.sourceId],
        invalidations: [
          "read-model:relations",
          "read-model:card-purchases",
          PENDING_POSTED_INVALIDATION,
        ],
      },
    },
  };
}

/**
 * The review's statements for the commit batch, after the relation's own:
 * the `proposal:` decision, the proposal's resolution (accept/reject) or the
 * supersession of its accepting decision (withdraw), and the merge or split
 * batch. Every statement is guarded on the commit's receipt reservation,
 * whose own condition is `review.precondition`.
 */
export async function pendingPostedWrites(input: {
  review: PendingPostedReview;
  relation: RelationPayload;
  principal: Principal;
  operationId: string;
  now: string;
  guard: CommitGuard;
}): Promise<{ writes: PreparedWrite[]; result: Record<string, unknown> }> {
  const { review, relation, principal, operationId, now, guard } = input;
  const decisionId = await commandKey("dr", ["proposal", operationId]);
  const subject = proposalSubjectRef(review.proposalId);
  const revision = review.proposalRevision + 1;
  const writes: PreparedWrite[] = [
    {
      // The 0032 trigger resolves a proposal only with a `proposal:` decision.
      sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
 SELECT ?,'relation',?,?,?,'manual',?,?,?,json(?),?,NULL,? FROM decision_operations op
 WHERE op.operation_id=? AND NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?) AND ${guard.sql}`,
      binds: [
        decisionId,
        subject,
        revision,
        review.mode === "withdraw" ? "supersede" : review.mode,
        principal.id,
        operationId,
        relation.reason,
        JSON.stringify(relation.evidenceRefs),
        review.proposalRevision > 0 ? review.proposalRevision : null,
        now,
        operationId,
        decisionId,
        ...guard.binds,
      ],
    },
    review.mode === "withdraw"
      ? {
          // The proposal row stays `accepted` (0032 resolves it once); the
          // decision that accepted it is superseded by the withdrawal.
          sql: `UPDATE decision_revisions SET superseded_by=?
 WHERE subject_kind='relation' AND subject_ref=? AND superseded_by IS NULL AND id<>?
 AND EXISTS(SELECT 1 FROM decision_revisions WHERE id=?) AND ${guard.sql}`,
          binds: [decisionId, subject, decisionId, decisionId, ...guard.binds],
        }
      : {
          sql: `UPDATE reconciliation_proposals SET status=?,decision_revision_id=?
 WHERE id=? AND status='proposed' AND EXISTS(SELECT 1 FROM decision_revisions WHERE id=?) AND ${guard.sql}`,
          binds: [
            review.mode === "accept" ? "accepted" : "rejected",
            decisionId,
            review.proposalId,
            decisionId,
            ...guard.binds,
          ],
        },
  ];
  const author = { method: "manual" as const, actorId: principal.id, operationId };
  if (review.merge)
    writes.push(...cardPurchaseMergeWrites({ merge: review.merge, now, author, guard }));
  if (review.split)
    writes.push(...cardPurchaseSplitWrites({ split: review.split, now, author, guard }));
  const events = review.merge
    ? [at(review.merge.draft.revision.eventId, review.merge.draft.revision.revision)]
    : review.split
      ? [
          at(review.split.retire.revision.eventId, review.split.retire.revision.revision),
          at(review.split.restore.revision.eventId, review.split.restore.revision.revision),
        ]
      : [];
  return {
    writes,
    result: {
      proposalId: review.proposalId,
      proposalDecisionRevisionId: decisionId,
      review: review.mode,
      eventRevisions: events,
    },
  };
}
