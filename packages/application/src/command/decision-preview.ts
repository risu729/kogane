// The pre-check of an R2 decision over MCP (ADR 0081, ADR 0084): the one
// function `kogane.command.approve` and `kogane.command.commit` call before
// they issue a confirmation digest or forward a confirmation.
//
// It runs the very checks `approve` and `commit` run (`approvalPrecheck`,
// `commitPrecheck`, `reversalCheck`), in their order, so a refusal here is
// the code and the refs the page's path gives for the same input. Only then
// does it add the one step the page's path has outside its routes: the
// confirmation page offers 承認 and 確定 only on a simulation report that
// loaded and is not stale, and a `prepare` returns that report as its
// preview, so a plan whose simulation fails or is stale is refused here too.
import type { ChangePlan, CommandReceipt, CommandStore } from "./contract.ts";
import { commandError, type CommandError } from "./errors.ts";
import { approvalPrecheck } from "./approve.ts";
import { commitPrecheck, reversalCheck } from "./commit.ts";
import { simulate, type SimulationReport } from "./simulate.ts";

/**
 * A refusal, marked by whose it is. `lifecycle`: `approve` or `commit`
 * refuses the same input with this code and these refs, before or at its
 * batch. `simulation`: only the confirmation page's simulation gate refuses
 * it; the routes would not.
 */
export type DecisionRefusal = CommandError & { source: "lifecycle" | "simulation" };

export type DecisionPreview =
  | { ok: true; report: SimulationReport; replay?: undefined }
  /** `commit` would answer with this completed receipt, as a replay. */
  | { ok: true; replay: CommandReceipt; report?: undefined }
  | DecisionRefusal;

const lifecycle = (refusal: CommandError): DecisionRefusal => ({
  ...commandError(refusal.error, refusal.refs),
  source: "lifecycle",
});

/**
 * The simulation gate, after every lifecycle check passed. A report whose
 * pinned revisions moved is refused as the routes refuse it (`approve`
 * before its batch, `commit` at its batch): `stale_context` with the plan and
 * each moved ref. A report that is stale with nothing moved, or a simulation
 * that fails, is the gate's own refusal.
 */
async function simulationGate(store: CommandStore, plan: ChangePlan): Promise<DecisionPreview> {
  const simulated = await simulate(plan, store);
  if (!simulated.ok)
    return { ...commandError(simulated.error, simulated.refs), source: "simulation" };
  const { report } = simulated;
  if (!report.stale) return { ok: true, report };
  const moved = Object.entries(report.expectedRevisions)
    .filter(([ref, revision]) => report.currentRevisions[ref] !== revision)
    .map(([ref]) => ref);
  return {
    ...commandError("stale_context", [plan.planId, ...moved]),
    source: moved.length > 0 ? "lifecycle" : "simulation",
  };
}

/** `approve`'s own checks of `plan`, then the simulation gate. Reads only. */
export async function previewApproval(
  store: CommandStore,
  plan: ChangePlan,
  input: { planDigest: unknown; now: string },
): Promise<DecisionPreview> {
  const check = await approvalPrecheck(store, plan, input);
  if (!check.ok) return lifecycle(check);
  return simulationGate(store, plan);
}

/** `commit`'s own checks of `plan`, its reversal check, then the simulation gate. Reads only. */
export async function previewCommit(
  store: CommandStore,
  plan: ChangePlan,
  input: {
    operationId: string;
    principal: string;
    approvalId: unknown;
    now: string;
    /** A delegated reversal: the delegating subject and the audit record it reverts. */
    reversal?: { subject: string; revertsAuditId: string };
  },
): Promise<DecisionPreview> {
  const check = await commitPrecheck(store, plan, input);
  if (!check.ok) return lifecycle(check);
  if (check.replay) return { ok: true, replay: check.replay };
  if (input.reversal) {
    const reverted = await reversalCheck(
      store,
      input.reversal.subject,
      input.principal,
      plan,
      input.reversal.revertsAuditId,
    );
    if (!reverted.ok) return lifecycle(reverted);
  }
  return simulationGate(store, plan);
}
