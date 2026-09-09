// Step 3: approve. An approval is a receipt bound to one principal, one plan
// digest, a scope, an expiry and a number of uses (addendum 10 §5). An agent
// that sends `approved: true` is not approving anything: this function refuses
// any principal without `interpretation.accept`, which agents never hold.
import {
  commandKey,
  type ApprovalReceipt,
  type ChangePlan,
  type CommandStore,
  type Principal,
  principalCan,
} from "./contract.ts";
import { commandError, type CommandResult } from "./errors.ts";
import { loadPlan } from "./plan.ts";
import { currentRevisions, markStale } from "./simulate.ts";

export const APPROVAL_TTL_SECONDS_DEFAULT = 10 * 60;
const APPROVAL_TTL_SECONDS_MAX = 60 * 60;
const APPROVAL_USES_DEFAULT = 1;
const SCOPE_MAX = 50;

export interface ApproveInput {
  planId: unknown;
  /** The digest the human confirmed on screen; must equal the stored plan's. */
  planDigest: unknown;
  actor: Principal;
  scope: readonly string[];
  ttlSeconds: number;
  uses?: number;
  now: string;
}

export async function approve(
  store: CommandStore,
  input: ApproveInput,
): Promise<CommandResult<{ approval: ApprovalReceipt; plan: ChangePlan }>> {
  if (
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds < 30 ||
    input.ttlSeconds > APPROVAL_TTL_SECONDS_MAX ||
    input.scope.length > SCOPE_MAX ||
    input.scope.some(
      (entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 512,
    )
  )
    return commandError("invalid_command");
  const uses = input.uses ?? APPROVAL_USES_DEFAULT;
  if (!Number.isSafeInteger(uses) || uses < 1 || uses > 10) return commandError("invalid_command");
  // Approving is `interpretation.accept`. Initially only human operators hold
  // it; the check is here rather than in the transport so every adapter (HTTP,
  // MCP, CLI) inherits it.
  if (input.actor.kind !== "human" || !principalCan(input.actor, "interpretation.accept"))
    return commandError("approval_required");

  const plan = await loadPlan(store, input.planId);
  if (!plan) return commandError("plan_not_found");
  if (typeof input.planDigest !== "string" || input.planDigest !== plan.planDigest)
    return commandError("stale_context", [plan.planId]);
  if (Date.parse(plan.expiresAt) <= Date.parse(input.now))
    return commandError("plan_expired", [plan.planId]);
  if (plan.status !== "planned" && plan.status !== "approved")
    return commandError("plan_not_open", [plan.planId]);

  // SC17: the human confirmed a plan pinned to rev7. If a concurrent change
  // moved it to rev8, the approval is refused and the plan is marked stale;
  // re-simulating produces a different digest, so the old approval can never
  // be reused for the new one.
  const current = await currentRevisions(store, plan.expectedRevisions);
  const moved = Object.entries(plan.expectedRevisions).filter(
    ([ref, revision]) => current[ref] !== revision,
  );
  if (moved.length > 0) {
    await markStale(store, plan.planId);
    return commandError("stale_context", [plan.planId, ...moved.map(([ref]) => ref)]);
  }

  const scope = [...input.scope].sort();
  const createdAt = input.now;
  const expiresAt = new Date(Date.parse(createdAt) + input.ttlSeconds * 1000).toISOString();
  const approvalId = await commandKey("ap", [plan.planId, input.actor.id, createdAt, scope, uses]);
  const [insert] = await store.batch([
    {
      sql: `INSERT INTO approvals(approval_id,plan_id,plan_digest,approver_actor,approver_verification,scope_json,expires_at,uses_remaining,created_at)
        SELECT ?1,?2,?3,?4,'server',?5,?6,?7,?8
        WHERE NOT EXISTS(SELECT 1 FROM approvals WHERE approval_id=?1)
        AND EXISTS(SELECT 1 FROM change_plans WHERE plan_id=?2 AND status IN ('planned','approved') AND expires_at>?8)`,
      binds: [
        approvalId,
        plan.planId,
        plan.planDigest,
        input.actor.id,
        JSON.stringify(scope),
        expiresAt,
        uses,
        createdAt,
      ],
    },
    {
      sql: `UPDATE change_plans SET status='approved' WHERE plan_id=?1 AND status='planned'
        AND EXISTS(SELECT 1 FROM approvals WHERE approval_id=?2)`,
      binds: [plan.planId, approvalId],
    },
  ]);
  if (insert?.changes !== 1) {
    const existing = await store.first<{ approval_id: string }>(
      "SELECT approval_id FROM approvals WHERE approval_id=?1",
      [approvalId],
    );
    // A replay of the same approval at the same instant is the same receipt.
    if (!existing) return commandError("plan_not_open", [plan.planId]);
  }
  return {
    ok: true,
    plan: { ...plan, status: "approved" },
    approval: {
      approvalId,
      planId: plan.planId,
      planDigest: plan.planDigest,
      approverActor: input.actor.id,
      approverVerification: "server",
      scope,
      expiresAt,
      usesRemaining: uses,
      createdAt,
    },
  };
}
