// Step 1 of the lifecycle: propose. A plan is immutable and self-identifying:
// its id IS the digest of everything that decides what it would do, so a
// changed target, payload, expected revision or context is a different plan
// and every approval bound to the old digest stops applying (SC17).
//
// Creating a plan changes no economic state.
import { canonicalDigest } from "../../../domain/src/context.ts";
import {
  type ChangeKind,
  type ChangePayload,
  type ChangePlan,
  type CommandStore,
  isChangeKind,
  type PlanStatus,
  type Principal,
  principalCan,
  type Simulation,
  validPayload,
} from "./contract.ts";
import { commandError, type CommandResult } from "./errors.ts";
import { expectedRevisionsJson } from "../operations/sql.ts";
import { resolveAndSimulate } from "../operations/targets.ts";

export interface PlanContext {
  actor: Principal;
  /** The fixed context the plan was read under; part of the digest (INV09). */
  baseContextId: string;
  /** Instant, ISO 8601 with milliseconds. */
  now: string;
  ttlSeconds: number;
}

export const PLAN_TTL_SECONDS_DEFAULT = 15 * 60;
const PLAN_TTL_SECONDS_MAX = 24 * 60 * 60;

export async function planDigestOf(input: {
  kind: ChangeKind;
  payload: ChangePayload;
  expectedRevisions: Record<string, number>;
  baseContextId: string;
}): Promise<string> {
  return canonicalDigest({
    kind: input.kind,
    payload: input.payload as unknown as Record<string, unknown>,
    expectedRevisions: input.expectedRevisions,
    baseContextId: input.baseContextId,
  });
}

/**
 * Validates the payload, resolves its targets against the store, records the
 * revisions those targets are at right now, simulates the change with the same
 * engine the commit will run, and stores the plan under its digest. Planning
 * the same change twice over unchanged data returns the same plan.
 */
export async function createPlan(
  kind: unknown,
  payload: unknown,
  ctx: PlanContext,
  store: CommandStore,
): Promise<CommandResult<{ plan: ChangePlan; created: boolean }>> {
  if (!isChangeKind(kind)) return commandError("unsupported_semantics");
  if (!validPayload(kind, payload)) return commandError("invalid_command");
  if (!principalCan(ctx.actor, "interpretation.propose"))
    return commandError("evidence_restricted");
  if (
    !Number.isSafeInteger(ctx.ttlSeconds) ||
    ctx.ttlSeconds < 60 ||
    ctx.ttlSeconds > PLAN_TTL_SECONDS_MAX
  )
    return commandError("invalid_command");
  const resolution = await resolveAndSimulate(store, kind, payload);
  if (!resolution.ok) return resolution;
  const { targets, expectedRevisions, simulation } = resolution.resolved;
  const planId = await planDigestOf({
    kind,
    payload,
    expectedRevisions,
    baseContextId: ctx.baseContextId,
  });
  const expiresAt = new Date(Date.parse(ctx.now) + ctx.ttlSeconds * 1000).toISOString();
  const [insert] = await store.batch([
    {
      sql: `INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,created_by,created_at,expires_at,status)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,'planned' WHERE NOT EXISTS(SELECT 1 FROM change_plans WHERE plan_id=?1)`,
      binds: [
        planId,
        kind,
        JSON.stringify(payload),
        ctx.baseContextId,
        expectedRevisionsJson(expectedRevisions),
        JSON.stringify({ ...simulation, targets }),
        ctx.actor.id,
        ctx.now,
        expiresAt,
      ],
    },
  ]);
  const stored = await loadPlan(store, planId);
  if (!stored) return commandError("commit_failed", [planId]);
  return { ok: true, plan: stored, created: insert?.changes === 1 };
}

interface PlanRow {
  plan_id: string;
  kind: string;
  payload_json: string;
  base_context_id: string;
  expected_revisions_json: string;
  simulation_json: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  status: string;
}

export async function loadPlan(store: CommandStore, planId: unknown): Promise<ChangePlan | null> {
  if (typeof planId !== "string" || !/^[0-9a-f]{64}$/u.test(planId)) return null;
  const row = await store.first<PlanRow>(
    `SELECT plan_id,kind,payload_json,base_context_id,expected_revisions_json,simulation_json,
      created_by,created_at,expires_at,status FROM change_plans WHERE plan_id=?1`,
    [planId],
  );
  return row ? planFromRow(row) : null;
}

function planFromRow(row: PlanRow): ChangePlan {
  return {
    planId: row.plan_id,
    // The row's key is the digest; there is no second stored copy to disagree.
    planDigest: row.plan_id,
    kind: row.kind as ChangeKind,
    payload: JSON.parse(row.payload_json) as ChangePayload,
    baseContextId: row.base_context_id,
    expectedRevisions: JSON.parse(row.expected_revisions_json) as Record<string, number>,
    simulation: JSON.parse(row.simulation_json) as Simulation,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status as PlanStatus,
  };
}
