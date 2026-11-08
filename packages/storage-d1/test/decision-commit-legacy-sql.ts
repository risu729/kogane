// The receipt-guarded statements of src/atomic/decision-commit.ts exactly as
// they shipped before the guard named the command's payload digest: each was
// joined to `operation_receipts` on the key and principal only, so another
// payload's receipt under the same key admitted them. Frozen as text so the
// tests can prove the guarded statements answer exactly as these did on every
// store where no other payload holds the key, and see these write where one
// does. Verbatim; never edit them by hand, and never import them outside tests.
import type { SqlWrite } from "../src/core/operations.ts";

export function legacyApprovalConsumptionWrite(
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

export function legacyPlanCommittedWrite(
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

export function legacyOutboxWrite(
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

export function legacyReceiptExistsGuard(operationId: string, principal: string): SqlWrite {
  return {
    sql: "EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=? AND principal=?)",
    binds: [operationId, principal],
  };
}
