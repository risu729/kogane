import {
  commandKey,
  type MutationPlanner,
  type PreparedWrite,
  type CardSettlementPayload,
} from "../../../packages/application/src/command/contract.ts";
import {
  validCardSettlementFacts,
  cardSettlementEligible,
} from "../../../packages/domain/src/card-settlement.ts";

interface Row {
  id: string;
  revision: number;
  status: string;
  facts_json: string;
  decision_revision_id: string | null;
  event_id: string | null;
  settlement_id: string | null;
}
export const cardSettlementMutation: MutationPlanner = async (input) => {
  const { store, plan, principal, operationId, now, guard } = input;
  if (!plan.kind.startsWith("card-settlement.")) return null;
  const payload = plan.payload as CardSettlementPayload;
  const row = await store.first<Row>("SELECT * FROM card_settlement_reviews WHERE id=?", [
    payload.proposalId,
  ]);
  if (!row) return null;
  const facts: unknown = JSON.parse(row.facts_json);
  if (!validCardSettlementFacts(facts)) return null;
  const accept = plan.kind === "card-settlement.accept";
  const withdraw = plan.kind === "card-settlement.withdraw";
  const expected = plan.expectedRevisions["card-settlement:" + row.id];
  if (
    expected !== row.revision ||
    (withdraw ? row.status !== "accepted" : row.status !== "proposed")
  )
    return null;
  if (accept && !cardSettlementEligible(facts)) return null;
  const revision = row.revision + 1;
  const decisionId = await commandKey("dr", ["card-settlement", operationId]);
  const eventId = withdraw ? row.event_id : accept ? await commandKey("event", [row.id]) : null;
  const allocationId = withdraw
    ? row.settlement_id
    : accept
      ? await commandKey("allocation", [row.id])
      : null;
  if (withdraw && (!eventId || !allocationId)) return null;
  const status = withdraw ? "withdrawn" : accept ? "accepted" : "rejected";
  const result = {
    proposalId: row.id,
    status,
    revision,
    decisionRevisionId: decisionId,
    eventId,
    obligationId: null,
    settlementId: allocationId,
  };
  const writes: PreparedWrite[] = [];
  const add = (sql: string, binds: unknown[]) =>
    writes.push({ sql: sql + " AND " + guard.sql, binds: [...binds, ...guard.binds] });
  add(
    `INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
 SELECT ?,?,'server',?,?,?,? WHERE 1`,
    [operationId, principal.id, plan.kind, plan.planId, JSON.stringify(result), now],
  );
  const evidence = JSON.stringify([
    facts.statement.ref.id,
    facts.bankDebit.ref.id,
    ...facts.ownershipEvidenceRefs,
  ]);
  const decision = (id: string, subject: string, rev: number, previous: number | null) => {
    add(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,created_at)
   SELECT ?,'relation',?,?,?,'manual',?,?,?,?,?,? WHERE 1`,
      [
        id,
        subject,
        rev,
        withdraw ? "supersede" : accept ? "accept" : "reject",
        principal.id,
        operationId,
        payload.reason,
        evidence,
        previous,
        now,
      ],
    );
  };
  decision(decisionId, "card-settlement:" + row.id, revision, row.revision || null);
  if (eventId && allocationId) {
    const eventDecision = await commandKey("dr", ["card-settlement-event", operationId]);
    const allocationDecision = await commandKey("dr", ["card-settlement-allocation", operationId]);
    decision(eventDecision, "event:" + eventId, revision, row.revision || null);
    decision(allocationDecision, "allocation:" + allocationId, revision, row.revision || null);
    add(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,created_at)
   SELECT ?,?,'card_settlement',?,?,?,'cash-movement',?,?,? WHERE 1`,
      [
        eventId,
        revision,
        withdraw ? "unknown" : "debited",
        withdraw ? "conflicting_evidence" : null,
        JSON.stringify(facts.bankDebit.occurred),
        evidence,
        eventDecision,
        now,
      ],
    );
    if (accept && facts.statement.amount.value.status === "exact") {
      const { coefficient, scale } = facts.statement.amount.value.value;
      // This cash leg cites an existing observation. It is not an additional expense or balance write.
      add(
        `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,role,basis)
    SELECT ?,?,0,?,?,'exact',?,?,'decrease','cash-movement' WHERE 1`,
        [
          eventId,
          revision,
          facts.bankDebit.accountId,
          facts.statement.amount.unitRef,
          coefficient,
          scale,
        ],
      );
      // A billed payment total does not prove principal reduction or fee decomposition.
      add(
        `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,value_reason_code,role,basis)
    SELECT ?,?,1,?,?,'missing','statement_principal_and_fees_unknown','unresolved','obligation-change' WHERE 1`,
        [eventId, revision, facts.statement.accountId, facts.statement.amount.unitRef],
      );
      add(
        `INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,created_at)
    SELECT ?,?,?,'settlement',?,?,?,?,? WHERE 1`,
        [
          allocationId,
          facts.bankDebit.ref.id,
          "event:" + eventId,
          facts.statement.amount.unitRef,
          coefficient,
          scale,
          allocationDecision,
          now,
        ],
      );
    } else {
      add("UPDATE economic_event_revisions SET superseded_by=? WHERE event_id=? AND revision=?", [
        eventId + "@" + revision,
        eventId,
        row.revision,
      ]);
      add(
        `INSERT INTO card_settlement_allocation_withdrawals(settlement_id,decision_revision_id,created_at)
    SELECT ?,?,? WHERE 1`,
        [allocationId, allocationDecision, now],
      );
    }
  }
  add(
    `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
  SELECT ?,?,?,?,?,NULL,?,? WHERE 1`,
    [row.id, revision, status, decisionId, eventId, allocationId, now],
  );
  return {
    writes,
    decisionRevisionId: decisionId,
    result,
    precondition: {
      sql:
        `EXISTS(SELECT 1 FROM card_settlement_reviews c JOIN card_settlement_readiness ready ON ready.id=c.id
   WHERE c.id=? AND c.revision=? AND c.status=?` +
        (accept
          ? " AND ready.statement_current=1 AND ready.bank_current=1 AND ready.ownership_current=1 AND ready.allocation_available=1"
          : "") +
        ")",
      binds: [row.id, expected, withdraw ? "accepted" : "proposed"],
    },
  };
};
