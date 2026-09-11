// The decision + receipt + outbox commit, as statements (unified plan 09 §2,
// addendum 10 §5). Every statement here is a *conditional* write:
//
//   * the reservation is the first statement of one D1 batch and carries every
//     precondition — the idempotency key is free, the plan is live, the
//     approval is bound and unspent, and every expected revision still holds
//     (`expectedRevisionsSql`);
//   * every later statement re-states `EXISTS(... operation_receipts ...)`, so
//     it writes only if the reservation wrote. D1 rolls a batch back on an SQL
//     error, not because a conditional INSERT matched zero rows, so the guard
//     has to live in each statement rather than in the batch (G2-14: a guard
//     that matches nothing leaves no partial receipt, decision or outbox row).
//
// Moved here from `packages/application/src/command/commit.ts` by U05 so the
// App and the Processor commit a judgement through one statement list instead
// of two. The SQL text and the bind order are unchanged.
import { expectedRevisionsSql, type SqlWrite } from "../core/operations.ts";

export interface ReceiptReservation {
  operationId: string;
  principal: string;
  operationKind: string;
  payloadDigest: string;
  planId: string;
  /** The stored receipt body, already serialized. */
  receiptJson: string;
  now: string;
  approvalId: string;
  /** Canonical JSON of the expected-revision map the plan recorded. */
  expectedRevisionsJson: string;
}

/**
 * Statement 1 of the commit batch: reserve the operation key. Nothing else in
 * the batch can write unless this one did.
 */
export function receiptReservationWrite(input: ReceiptReservation): SqlWrite {
  return {
    sql: `INSERT INTO operation_receipts(operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at,published_at)
        SELECT ?1,?2,?3,?4,?5,'accepted',?6,?7,NULL
        WHERE NOT EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=?1)
        AND EXISTS(SELECT 1 FROM change_plans WHERE plan_id=?5 AND status IN ('planned','approved') AND expires_at>?7)
        AND EXISTS(SELECT 1 FROM approvals WHERE approval_id=?8 AND plan_id=?5 AND plan_digest=?5
          AND approver_actor=?2 AND uses_remaining>0 AND expires_at>?7)
        AND ${expectedRevisionsSql("?9")}`,
    binds: [
      input.operationId,
      input.principal,
      input.operationKind,
      input.payloadDigest,
      input.planId,
      input.receiptJson,
      input.now,
      input.approvalId,
      input.expectedRevisionsJson,
    ],
  };
}

/** Consumes one use of the approval, only if the reservation wrote. */
export function approvalConsumptionWrite(
  approvalId: string,
  operationId: string,
  principal: string,
): SqlWrite {
  return {
    sql: `UPDATE approvals SET uses_remaining=uses_remaining-1 WHERE approval_id=?1 AND uses_remaining>0
        AND EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=?2 AND principal=?3)`,
    binds: [approvalId, operationId, principal],
  };
}

/** Closes the plan, only if the reservation wrote. */
export function planCommittedWrite(
  planId: string,
  operationId: string,
  principal: string,
): SqlWrite {
  return {
    sql: `UPDATE change_plans SET status='committed' WHERE plan_id=?1 AND status IN ('planned','approved')
        AND EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=?2 AND principal=?3)`,
    binds: [planId, operationId, principal],
  };
}

/**
 * One outbox row per target, guarded on both the decision revision the
 * mutation appended and the receipt this batch reserved, and idempotent per
 * (revision, target) so a replayed batch enqueues nothing twice.
 */
export function outboxWrite(
  decisionRevisionId: string,
  principal: string,
  operationId: string,
  target: string,
  now: string,
): SqlWrite {
  return {
    sql: `INSERT INTO decision_outbox(decision_revision_id,principal,operation_id,target,enqueued_at,available_at_ms)
      SELECT ?1,?2,?3,?4,?5,0 WHERE EXISTS(SELECT 1 FROM decision_revisions WHERE id=?1)
      AND EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=?3 AND principal=?2)
      AND NOT EXISTS(SELECT 1 FROM decision_outbox WHERE decision_revision_id=?1 AND target=?4)`,
    binds: [decisionRevisionId, principal, operationId, target, now],
  };
}

/** Marks a plan stale after a commit found a moved revision. */
export function planStaleWrite(planId: string): SqlWrite {
  return {
    sql: "UPDATE change_plans SET status='stale' WHERE plan_id=?1 AND status IN ('planned','approved')",
    binds: [planId],
  };
}

/** The guard every mutation planner splices into its own statements. */
export function receiptExistsGuard(operationId: string, principal: string): SqlWrite {
  return {
    sql: "EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=? AND principal=?)",
    binds: [operationId, principal],
  };
}
