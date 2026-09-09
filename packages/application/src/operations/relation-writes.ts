// How `relation.accept` / `relation.reject` are written. A relation is a typed
// claim with its own decision revision (addendum 05 §2); accepting one never
// derives another (no transitive closure, SC06), and rejecting one appends a
// new claim rather than deleting the old.
//
// Every statement is joined to the commit's receipt guard, so the whole set is
// a no-op when the reservation failed.
import { commandKey, type MutationInput, type MutationWrites } from "../command/contract.ts";
import { relationPayload, relationSubjectRef } from "./sql.ts";

export async function relationMutation(input: MutationInput): Promise<MutationWrites | null> {
  const { plan, principal, operationId, now, guard } = input;
  if (plan.kind !== "relation.accept" && plan.kind !== "relation.reject") return null;
  const relation = relationPayload(plan.payload);
  const subjectRef = relationSubjectRef(relation);
  const revision = (plan.expectedRevisions[subjectRef] ?? 0) + 1;
  const decisionId = await commandKey("dr", ["command", operationId]);
  const relationId = await commandKey("rel", ["command", operationId]);
  const accept = plan.kind === "relation.accept";
  const evidence = JSON.stringify(relation.evidenceRefs);
  return {
    decisionRevisionId: decisionId,
    result: {
      relationId,
      relationKind: relation.relationKind,
      fromRef: relation.fromRef,
      toRef: relation.toRef,
      status: accept ? "accepted" : "rejected",
      revision,
      decisionRevisionId: decisionId,
    },
    writes: [
      // The 0029 ledger keeps recording every judgement operation, so the
      // decision log stays one table whatever adapter accepted the command.
      {
        sql: `INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
          SELECT ?1,?2,'server',?3,?4,?5,?6
          WHERE NOT EXISTS(SELECT 1 FROM decision_operations WHERE operation_id=?1) AND ${guard.sql}`,
        binds: [
          operationId,
          principal.id,
          plan.kind,
          plan.planId,
          JSON.stringify({ relationId, decisionRevisionId: decisionId, planId: plan.planId }),
          now,
          ...guard.binds,
        ],
      },
      {
        sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
          SELECT ?1,'relation',?2,?3,?4,'manual',?5,?6,?7,json(?8),?9,NULL,?10 FROM decision_operations op
          WHERE op.operation_id=?6 AND NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?1)`,
        binds: [
          decisionId,
          relationId,
          revision,
          accept ? "accept" : "reject",
          principal.id,
          operationId,
          relation.reason,
          evidence,
          revision > 1 ? revision - 1 : null,
          now,
        ],
      },
      {
        sql: `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
          SELECT ?1,?2,?3,?4,?5,?6,?7,?8,json(?9),?10 FROM decision_revisions d
          WHERE d.id=?8 AND NOT EXISTS(SELECT 1 FROM entity_relations WHERE id=?1)`,
        binds: [
          relationId,
          relation.relationKind,
          relation.fromRef,
          relation.toRef,
          relation.validFrom,
          relation.validTo,
          accept ? "accepted" : "rejected",
          decisionId,
          evidence,
          now,
        ],
      },
    ],
  };
}
