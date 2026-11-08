// Step 1 of the lifecycle: propose. A plan is immutable and self-identifying:
// its id IS the digest of everything that decides what it would do, so a
// changed target, payload, expected revision or context is a different plan
// and every approval bound to the old digest stops applying (SC17).
//
// A plan's lifetime is not part of what it would do, and its row can never be
// reopened, so a change planned again after its plan expired over unchanged
// data is a renewal (ADR 0080): the same digest input plus the plan-length
// window the new plan is created in. Without it the re-plan found the expired
// row under the same id and the change could not be approved again until an
// unrelated decision moved one of its pins.
//
// Creating a plan changes no economic state.
import { canonicalDigest } from "../../../domain/src/context.ts";
import { instrumentTemporalContextRequested } from "../../../domain/src/instrument-temporal.ts";
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
import type { OperationCall } from "../audit/call.ts";
import type { DecisionCount } from "../audit/diff.ts";
import { verifyInstrumentCandidateContext } from "../operations/instrument-candidate-context.ts";

export interface PlanContext {
  actor: Principal;
  /** The fixed context the plan was read under; part of the digest (INV09). */
  baseContextId: string;
  /** Instant, ISO 8601 with milliseconds. */
  now: string;
  ttlSeconds: number;
  /**
   * The audit call of the route (ADR 0064). When given, the plan's `applied`
   * record is the last statement of the plan's own batch, joined to the row
   * this call inserted, so a plan that already existed records nothing here.
   */
  audit?: OperationCall;
}

/** A simulation reduced to its sizes: the counts a decision diff may carry. */
export function simulationCounts(simulation: Simulation): Partial<Record<DecisionCount, number>> {
  return {
    targets: simulation.targets.length,
    attributedObservationsBefore: simulation.before.attributedObservations,
    attributedObservationsAfter: simulation.after.attributedObservations,
    relationsBefore: simulation.before.relations,
    relationsAfter: simulation.after.relations,
    affectedScopes: simulation.affectedScopes.length,
    affectedParseRuns: simulation.affectedParseRuns,
    invalidations: simulation.invalidations.length,
    outboxTargets: (simulation.outboxTargets ?? []).length,
  };
}

export const PLAN_TTL_SECONDS_DEFAULT = 15 * 60;
const PLAN_TTL_SECONDS_MAX = 24 * 60 * 60;

/**
 * What makes a renewed plan's id differ from the expired plan of the same
 * change (ADR 0080): its lifetime and the index of the lifetime-long window,
 * counted from the epoch, that its creation instant falls in. Both follow
 * from the stored `created_at` and `expires_at`, so a reader can re-derive
 * the id of any stored plan.
 */
export interface PlanRenewal {
  ttlSeconds: number;
  window: number;
}

export async function planDigestOf(input: {
  kind: ChangeKind;
  payload: ChangePayload;
  expectedRevisions: Record<string, number>;
  baseContextId: string;
  renewal?: PlanRenewal;
}): Promise<string> {
  return canonicalDigest({
    kind: input.kind,
    payload: input.payload as unknown as Record<string, unknown>,
    expectedRevisions: input.expectedRevisions,
    baseContextId: input.baseContextId,
    ...(input.renewal
      ? { renewal: { ttlSeconds: input.renewal.ttlSeconds, window: input.renewal.window } }
      : {}),
  });
}

/** The renewal window a plan created at `now` with this lifetime falls in. */
function renewalWindow(now: string, ttlSeconds: number): PlanRenewal {
  return { ttlSeconds, window: Math.floor(Date.parse(now) / (ttlSeconds * 1000)) };
}

/**
 * The renewal a stored plan would carry if it is one, derived from its own
 * `created_at` and `expires_at`; null when they do not describe a lifetime
 * `createPlan` could have given it.
 */
export function storedRenewal(
  plan: Pick<ChangePlan, "createdAt" | "expiresAt">,
): PlanRenewal | null {
  const ttlMs = Date.parse(plan.expiresAt) - Date.parse(plan.createdAt);
  const ttlSeconds = ttlMs / 1000;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > PLAN_TTL_SECONDS_MAX)
    return null;
  return renewalWindow(plan.createdAt, ttlSeconds);
}

/**
 * The id the plan of this change takes at `now` (ADR 0080). The first plan of
 * a change keeps the plain digest. Only when the plan under that digest is
 * still open (`planned` or `approved`) but has expired is the change renewed:
 * a renewal created in the previous window that has not expired is the
 * answer, and otherwise the renewal of the current window. A plan created in
 * window w lives at least until window w + 1 begins, so no open plan of the
 * change can be older than the previous window, and three key lookups decide
 * it. A plan that was committed, marked stale or rejected is never renewed:
 * it is answered as it was.
 */
async function planIdAt(
  store: CommandStore,
  content: Omit<Parameters<typeof planDigestOf>[0], "renewal">,
  now: string,
  ttlSeconds: number,
): Promise<string> {
  const instant = Date.parse(now);
  const lapsed = async (planId: string): Promise<boolean | null> => {
    const row = await store.first<{ status: string; expires_at: string }>(
      "SELECT status,expires_at FROM change_plans WHERE plan_id=?1",
      [planId],
    );
    if (!row) return null;
    return (
      (row.status === "planned" || row.status === "approved") &&
      Date.parse(row.expires_at) <= instant
    );
  };
  const first = await planDigestOf(content);
  if ((await lapsed(first)) !== true) return first;
  const current = renewalWindow(now, ttlSeconds);
  const previous = await planDigestOf({
    ...content,
    renewal: { ttlSeconds, window: current.window - 1 },
  });
  if ((await lapsed(previous)) === false) return previous;
  return planDigestOf({ ...content, renewal: current });
}

/**
 * Validates the payload, resolves its targets against the store, records the
 * revisions those targets are at right now, simulates the change with the same
 * engine the commit will run, and stores the plan under its digest. Planning
 * the same change twice over unchanged data returns the same plan while that
 * plan is open and unexpired; after it expired, a renewal (`planIdAt`).
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
  if (instrumentTemporalContextRequested(ctx.baseContextId))
    return commandError("unsupported_semantics");
  const resolution = await resolveAndSimulate(store, kind, payload);
  if (!resolution.ok) return resolution;
  const candidate = await verifyInstrumentCandidateContext(store, kind, payload, ctx.baseContextId);
  if (!candidate.ok) return candidate;
  const { targets, expectedRevisions, simulation } = resolution.resolved;
  const planId = await planIdAt(
    store,
    { kind, payload, expectedRevisions, baseContextId: ctx.baseContextId },
    ctx.now,
    ctx.ttlSeconds,
  );
  const expiresAt = new Date(Date.parse(ctx.now) + ctx.ttlSeconds * 1000).toISOString();
  const audit = ctx.audit?.effect(
    {
      targetRef: `plan:${planId}`,
      payloadDigest: planId,
      diff: {
        kind: "decision",
        decisionRevisions: 0,
        commitSeq: null,
        counts: simulationCounts({ ...simulation, targets }),
      },
    },
    {
      sql: "EXISTS(SELECT 1 FROM change_plans WHERE plan_id=? AND created_at=? AND created_by=?)",
      binds: [planId, ctx.now, ctx.actor.id],
    },
    { kind: "target" },
  );
  const [insert, recorded] = await store.batch([
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
    ...(audit ? [audit] : []),
  ]);
  ctx.audit?.settle(recorded?.changes);
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
