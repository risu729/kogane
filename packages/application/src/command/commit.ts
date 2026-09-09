// Step 4: commit. This is the whole of addendum 10 §5's pseudo-procedure:
//
//   authorize(actor, requestedOperation, plan.scope)
//   load immutable plan and verify request digest
//   lookup idempotency receipt in principal + operation namespace
//   if completed with identical payload: return existing receipt
//   if same key has a different payload: reject
//   verify approval bound to actor, digest, expiry and scope
//   transaction:
//     conditionally reserve operation key and verify ALL expected revisions
//     append decision revision only when that atomic guard succeeds
//     append stable audit receipt and outbox task under the same guard
//   return stable operation receipt
//
// The reservation is the FIRST statement of one D1 batch and carries every
// precondition. Every later statement is joined to it, so a failed guard
// writes nothing at all — not the receipt, not the decision, not the outbox.
// Expected revisions are therefore a condition of the write, never a preceding
// SELECT that a concurrent commit could invalidate.
import { canonicalDigest } from "../../../domain/src/context.ts";
import {
  type ChangePlan,
  type CommandReceipt,
  type CommandStore,
  type CommitGuard,
  type MutationPlanners,
  type OperationReceiptStatus,
  type OutboxTarget,
  type PreparedWrite,
  type Principal,
  principalCan,
} from "./contract.ts";
import { commandError, type CommandResult } from "./errors.ts";
import { loadPlan } from "./plan.ts";
import { currentRevisions } from "./simulate.ts";
import { expectedRevisionsJson, expectedRevisionsSql } from "../operations/sql.ts";

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export interface CommitInput {
  operationId: unknown;
  principal: Principal;
  planId: unknown;
  approvalId: unknown;
  /** What the caller believes it is committing; a mismatch is a key reuse. */
  idempotencyPayloadDigest?: unknown;
  planners: MutationPlanners;
  now: string;
}

export interface CommitOutput {
  receipt: CommandReceipt;
  /** True when this call returned a receipt an earlier call had already made. */
  replayed: boolean;
}

interface ReceiptRow {
  operation_id: string;
  principal: string;
  payload_digest: string;
  status: string;
  result_json: string;
  created_at: string;
  published_at: string | null;
}
interface ApprovalRow {
  approval_id: string;
  plan_id: string;
  plan_digest: string;
  approver_actor: string;
  scope_json: string;
  expires_at: string;
  uses_remaining: number;
}

const RECEIPT_SQL = `SELECT operation_id,principal,payload_digest,status,result_json,created_at,published_at
 FROM operation_receipts WHERE principal=?1 AND operation_id=?2`;

/** The receipt a completed operation returns, whatever else has since expired. */
export async function getReceipt(
  store: CommandStore,
  principal: string,
  operationId: unknown,
): Promise<CommandResult<{ receipt: CommandReceipt }>> {
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId))
    return commandError("invalid_command");
  const row = await store.first<ReceiptRow>(RECEIPT_SQL, [principal, operationId]);
  if (!row) return commandError("receipt_not_found");
  return { ok: true, receipt: receiptFromRow(row) };
}

function receiptFromRow(row: ReceiptRow): CommandReceipt {
  // The immutable part is stored once; the publication state is read from the
  // columns the outbox dispatcher moves, so a replay never shows a stale one.
  const stored = JSON.parse(row.result_json) as CommandReceipt;
  return {
    ...stored,
    status: row.status as OperationReceiptStatus,
    acceptedAt: row.created_at,
    publishedAt: row.published_at,
  };
}

export async function commit(
  store: CommandStore,
  input: CommitInput,
): Promise<CommandResult<CommitOutput>> {
  if (typeof input.operationId !== "string" || !OPERATION_ID.test(input.operationId))
    return commandError("invalid_command");
  const operationId = input.operationId;
  const principal = input.principal;
  // Committing is `interpretation.accept`, the same capability approving needs.
  // An agent holding only `interpretation.propose` is told to hand the plan to
  // an authenticated approval path instead.
  if (principal.kind !== "human" || !principalCan(principal, "interpretation.accept"))
    return commandError("approval_required");

  const plan = await loadPlan(store, input.planId);
  if (!plan) return commandError("plan_not_found");
  const payloadDigest = await canonicalDigest({
    planId: plan.planId,
    approvalId: typeof input.approvalId === "string" ? input.approvalId : null,
    kind: plan.kind,
    payload: plan.payload as unknown as Record<string, unknown>,
  });
  if (
    input.idempotencyPayloadDigest !== undefined &&
    input.idempotencyPayloadDigest !== payloadDigest
  )
    return commandError("idempotency_conflict", [operationId]);

  // Before anything else: a completed operation answers with its receipt. A
  // reconnecting client must not be told to redo an accepted judgement because
  // the approval it used has since expired (addendum 10 §5).
  const existing = await store.first<ReceiptRow>(RECEIPT_SQL, [principal.id, operationId]);
  if (existing)
    return existing.payload_digest === payloadDigest
      ? { ok: true, replayed: true, receipt: receiptFromRow(existing) }
      : commandError("idempotency_conflict", [operationId]);

  if (Date.parse(plan.expiresAt) <= Date.parse(input.now))
    return commandError("plan_expired", [plan.planId]);
  if (plan.status !== "planned" && plan.status !== "approved")
    return commandError("plan_not_open", [plan.planId]);

  const approval = await store.first<ApprovalRow>(
    `SELECT approval_id,plan_id,plan_digest,approver_actor,scope_json,expires_at,uses_remaining
      FROM approvals WHERE approval_id=?1`,
    [typeof input.approvalId === "string" ? input.approvalId : ""],
  );
  if (!approval) return commandError("approval_not_found");
  if (approval.plan_id !== plan.planId || approval.plan_digest !== plan.planDigest)
    return commandError("stale_context", [plan.planId]);
  // No delegation model yet: the principal that commits is the one that
  // approved. A wider model is a reviewed change, not a configuration value.
  if (approval.approver_actor !== principal.id) return commandError("approval_required");
  if (Date.parse(approval.expires_at) <= Date.parse(input.now))
    return commandError("approval_expired", [approval.approval_id]);
  if (approval.uses_remaining < 1)
    return commandError("approval_exhausted", [approval.approval_id]);
  const scope = JSON.parse(approval.scope_json) as string[];
  if (scope.length > 0 && !Object.keys(plan.expectedRevisions).every((ref) => scope.includes(ref)))
    return commandError("approval_scope_mismatch", [approval.approval_id]);

  const planner = input.planners[plan.kind];
  if (!planner) return commandError("unsupported_semantics", [plan.kind]);

  const expectedJson = expectedRevisionsJson(plan.expectedRevisions);
  const guard: CommitGuard = {
    sql: "EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=? AND principal=?)",
    binds: [operationId, principal.id],
  };
  const mutation = await planner({
    store,
    plan,
    principal,
    operationId,
    now: input.now,
    guard,
  });
  if (!mutation) return commandError("commit_failed", [plan.planId]);

  const outboxTargets = plan.simulation.outboxTargets ?? ["identity-projection"];
  const receipt: CommandReceipt = {
    operationId,
    principal: principal.id,
    operationKind: plan.kind,
    planId: plan.planId,
    planDigest: plan.planDigest,
    payloadDigest,
    status: "accepted",
    acceptedAt: input.now,
    publishedAt: null,
    decisionRevisionId: mutation.decisionRevisionId,
    expectedRevisions: plan.expectedRevisions,
    outboxTargets,
    result: mutation.result,
  };

  const writes: PreparedWrite[] = [
    {
      sql: `INSERT INTO operation_receipts(operation_id,principal,operation_kind,payload_digest,plan_id,status,result_json,created_at,published_at)
        SELECT ?1,?2,?3,?4,?5,'accepted',?6,?7,NULL
        WHERE NOT EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=?1)
        AND EXISTS(SELECT 1 FROM change_plans WHERE plan_id=?5 AND status IN ('planned','approved') AND expires_at>?7)
        AND EXISTS(SELECT 1 FROM approvals WHERE approval_id=?8 AND plan_id=?5 AND plan_digest=?5
          AND approver_actor=?2 AND uses_remaining>0 AND expires_at>?7)
        AND ${expectedRevisionsSql("?9")}`,
      binds: [
        operationId,
        principal.id,
        plan.kind,
        payloadDigest,
        plan.planId,
        JSON.stringify(receipt),
        input.now,
        approval.approval_id,
        expectedJson,
      ],
    },
    ...mutation.writes,
    {
      sql: `UPDATE approvals SET uses_remaining=uses_remaining-1 WHERE approval_id=?1 AND uses_remaining>0
        AND EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=?2 AND principal=?3)`,
      binds: [approval.approval_id, operationId, principal.id],
    },
    {
      sql: `UPDATE change_plans SET status='committed' WHERE plan_id=?1 AND status IN ('planned','approved')
        AND EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=?2 AND principal=?3)`,
      binds: [plan.planId, operationId, principal.id],
    },
    ...outboxTargets.map((target) =>
      outboxWrite(mutation.decisionRevisionId, principal.id, operationId, target, input.now),
    ),
  ];

  const results = await store.batch(writes);
  if (results[0]?.changes === 1) return { ok: true, replayed: false, receipt };
  return failureReason(
    store,
    plan,
    approval.approval_id,
    principal.id,
    operationId,
    payloadDigest,
    input.now,
  );
}

function outboxWrite(
  decisionRevisionId: string,
  principal: string,
  operationId: string,
  target: OutboxTarget,
  now: string,
): PreparedWrite {
  return {
    sql: `INSERT INTO decision_outbox(decision_revision_id,principal,operation_id,target,enqueued_at,available_at_ms)
      SELECT ?1,?2,?3,?4,?5,0 WHERE EXISTS(SELECT 1 FROM decision_revisions WHERE id=?1)
      AND EXISTS(SELECT 1 FROM operation_receipts WHERE operation_id=?3 AND principal=?2)
      AND NOT EXISTS(SELECT 1 FROM decision_outbox WHERE decision_revision_id=?1 AND target=?4)`,
    binds: [decisionRevisionId, principal, operationId, target, now],
  };
}

/** Nothing was written. Name the precondition that failed without guessing. */
async function failureReason(
  store: CommandStore,
  plan: ChangePlan,
  approvalId: string,
  principal: string,
  operationId: string,
  payloadDigest: string,
  now: string,
): Promise<CommandResult<CommitOutput>> {
  const concurrent = await store.first<ReceiptRow>(RECEIPT_SQL, [principal, operationId]);
  if (concurrent)
    return concurrent.payload_digest === payloadDigest
      ? { ok: true, replayed: true, receipt: receiptFromRow(concurrent) }
      : commandError("idempotency_conflict", [operationId]);
  const current = await currentRevisions(store, plan.expectedRevisions);
  const moved = Object.entries(plan.expectedRevisions).filter(
    ([ref, revision]) => current[ref] !== revision,
  );
  if (moved.length > 0) {
    await store.batch([
      {
        sql: "UPDATE change_plans SET status='stale' WHERE plan_id=?1 AND status IN ('planned','approved')",
        binds: [plan.planId],
      },
    ]);
    return commandError("stale_context", [plan.planId, ...moved.map(([ref]) => ref)]);
  }
  const approval = await store.first<ApprovalRow>(
    "SELECT approval_id,plan_id,plan_digest,approver_actor,scope_json,expires_at,uses_remaining FROM approvals WHERE approval_id=?1",
    [approvalId],
  );
  if (!approval) return commandError("approval_not_found");
  if (Date.parse(approval.expires_at) <= Date.parse(now))
    return commandError("approval_expired", [approvalId]);
  if (approval.uses_remaining < 1) return commandError("approval_exhausted", [approvalId]);
  const stored = await store.first<{ status: string }>(
    "SELECT status FROM change_plans WHERE plan_id=?1",
    [plan.planId],
  );
  if (stored && stored.status !== "planned" && stored.status !== "approved")
    return commandError("plan_not_open", [plan.planId]);
  // The operation id is taken by another principal: the key namespace is
  // global, so the caller must choose a new one rather than reuse this.
  const taken = await store.first<{ operation_id: string }>(
    "SELECT operation_id FROM operation_receipts WHERE operation_id=?1",
    [operationId],
  );
  if (taken) return commandError("idempotency_conflict", [operationId]);
  return commandError("commit_failed", [plan.planId]);
}
