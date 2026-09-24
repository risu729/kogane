import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type {
  CardPurchaseCandidate,
  CardPurchasePage,
  CardPurchaseView,
} from "../../../packages/domain/src/card-purchase-view.ts";
import type { PendingPostedAction } from "../../../packages/domain/src/pending-posted-review.ts";

export type { CardPurchaseCandidate, CardPurchaseView, PendingPostedAction };
const CARD_PURCHASES_PATH = "/api/v2/card-purchases";

/** One page of recognised purchases; `period` is a statement month (`YYYY-MM`) or none. */
export function useCardPurchases(offset: number, period: string | null) {
  const features = useFeatures();
  const params = new URLSearchParams({ offset: String(offset) });
  if (period !== null) params.set("period", period);
  return useQuery({
    queryKey: ["card-purchases", "list", period, offset],
    enabled: features.known && features.cardPurchaseRecognition,
    queryFn: ({ signal }) => getJson<CardPurchasePage>(`${CARD_PURCHASES_PATH}?${params}`, signal),
    retry: false,
  });
}

/** One purchase by its event id, with the page it was read in (for its summary). */
export function useCardPurchase(eventId: string | null) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-purchases", "detail", eventId],
    enabled: eventId !== null && features.known && features.cardPurchaseRecognition,
    queryFn: ({ signal }) =>
      getJson<CardPurchasePage>(
        `${CARD_PURCHASES_PATH}?eventId=${encodeURIComponent(eventId ?? "")}`,
        signal,
      ),
    retry: false,
  });
}

// ── reviewing a pending-to-posted link ───────────────────────────────
//
// The review rides on `relation.accept` / `relation.reject`. The payload is the
// candidate's own `relation` plus the operator's reason: the client never
// builds relation ends or evidence refs itself. `withdraw` is `relation.reject`
// of an accepted link, which splits the merged purchase again.

/** The invalidation a pending-to-posted review plan carries (the confirmation screen keys on it). */
export const PURCHASE_LINK_INVALIDATION = "review:card-purchase-link";
const PROPOSAL_PREFIX = "proposal:";
const CARD_PURCHASE_PREFIX = "card-purchase:";

function purchaseLinkKind(action: PendingPostedAction): "relation.accept" | "relation.reject" {
  return action === "accept" ? "relation.accept" : "relation.reject";
}

/** The `POST /api/command/v1/plan` body of one review. */
export function purchaseLinkPlanRequest(
  candidate: CardPurchaseCandidate,
  action: PendingPostedAction,
  reason: string,
): Record<string, unknown> {
  return {
    kind: purchaseLinkKind(action),
    payload: { ...candidate.relation, reason },
    baseContextId: `card-purchase-link:${candidate.proposalId}`,
  };
}

/**
 * What a planned `relation.accept` / `relation.reject` is for this candidate:
 * a reject of an accepted link is its withdrawal.
 */
export function purchaseLinkAction(
  kind: string,
  candidate: CardPurchaseCandidate,
): PendingPostedAction | null {
  if (kind === "relation.accept") return "accept";
  if (kind === "relation.reject")
    return candidate.relationStatus === "accepted" ? "withdraw" : "reject";
  return null;
}

/** One subject a review plan pins, beside what the candidate on screen says it is at. */
export interface PurchaseLinkPin {
  subjectRef: string;
  role: "proposal" | "relation" | "pending" | "posted";
  /** The candidate's own revision of that subject. */
  shown: number;
  /** Whether the plan must pin it for this action. */
  required: boolean;
}

/**
 * The pins a review plan of this candidate carries: the proposal's decisions,
 * the relation triple's rows and, for a merge or a split, the live revision
 * of each side's event (one pin when both rows are one merged event).
 */
export function purchaseLinkPins(
  candidate: CardPurchaseCandidate,
  action: PendingPostedAction,
): PurchaseLinkPin[] {
  const { relation } = candidate;
  const pins: PurchaseLinkPin[] = [
    {
      subjectRef: PROPOSAL_PREFIX + candidate.proposalId,
      role: "proposal",
      shown: candidate.proposalRevision,
      required: true,
    },
    {
      subjectRef: `relation:${relation.relationKind}|${relation.fromRef}|${relation.toRef}`,
      role: "relation",
      shown: candidate.relationRevision,
      required: true,
    },
  ];
  for (const role of ["pending", "posted"] as const) {
    const side = candidate[role];
    if (side.eventId === null || side.revision === null) continue;
    const subjectRef = CARD_PURCHASE_PREFIX + side.eventId;
    if (pins.some((pin) => pin.subjectRef === subjectRef)) continue;
    pins.push({ subjectRef, role, shown: side.revision, required: action !== "reject" });
  }
  return pins;
}

/** True when every pin the plan must carry is there, and every pin it carries is the candidate's. */
export function purchaseLinkPinsMatch(
  expected: Record<string, number>,
  candidate: CardPurchaseCandidate,
  action: PendingPostedAction,
): boolean {
  return purchaseLinkPins(candidate, action).every((pin) =>
    Object.hasOwn(expected, pin.subjectRef)
      ? expected[pin.subjectRef] === pin.shown
      : !pin.required,
  );
}

/** The proposal a review plan is about, from its pinned `proposal:<id>` subject. */
export function plannedProposalId(subjects: readonly string[]): string | null {
  const ids = [
    ...new Set(
      subjects
        .filter((ref) => ref.startsWith(PROPOSAL_PREFIX))
        .map((ref) => ref.slice(PROPOSAL_PREFIX.length)),
    ),
  ];
  return ids.length === 1 && ids[0] !== "" ? ids[0]! : null;
}

/**
 * The purchase to read the candidate from: a planned `card-purchase:<id>`
 * subject, preferring one pinned at a live revision (an event absorbed by a
 * merge is pinned at 0 and has no page of its own).
 */
export function plannedPurchaseEventId(
  subjects: readonly string[],
  expected: Record<string, number>,
): string | null {
  const ids = [
    ...new Set(
      subjects
        .filter((ref) => ref.startsWith(CARD_PURCHASE_PREFIX))
        .map((ref) => ref.slice(CARD_PURCHASE_PREFIX.length)),
    ),
  ].filter((id) => /^(?:purchase|refund)_[0-9a-f]{64}$/u.test(id));
  return ids.find((id) => (expected[CARD_PURCHASE_PREFIX + id] ?? 1) > 0) ?? null;
}
