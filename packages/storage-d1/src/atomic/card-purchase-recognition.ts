// Card purchase revisions as guarded batches (CORE 0047; docs/economic-events.md).
//
// Statement order: decision → event revision → leg → supersede pointer(s) →
// sidecar → keys. Every statement is a *conditional* write, for the reason
// `decision-commit.ts` gives: D1 rolls a batch back on an SQL error, not
// because a conditional INSERT matched zero rows, so each statement carries
// its own guard.
//
//   * The decision is statement 1 and carries every precondition: its id is
//     unused, each event is still at the live revision the draft was planned
//     against (or has no revision at all for a first recognition), and no
//     other live event holds any of the draft's keys.
//   * Every later statement is `WHERE EXISTS(decision) AND NOT EXISTS(own row)`.
//
// The decision id is a digest of (event, revision, content digest, action,
// and the reviewed operation if any), so a replayed batch finds its own rows
// and writes nothing, and a stale or concurrent batch whose first statement
// matched nothing writes nothing in any table. Recognition writes no
// allocation and no cash-movement leg.
//
// Three batches:
//   * `cardPurchaseRecognitionWrites` — one event: recognize, revise,
//     reanchor or retire;
//   * `cardPurchaseMergeWrites` — a pending-to-posted link: the survivor's
//     revision n+1 holding both keys, then the survivor's revision n and the
//     posted event's live revision m both superseded by it (a cross-id
//     supersession, allowed by 0032), so both keys are free before the new
//     revision claims them;
//   * `cardPurchaseSplitWrites` — a withdrawn link: the merged event retired
//     first (holding its pending key alone), then the posted event's new
//     revision m+1 holding the posted key again. The posted event is restored
//     rather than recognised anew: its id already has revisions, so a first
//     recognition could never be written for it.
//
// A reviewed merge or split runs inside the change lifecycle's commit batch:
// `guard` (the receipt reservation) is added to statement 1, and the same
// precondition (`cardPurchaseMergeGuard` / `cardPurchaseSplitGuard`) is a
// condition of the reservation itself, so the judgement and the events move
// together or not at all.
import {
  CARD_PURCHASE_ACTOR,
  CARD_PURCHASE_POLICY,
  cardPurchaseDecisionKind,
  cardPurchaseDecisionReason,
  type CardPurchaseDraft,
  type CardPurchaseMergeDraft,
  type CardPurchaseSplitDraft,
} from "../../../domain/src/card-purchase.ts";
import type { SqlWrite } from "../core/operations.ts";

export interface CardPurchaseRecognitionInput {
  draft: CardPurchaseDraft;
  /**
   * The live revision the draft was planned against, or null for a first
   * recognition. The draft's revision must be exactly one more.
   */
  expectedRevision: number | null;
  now: string;
}

/**
 * Who a merge or split decision is recorded under: the rule (the default: a
 * provider-linked merge, no operation) or the human who reviewed it through
 * the change lifecycle.
 */
export interface CardPurchaseDecisionAuthor {
  method: "rule" | "manual";
  actorId: string;
  operationId: string | null;
}

const RULE: CardPurchaseDecisionAuthor = {
  method: "rule",
  actorId: CARD_PURCHASE_ACTOR,
  operationId: null,
};

const DECISION_EXISTS = "EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)";

/**
 * The guarded statements for one draft. Throws on an inconsistent input (a
 * programming error, never a runtime race): a revision that does not follow
 * the expected one, a first recognition that is not action `recognize`, or a
 * leg without an exact amount.
 */
export function cardPurchaseRecognitionWrites(input: CardPurchaseRecognitionInput): SqlWrite[] {
  const { draft, expectedRevision, now } = input;
  const revision = draft.revision;
  const eventId = revision.eventId;
  const decisionId = draft.decisionRevisionId;
  if (
    revision.revision !== (expectedRevision ?? 0) + 1 ||
    (expectedRevision === null) !== (draft.action === "recognize") ||
    draft.action === "merge" ||
    draft.action === "split"
  )
    throw new RangeError("card purchase draft does not follow the expected revision");
  checkDraft(draft);
  const evidence = JSON.stringify(revision.evidenceSupport);
  const keys = JSON.stringify(draft.keys.map((key) => key.key));
  const expected =
    expectedRevision === null
      ? {
          sql: "NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=?10)",
          binds: [] as unknown[],
        }
      : {
          sql: `EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=?10 AND revision=?12 AND superseded_by IS NULL)
   AND NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=?10 AND revision>?12)`,
          binds: [expectedRevision] as unknown[],
        };
  const writes: SqlWrite[] = [
    {
      sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
 SELECT ?1,'relation',?2,?3,?4,'rule',?5,NULL,?6,?7,?8,NULL,?9
 WHERE NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?1)
 AND ${expected.sql}
 AND NOT EXISTS(SELECT 1 FROM current_card_purchase_keys k
  WHERE k.event_id<>?10 AND k.recognition_key IN (SELECT value FROM json_each(?11)))`,
      binds: [
        decisionId,
        `event:${eventId}`,
        revision.revision,
        cardPurchaseDecisionKind(draft.action),
        CARD_PURCHASE_ACTOR,
        cardPurchaseDecisionReason(draft.action),
        evidence,
        expectedRevision,
        now,
        eventId,
        keys,
        ...expected.binds,
      ],
    },
    ...revisionWrites(draft, now),
  ];
  if (expectedRevision !== null)
    // The one permitted update (0032): point the old live revision at the new one.
    writes.push(supersedeWrite({ eventId, revision: expectedRevision }, draft));
  writes.push(...sidecarWrites(draft, now));
  return writes;
}

/** A draft's own consistency: the decision it names, no pointer, pinned keys. */
function checkDraft(draft: CardPurchaseDraft): void {
  const revision = draft.revision;
  if (
    revision.decisionRevisionRef !== draft.decisionRevisionId ||
    revision.supersededBy !== null ||
    draft.keys.length === 0 ||
    draft.keys.some((key) => key.observationId <= 0 || key.parseRunId <= 0)
  )
    throw new RangeError("card purchase draft does not follow the expected revision");
}

/** Statement 1 of a merge or split: one decision about one event, under a caller's guard. */
function decisionWrite(
  draft: CardPurchaseDraft,
  previousRevision: number,
  author: CardPurchaseDecisionAuthor,
  now: string,
  guard: SqlWrite,
): SqlWrite {
  return {
    sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
 SELECT ?,'relation',?,?,?,?,?,?,?,?,?,NULL,? WHERE NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)
 AND ${guard.sql}`,
    binds: [
      draft.decisionRevisionId,
      `event:${draft.revision.eventId}`,
      draft.revision.revision,
      cardPurchaseDecisionKind(draft.action),
      author.method,
      author.actorId,
      author.operationId,
      cardPurchaseDecisionReason(draft.action),
      JSON.stringify(draft.revision.evidenceSupport),
      previousRevision,
      now,
      draft.decisionRevisionId,
      ...guard.binds,
    ],
  };
}

/** The event revision and its legs, each guarded on the draft's decision. */
function revisionWrites(draft: CardPurchaseDraft, now: string): SqlWrite[] {
  const revision = draft.revision;
  const eventId = revision.eventId;
  const decisionId = draft.decisionRevisionId;
  const writes: SqlWrite[] = [
    {
      sql: `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,NULL,? WHERE ${DECISION_EXISTS}
 AND NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision=?)`,
      binds: [
        eventId,
        revision.revision,
        revision.kind,
        revision.state,
        revision.unknownReason,
        JSON.stringify(revision.effectiveTime),
        revision.basis,
        JSON.stringify(revision.evidenceSupport),
        decisionId,
        now,
        decisionId,
        eventId,
        revision.revision,
      ],
    },
  ];
  for (const leg of revision.legs) {
    if (leg.quantity.value.status !== "exact")
      throw new RangeError("a card purchase leg is always an exact amount");
    const { coefficient, scale } = leg.quantity.value.value;
    writes.push({
      sql: `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
 SELECT ?,?,?,?,?,'exact',?,?,NULL,?,? WHERE ${DECISION_EXISTS}
 AND NOT EXISTS(SELECT 1 FROM economic_legs WHERE event_id=? AND revision=? AND leg_index=?)`,
      binds: [
        eventId,
        revision.revision,
        leg.legIndex,
        leg.subjectRef,
        leg.quantity.unitRef,
        coefficient,
        scale,
        leg.role,
        leg.basis,
        decisionId,
        eventId,
        revision.revision,
        leg.legIndex,
      ],
    });
  }
  return writes;
}

/** The one permitted update (0032): point a live revision at the draft's new revision. */
function supersedeWrite(
  target: { eventId: string; revision: number },
  draft: CardPurchaseDraft,
): SqlWrite {
  return {
    sql: `UPDATE economic_event_revisions SET superseded_by=?
 WHERE event_id=? AND revision=? AND superseded_by IS NULL AND ${DECISION_EXISTS}`,
    binds: [
      `${draft.revision.eventId}@${draft.revision.revision}`,
      target.eventId,
      target.revision,
      draft.decisionRevisionId,
    ],
  };
}

/** The sidecar row and the keys, after every pointer the batch moves. */
function sidecarWrites(draft: CardPurchaseDraft, now: string): SqlWrite[] {
  const revision = draft.revision;
  const eventId = revision.eventId;
  const decisionId = draft.decisionRevisionId;
  const writes: SqlWrite[] = [
    {
      sql: `INSERT INTO card_purchase_recognitions(event_id,revision,policy_release,action,content_digest,account_id,source_id,statement_period,facts_json,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${DECISION_EXISTS}
 AND NOT EXISTS(SELECT 1 FROM card_purchase_recognitions WHERE event_id=? AND revision=?)`,
      binds: [
        eventId,
        revision.revision,
        CARD_PURCHASE_POLICY,
        draft.action,
        draft.contentDigest,
        draft.sidecar.accountId,
        draft.sidecar.sourceId,
        draft.sidecar.statementPeriod,
        JSON.stringify(draft.sidecar.facts),
        now,
        decisionId,
        eventId,
        revision.revision,
      ],
    },
  ];
  for (const key of draft.keys)
    writes.push({
      sql: `INSERT INTO card_purchase_recognition_keys(event_id,revision,recognition_key,role,observation_id,parse_run_id)
 SELECT ?,?,?,?,?,? WHERE ${DECISION_EXISTS}
 AND NOT EXISTS(SELECT 1 FROM card_purchase_recognition_keys WHERE event_id=? AND revision=? AND recognition_key=?)`,
      binds: [
        eventId,
        revision.revision,
        key.key,
        key.role,
        key.observationId,
        key.parseRunId,
        decisionId,
        eventId,
        revision.revision,
        key.key,
      ],
    });
  return writes;
}

/** `eventId@revision` is the event's live revision and nothing newer exists. */
function liveAt(ref: { eventId: string; revision: number }): SqlWrite {
  return {
    sql: `EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision=? AND superseded_by IS NULL)
 AND NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision>?)`,
    binds: [ref.eventId, ref.revision, ref.eventId, ref.revision],
  };
}

/** The named revisions hold exactly these keys between them, and no other live event holds one. */
function heldExactly(
  holders: readonly { eventId: string; revision: number }[],
  keys: readonly string[],
): SqlWrite {
  const owners = holders.map(() => "(k.event_id=? AND k.revision=?)").join(" OR ");
  const ownerBinds = holders.flatMap((holder) => [holder.eventId, holder.revision]);
  const json = JSON.stringify(keys);
  return {
    sql: `(SELECT count(*) FROM card_purchase_recognition_keys k WHERE ${owners})=json_array_length(?)
 AND NOT EXISTS(SELECT 1 FROM card_purchase_recognition_keys k WHERE (${owners})
  AND k.recognition_key NOT IN (SELECT value FROM json_each(?)))
 AND NOT EXISTS(SELECT 1 FROM current_card_purchase_keys k
  WHERE k.event_id NOT IN (${holders.map(() => "?").join(",")})
  AND k.recognition_key IN (SELECT value FROM json_each(?)))`,
    binds: [
      ...ownerBinds,
      json,
      ...ownerBinds,
      json,
      ...holders.map((holder) => holder.eventId),
      json,
    ],
  };
}

function all(...parts: SqlWrite[]): SqlWrite {
  return {
    sql: parts.map((part) => `(${part.sql})`).join("\n AND "),
    binds: parts.flatMap((part) => [...part.binds]),
  };
}

function checkMerge(merge: CardPurchaseMergeDraft): void {
  const { draft, survivor, absorbed } = merge;
  checkDraft(draft);
  if (
    draft.action !== "merge" ||
    draft.revision.eventId !== survivor.eventId ||
    draft.revision.revision !== survivor.revision + 1 ||
    absorbed.eventId === survivor.eventId ||
    draft.keys.length < 2
  )
    throw new RangeError("card purchase merge does not follow the expected revisions");
}

/**
 * What a merge requires of the stored state, as one SQL condition: the
 * survivor and the posted event are each still at the live revision the
 * merge was planned against, and between them they hold exactly the merged
 * revision's keys, which no other live event holds.
 */
export function cardPurchaseMergeGuard(merge: CardPurchaseMergeDraft): SqlWrite {
  checkMerge(merge);
  return all(
    liveAt(merge.survivor),
    liveAt(merge.absorbed),
    heldExactly(
      [merge.survivor, merge.absorbed],
      merge.draft.keys.map((key) => key.key),
    ),
  );
}

export interface CardPurchaseMergeInput {
  merge: CardPurchaseMergeDraft;
  now: string;
  /** Default: the rule, with no operation. */
  author?: CardPurchaseDecisionAuthor;
  /** An extra condition on statement 1, e.g. the change lifecycle's receipt reservation. */
  guard?: SqlWrite;
}

/**
 * A pending-to-posted merge in one guarded batch: the survivor's decision
 * (statement 1, carrying the merge guard), its revision n+1 and leg, the
 * survivor's revision n and the posted event's revision m superseded by
 * n+1, then the sidecar and both keys.
 */
export function cardPurchaseMergeWrites(input: CardPurchaseMergeInput): SqlWrite[] {
  const { merge, now } = input;
  const guard = cardPurchaseMergeGuard(merge);
  return [
    decisionWrite(
      merge.draft,
      merge.survivor.revision,
      input.author ?? RULE,
      now,
      input.guard ? all(guard, input.guard) : guard,
    ),
    ...revisionWrites(merge.draft, now),
    supersedeWrite(merge.survivor, merge.draft),
    supersedeWrite(merge.absorbed, merge.draft),
    ...sidecarWrites(merge.draft, now),
  ];
}

function checkSplit(split: CardPurchaseSplitDraft): void {
  const { retire, restore, survivor, absorbed } = split;
  checkDraft(retire);
  checkDraft(restore);
  if (
    retire.action !== "retire" ||
    (restore.action !== "split" && restore.action !== "retire") ||
    retire.revision.eventId !== survivor.eventId ||
    retire.revision.revision !== survivor.revision + 1 ||
    restore.revision.eventId !== absorbed.eventId ||
    restore.revision.revision !== absorbed.revision + 1 ||
    absorbed.eventId === survivor.eventId
  )
    throw new RangeError("card purchase split does not follow the expected revisions");
}

/**
 * What a split requires of the stored state: the merged event is still at the
 * live revision the split was planned against and holds exactly the pending
 * and posted keys being separated, and the posted event's last revision is
 * the one the merge superseded, with no live revision of its own.
 */
export function cardPurchaseSplitGuard(split: CardPurchaseSplitDraft): SqlWrite {
  checkSplit(split);
  const { absorbed } = split;
  return all(
    liveAt(split.survivor),
    {
      // The merge pointed it at one of the survivor's revisions.
      sql: `EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision=?
  AND substr(superseded_by,1,length(?)+1)=?||'@')
 AND NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND (revision>? OR superseded_by IS NULL))`,
      binds: [
        absorbed.eventId,
        absorbed.revision,
        split.survivor.eventId,
        split.survivor.eventId,
        absorbed.eventId,
        absorbed.revision,
      ],
    },
    heldExactly(
      [split.survivor],
      [...split.retire.keys, ...split.restore.keys].map((key) => key.key),
    ),
  );
}

export interface CardPurchaseSplitInput {
  split: CardPurchaseSplitDraft;
  now: string;
  author?: CardPurchaseDecisionAuthor;
  guard?: SqlWrite;
}

/**
 * A withdrawn link split in one guarded batch: the merged event's retirement
 * (statement 1 carries the split guard) superseding its live revision and
 * holding the pending key(s), then the posted event's decision (guarded on
 * the first) and its revision m+1 holding the posted key again.
 */
export function cardPurchaseSplitWrites(input: CardPurchaseSplitInput): SqlWrite[] {
  const { split, now } = input;
  const guard = cardPurchaseSplitGuard(split);
  const author = input.author ?? RULE;
  const restore = split.restore;
  return [
    decisionWrite(
      split.retire,
      split.survivor.revision,
      author,
      now,
      input.guard ? all(guard, input.guard) : guard,
    ),
    ...revisionWrites(split.retire, now),
    supersedeWrite(split.survivor, split.retire),
    ...sidecarWrites(split.retire, now),
    decisionWrite(restore, split.absorbed.revision, author, now, {
      sql: DECISION_EXISTS,
      binds: [split.retire.decisionRevisionId],
    }),
    ...revisionWrites(restore, now),
    ...sidecarWrites(restore, now),
  ];
}
