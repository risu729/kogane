// One card purchase revision as a guarded batch (CORE 0047; docs/economic-events.md).
//
// Statement order: decision → event revision → leg → supersede pointer →
// sidecar → keys. Every statement is a *conditional* write, for the reason
// `decision-commit.ts` gives: D1 rolls a batch back on an SQL error, not
// because a conditional INSERT matched zero rows, so each statement carries
// its own guard.
//
//   * The decision is statement 1 and carries every precondition: its id is
//     unused, the event is still at the live revision the draft was planned
//     against (or has no revision at all for a first recognition), and no
//     other live event holds any of the draft's keys.
//   * Every later statement is `WHERE EXISTS(decision) AND NOT EXISTS(own row)`.
//
// The decision id is a digest of (event, revision, content digest, action), so
// a replayed batch finds its own rows and writes nothing, and a stale or
// concurrent batch whose first statement matched nothing writes nothing in any
// table. Recognition writes no allocation and no cash-movement leg.
import {
  CARD_PURCHASE_ACTOR,
  CARD_PURCHASE_POLICY,
  cardPurchaseDecisionKind,
  cardPurchaseDecisionReason,
  type CardPurchaseDraft,
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
    revision.decisionRevisionRef !== decisionId ||
    revision.supersededBy !== null ||
    draft.keys.length === 0 ||
    draft.keys.some((key) => key.observationId <= 0 || key.parseRunId <= 0)
  )
    throw new RangeError("card purchase draft does not follow the expected revision");
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
        evidence,
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
  if (expectedRevision !== null)
    // The one permitted update (0032): point the old live revision at the new one.
    writes.push({
      sql: `UPDATE economic_event_revisions SET superseded_by=?
 WHERE event_id=? AND revision=? AND superseded_by IS NULL AND ${DECISION_EXISTS}`,
      binds: [`${eventId}@${revision.revision}`, eventId, expectedRevision, decisionId],
    });
  writes.push({
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
  });
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
