// The plan pins the current candidate decision and the settlement event's head
// (`economic-event:<id>`, ADR 0054). Financial amounts stay in the separate
// operator review; its digest-pinned source refs identify the evidence.
import {
  cardSettlementEligible,
  validCardSettlementFacts,
  type CardSettlementFacts,
  type CardSettlementStatus,
} from "../../../domain/src/card-settlement.ts";
import { economicEventSubject } from "../../../domain/src/economic-contract.ts";
import {
  humanAdoptedRowIdentity,
  type HumanAdoptedRowIdentity,
} from "../../../domain/src/row-identity.ts";
import {
  CARD_SETTLEMENT_KEY_AVAILABLE_SQL,
  cardSettlementReadinessCtes,
} from "../../../read-model/src/card-settlement-readiness.ts";
import {
  commandKey,
  type CardSettlementPayload,
  type ChangeKind,
  type ChangePayload,
  type CommandStore,
  type PlanTarget,
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
  claim_available: number;
  event_id: string | null;
}

/**
 * The candidate `?1` and its `card_settlement_readiness` flags, judged for that
 * candidate alone through the keyed form of the view
 * (packages/read-model/src/card-settlement-readiness.ts): the whole view cost
 * seconds per plan on a two-year store (docs/card-settlements.md, Cost).
 */
export const CARD_SETTLEMENT_PLAN_SQL = `WITH chosen AS (SELECT ?1 AS id), ${cardSettlementReadinessCtes()}
SELECT c.id,c.facts_json,c.status,c.revision,
 r.statement_current,r.bank_current,r.ownership_current,r.allocation_available,
 r.claim_available,c.event_id
FROM chosen JOIN card_settlement_reviews c ON c.id=chosen.id JOIN readiness r ON r.id=c.id`;

/** The candidate's cited bank row, as `humanAdoptedRowIdentity` reads it; ?1 the candidate id. */
export const CARD_SETTLEMENT_BANK_ROW_SQL = `SELECT a.source_id,p.parser_name,t.source_account,t.external_id,t.extra_json
FROM card_settlement_candidates c JOIN transaction_observations t ON t.id=c.bank_observation_id AND t.parse_run_id=c.bank_parse_run_id
JOIN parse_runs p ON p.id=t.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE c.id=?1`;

interface BankRow {
  source_id: string;
  parser_name: string;
  source_account: string;
  external_id: string | null;
  extra_json: string;
}

/**
 * May the human-adopted settlement writer consume the candidate's bank debit
 * (ADR 0054, identity rules), and under which alias class? The cited row and
 * its parse run are immutable, so the planner's answer at commit is this one.
 * Null when the row cannot be read or the facts name no resolved account.
 */
export async function cardSettlementDebitIdentity(
  store: Pick<CommandStore, "first">,
  proposalId: string,
  facts: CardSettlementFacts,
): Promise<HumanAdoptedRowIdentity | null> {
  const row = await store.first<BankRow>(CARD_SETTLEMENT_BANK_ROW_SQL, [proposalId]);
  if (!row || typeof facts.bankDebit.accountId !== "string") return null;
  let extra: unknown = null;
  try {
    extra = JSON.parse(row.extra_json);
  } catch {
    extra = null;
  }
  return humanAdoptedRowIdentity({
    sourceId: row.source_id,
    parserName: row.parser_name,
    sourceAccount: row.source_account,
    externalId: row.external_id,
    extra,
    accountId: facts.bankDebit.accountId,
  });
}

/** The settlement event an acceptance creates, or the one a withdrawal supersedes. */
async function cardSettlementEventId(
  proposalId: string,
  withdraw: boolean,
  acceptedEventId: string | null,
): Promise<string | null> {
  return withdraw ? acceptedEventId : await commandKey("event", [proposalId]);
}

export async function cardSettlementPlan(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
): Promise<CommandResult<{ resolved: ResolvedPlan }>> {
  const { proposalId } = payload as CardSettlementPayload;
  const subjectRef = `card-settlement:${proposalId}`;
  const row = await store.first<CandidateRow>(CARD_SETTLEMENT_PLAN_SQL, [proposalId]);
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
  if (kind === "card-settlement.accept") {
    // ADR 0054: the debit's identity is admitted, or the closed refusal is the answer.
    const identity = await cardSettlementDebitIdentity(store, proposalId, facts);
    if (identity === null) return commandError("incomplete_evidence", [subjectRef]);
    if (!identity.admitted)
      return commandError("unsupported_semantics", [subjectRef, identity.refusal]);
  }
  if (
    kind === "card-settlement.accept" &&
    [row.statement_current, row.bank_current, row.ownership_current, row.allocation_available].some(
      (ready) => ready !== 1,
    )
  )
    return commandError("stale_context", [subjectRef]);
  if (kind === "card-settlement.accept" && row.claim_available !== 1) {
    // Another writer consumes the debit (CORE 0070): its key, or the same
    // fact under another key.
    const key = await store.first<{ key_available: number }>(CARD_SETTLEMENT_KEY_AVAILABLE_SQL, [
      proposalId,
    ]);
    return commandError("stale_context", [
      subjectRef,
      key?.key_available === 1 ? "alias_conflict" : "economic_claim_held",
    ]);
  }
  const eventId = await cardSettlementEventId(proposalId, withdraw, row.event_id);
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
      // The event's head: none for an acceptance, the accepted revision for
      // a withdrawal. A rejection writes no event.
      expectedRevisions: {
        [subjectRef]: row.revision,
        ...(eventId === null || kind === "card-settlement.reject"
          ? {}
          : { [economicEventSubject(eventId)]: withdraw ? row.revision : 0 }),
      },
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
