// The card purchase lane's batch as a build before ADR 0054 G1b wrote it, for
// tests of what a pre-guard store holds and of replays of pre-guard drafts.
// Two things differ from the current writer: the decision id was a digest
// without the writer release, and the batch ended at the keys (no revision
// seal, no commit row). Every statement before the seal is unchanged, so the
// pre-guard batch is the current batch without its two last statements.
import { canonicalDigest } from "../../domain/src/context.ts";
import type { CardPurchaseDraft } from "../../domain/src/card-purchase.ts";
import { cardPurchaseRecognitionWrites } from "../src/atomic/card-purchase-recognition.ts";
import type { SqlWrite } from "../src/core/operations.ts";

/** The draft under the decision id a pre-guard build gave it. */
export async function preGuardDraft(draft: CardPurchaseDraft): Promise<CardPurchaseDraft> {
  const id = `dr_cp_${await canonicalDigest({
    eventId: draft.revision.eventId,
    revision: draft.revision.revision,
    contentDigest: draft.contentDigest,
    action: draft.action,
  })}`;
  return {
    ...draft,
    decisionRevisionId: id,
    revision: { ...draft.revision, decisionRevisionRef: id },
  };
}

/** A pre-guard build's batch for a draft (already under its pre-guard id). */
export function preGuardRecognitionWrites(
  draft: CardPurchaseDraft,
  expectedRevision: number | null,
  now: string,
): SqlWrite[] {
  const writes = cardPurchaseRecognitionWrites({ draft, expectedRevision, now });
  const tail = writes.slice(-2).map((write) => /^INSERT INTO (\w+)/u.exec(write.sql)?.[1]);
  if (tail[0] !== "economic_revision_seals" || tail[1] !== "economic_commit_log")
    throw new Error("the current batch no longer ends with its seal and commit row");
  return writes.slice(0, -2);
}
