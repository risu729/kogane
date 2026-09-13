// The plan pins the current candidate decision. Financial amounts stay in the
// separate operator review; its digest-pinned source refs identify the evidence.
import {
  cardSettlementEligible,
  validCardSettlementFacts,
  type CardSettlementStatus,
} from "../../../domain/src/card-settlement.ts";
import type {
  CardSettlementPayload,
  ChangeKind,
  ChangePayload,
  CommandStore,
  PlanTarget,
} from "../command/contract.ts";
import { commandError, type CommandResult } from "../command/errors.ts";
import type { ResolvedPlan } from "./targets.ts";

interface CandidateRow {
  id: string;
  facts_json: string;
  status: CardSettlementStatus;
  revision: number;
  statement_current: number;
  bank_current: number;
  ownership_current: number;
  allocation_available: number;
}

export async function cardSettlementPlan(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
): Promise<CommandResult<{ resolved: ResolvedPlan }>> {
  const { proposalId } = payload as CardSettlementPayload;
  const subjectRef = `card-settlement:${proposalId}`;
  const row = await store.first<CandidateRow>(
    `SELECT c.id,c.facts_json,c.status,c.revision,
      r.statement_current,r.bank_current,r.ownership_current,r.allocation_available
     FROM card_settlement_reviews c JOIN card_settlement_readiness r ON r.id=c.id WHERE c.id=?1`,
    [proposalId],
  );
  if (!row) return commandError("target_missing", [subjectRef]);
  const withdraw = kind === "card-settlement.withdraw";
  if ((withdraw && row.status !== "accepted") || (!withdraw && row.status !== "proposed"))
    return commandError("stale_context", [subjectRef]);
  let facts: unknown;
  try {
    facts = JSON.parse(row.facts_json);
  } catch {
    return commandError("incomplete_evidence", [subjectRef]);
  }
  if (!validCardSettlementFacts(facts)) return commandError("incomplete_evidence", [subjectRef]);
  if (kind === "card-settlement.accept" && !cardSettlementEligible(facts))
    return commandError("needs_scope_resolution", [subjectRef]);
  if (
    kind === "card-settlement.accept" &&
    [row.statement_current, row.bank_current, row.ownership_current, row.allocation_available].some(
      (ready) => ready !== 1,
    )
  )
    return commandError("stale_context", [subjectRef]);
  const target: PlanTarget = {
    subjectRef,
    currentRevision: row.revision,
    currentTargetRef: row.status,
    proposedTargetRef: withdraw
      ? "withdrawn"
      : kind === "card-settlement.accept"
        ? "accepted"
        : "rejected",
  };
  const acceptedBefore = row.status === "accepted" ? 1 : 0;
  const acceptedAfter = kind === "card-settlement.accept" ? 1 : 0;
  return {
    ok: true,
    resolved: {
      targets: [target],
      expectedRevisions: { [subjectRef]: row.revision },
      simulation: {
        kind,
        targets: [target],
        before: { attributedObservations: 2, relations: acceptedBefore },
        after: { attributedObservations: 2, relations: acceptedAfter },
        invalidations: ["read-model:card-settlements", "read-model:economic-events"],
        affectedScopes: [...new Set([facts.statement.sourceId, facts.bankDebit.sourceId])].sort(),
        affectedParseRuns: new Set([facts.statement.ref.revision, facts.bankDebit.ref.revision])
          .size,
        outboxTargets: ["identity-projection"],
      },
    },
  };
}
