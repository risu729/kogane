// A candidate-backed assignment is distinguishable from a direct manual
// correction, and must match the server's current open candidate. Its two
// mapping revisions are pinned by identityPlan and by the lifecycle's atomic
// revision guards. This verification reads only; it adopts nothing.
import {
  validPayload,
  type ChangeKind,
  type ChangePayload,
  type ChangePlan,
  type CommandStore,
} from "../command/contract.ts";
import { commandError, type CommandResult } from "../command/errors.ts";
import { assignPayload } from "./sql.ts";
import { CURRENT_IDENTITY_OBSERVATION_BOUND } from "../query/instrument-candidates-review.ts";
import {
  InstrumentResolutionLimitError,
  queryInstrumentResolution,
} from "../query/instrument-resolution.ts";
import { readIdentityObservationCount } from "../../../read-model/src/instrument-resolution.ts";

/** Old subject-only candidate plans must be re-planned after this contract change. */
export function instrumentCandidatePlanIsPinned(plan: ChangePlan): boolean {
  if (plan.kind !== "identity.assign") return true;
  if (!validPayload(plan.kind, plan.payload)) return false;
  const payload = assignPayload(plan.payload);
  if (payload.candidate === undefined)
    return !plan.baseContextId.startsWith("instrument-candidate:");
  const candidate = payload.candidate;
  return (
    candidate.candidateId === plan.baseContextId &&
    plan.expectedRevisions[`instrument_mapping:${payload.referenceId}`] ===
      candidate.subjectMappingRevision &&
    plan.expectedRevisions[`instrument_mapping:${candidate.anchorIdentifierId}`] ===
      candidate.anchorMappingRevision
  );
}

export async function verifyInstrumentCandidateContext(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
  baseContextId: string,
): Promise<CommandResult<Record<never, never>>> {
  if (kind !== "identity.assign") return { ok: true };
  const assign = assignPayload(payload);
  const candidate = assign.candidate;
  if (candidate === undefined)
    return baseContextId.startsWith("instrument-candidate:")
      ? commandError("invalid_command")
      : { ok: true };
  if (baseContextId !== candidate.candidateId) return commandError("invalid_command");
  if ((await readIdentityObservationCount(store)) > CURRENT_IDENTITY_OBSERVATION_BOUND)
    return commandError("budget_exceeded", ["budget:instrumentResolution"]);
  try {
    const current = await queryInstrumentResolution(store);
    const item = current.candidates.find((row) => row.candidateId === candidate.candidateId);
    const expected = item?.commands?.adopt?.payload;
    if (
      expected === undefined ||
      expected.subject !== assign.subject ||
      expected.referenceId !== assign.referenceId ||
      expected.targetId !== assign.targetId ||
      expected.candidate?.anchorIdentifierId !== candidate.anchorIdentifierId ||
      expected.candidate.anchorMappingRevision !== candidate.anchorMappingRevision ||
      expected.candidate.subjectMappingRevision !== candidate.subjectMappingRevision
    )
      return commandError("stale_context", [candidate.candidateId]);
    return { ok: true };
  } catch (error) {
    if (error instanceof InstrumentResolutionLimitError)
      return commandError("budget_exceeded", ["budget:instrumentResolution"]);
    throw error;
  }
}
