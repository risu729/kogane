// Synthetic pending-to-posted review shapes for the web tests, built on the
// application's card purchase fixture. Every id, amount and merchant is invented.
import {
  capturedPurchase,
  linkCandidate,
  retiredPurchase,
} from "../../../packages/application/test/card-purchase-view-fixture.ts";
import type {
  CardPurchaseCandidate,
  CardPurchaseView,
} from "../../../packages/domain/src/card-purchase-view.ts";

/** The retired pending event (transaction:23), the pending side of `linkCandidate`. */
export const PENDING_EVENT = retiredPurchase().eventId;
/** The captured posted event (transaction:21), the posted side of `linkCandidate`. */
export const POSTED_EVENT = capturedPurchase().eventId;

/** The pending event while its row is still displayed: authorized, with a live amount. */
export function authorizedPendingPurchase(): CardPurchaseView {
  const retired = retiredPurchase();
  return {
    ...retired,
    revision: 1,
    state: "authorized",
    unknownReason: null,
    amount: retired.lastKnownAmount,
    sourceRows: retired.sourceRows.map((row) => ({ ...row, current: true })),
    history: retired.history.filter((entry) => entry.revision === 1),
    candidates: [authorizedCandidate()],
  };
}

/** The open candidate while the pending row is still authorized: accepting it is authorized → captured. */
export function authorizedCandidate(): CardPurchaseCandidate {
  const base = linkCandidate();
  return linkCandidate({ pending: { ...base.pending, revision: 1, state: "authorized" } });
}

/** The accepted link of a merge: both rows are held by the pending-origin event. */
export function mergedCandidate(): CardPurchaseCandidate {
  const base = linkCandidate();
  return linkCandidate({
    proposalStatus: "accepted",
    proposalRevision: 1,
    relationStatus: "accepted",
    relationRevision: 1,
    pending: { ...base.pending, eventId: PENDING_EVENT, revision: 3, state: "captured" },
    posted: { ...base.posted, eventId: PENDING_EVENT, revision: 3, state: "captured" },
    actions: ["withdraw"],
    blockers: [],
  });
}

/** The pending-origin event after a merge: captured, holding the posted and the pending row. */
export function mergedPurchase(): CardPurchaseView {
  const posted = capturedPurchase();
  const pending = retiredPurchase();
  const candidate = mergedCandidate();
  return {
    ...posted,
    eventId: PENDING_EVENT,
    revision: 3,
    sourceRows: [...posted.sourceRows, ...pending.sourceRows],
    history: [
      {
        revision: 3,
        action: "merge",
        state: "captured",
        unknownReason: null,
        decisionRevisionId: `dr_${"a".repeat(64)}`,
        createdAt: "2026-09-25T00:00:00.000Z",
      },
      ...pending.history,
    ],
    candidates: [candidate],
    explanationRefs: [`event:${PENDING_EVENT}@3`, `proposal:${candidate.proposalId}`],
  };
}

/**
 * The expected revisions a review plan of this candidate carries: the
 * proposal's decisions, the relation triple's rows and each held side's live
 * revision (`card-purchase:<event id>`).
 */
export function linkPlanPins(candidate: CardPurchaseCandidate): Record<string, number> {
  const { relation } = candidate;
  const pins: Record<string, number> = {
    [`proposal:${candidate.proposalId}`]: candidate.proposalRevision,
    [`relation:${relation.relationKind}|${relation.fromRef}|${relation.toRef}`]:
      candidate.relationRevision,
  };
  for (const side of [candidate.pending, candidate.posted])
    if (side.eventId !== null && side.revision !== null)
      pins[`card-purchase:${side.eventId}`] = side.revision;
  return pins;
}
