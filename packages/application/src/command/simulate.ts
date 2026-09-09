// Step 2: simulate. The server runs the same resolution and impact engine the
// commit will run, in dry-run mode, over the current store. It reports the
// blast radius and whether the plan has already gone stale.
//
// A caller's own claim about impact is not an input here. There is no
// "noImpact", "approved" or "expectedRevisions" field a payload can carry:
// `validPayload` rejects unknown keys.
import {
  type ChangePlan,
  type CommandStore,
  type ExpectedRevisions,
  type Simulation,
} from "./contract.ts";
import { commandError, type CommandResult } from "./errors.ts";
import {
  CURRENT_REVISIONS_SQL,
  expectedRevisionsJson,
  revisionsFrom,
  type RevisionRow,
} from "../operations/sql.ts";
import { resolveAndSimulate } from "../operations/targets.ts";
import { planDigestOf } from "./plan.ts";

export interface SimulationReport {
  planId: string;
  planDigest: string;
  simulation: Simulation;
  /** Revisions the plan pinned, and what those subjects are at now. */
  expectedRevisions: ExpectedRevisions;
  currentRevisions: ExpectedRevisions;
  /** True when a re-simulation of the same change would be a different plan. */
  stale: boolean;
  /** The plan a re-simulation would produce; equal to `planId` when fresh. */
  resimulatedPlanId: string;
}

/** What the current store says the plan's subjects are at. */
export async function currentRevisions(
  store: CommandStore,
  expected: ExpectedRevisions,
): Promise<ExpectedRevisions> {
  const rows = await store.all<RevisionRow>(CURRENT_REVISIONS_SQL, [
    expectedRevisionsJson(expected),
  ]);
  return revisionsFrom(rows);
}

export async function simulate(
  plan: ChangePlan,
  store: CommandStore,
): Promise<CommandResult<{ report: SimulationReport }>> {
  const resolution = await resolveAndSimulate(store, plan.kind, plan.payload);
  if (!resolution.ok) return resolution;
  const { expectedRevisions, simulation, targets } = resolution.resolved;
  const resimulatedPlanId = await planDigestOf({
    kind: plan.kind,
    payload: plan.payload,
    expectedRevisions,
    baseContextId: plan.baseContextId,
  });
  const current = await currentRevisions(store, plan.expectedRevisions);
  const stale =
    resimulatedPlanId !== plan.planId ||
    Object.entries(plan.expectedRevisions).some(([ref, revision]) => current[ref] !== revision);
  return {
    ok: true,
    report: {
      planId: plan.planId,
      planDigest: plan.planDigest,
      simulation: { ...simulation, targets },
      expectedRevisions: plan.expectedRevisions,
      currentRevisions: current,
      stale,
      resimulatedPlanId,
    },
  };
}

/** Marks a plan stale so the UI stops offering it; never deletes it. */
export function markStaleWrite(planId: string): { sql: string; binds: readonly unknown[] } {
  return {
    sql: "UPDATE change_plans SET status='stale' WHERE plan_id=?1 AND status IN ('planned','approved')",
    binds: [planId],
  };
}

export async function markStale(store: CommandStore, planId: string): Promise<void> {
  await store.batch([markStaleWrite(planId)]);
}

export function staleError(planId: string): ReturnType<typeof commandError> {
  return commandError("stale_context", [planId]);
}
