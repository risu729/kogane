// A reversal must name the still-current effect of an immutable prior commit.
import type {
  ChangePlan,
  CommandStore,
  CommitGuard,
  RelationPayload,
  IdentityReleasePayload,
} from "../command/contract.ts";
import { getReceipt } from "../command/commit.ts";
import { loadPlan } from "../command/plan.ts";
import {
  expectedRevisionsJson,
  expectedRevisionsSql,
  identitySubjectRef,
  relationSubjectRef,
} from "../operations/sql.ts";
import type { AuditRow } from "../audit/record.ts";
import { AUDIT_ID } from "../audit/vocabulary.ts";
import { DelegatedOperationError } from "./execution.ts";

/** Return the same condition the native receipt reservation must enforce atomically. */
export async function assertDelegatedReversal(
  store: CommandStore,
  subject: string,
  principal: string,
  plan: ChangePlan,
  revertsAuditId: string,
): Promise<CommitGuard> {
  const invalid = (): never => {
    throw new DelegatedOperationError("revert_invalid");
  };
  if (!AUDIT_ID.test(revertsAuditId)) invalid();
  const row = await store.first<AuditRow>(
    "SELECT * FROM audit_records WHERE audit_id=? AND subject=? AND principal IN (?,?) AND operation='command.commit' AND result='applied'",
    [revertsAuditId, subject, principal, subject],
  );
  const prior = row?.target_ref?.startsWith("plan:")
    ? await loadPlan(store, row.target_ref.slice(5))
    : null;
  if (!row || !prior || prior.status !== "committed") return invalid();
  const original = prior.payload as unknown as Record<string, unknown>;
  const next = plan.payload as unknown as Record<string, unknown>;
  const fields =
    prior.kind === "identity.assign" && plan.kind === "identity.release-override"
      ? ["subject", "referenceId"]
      : prior.kind === "relation.accept" && plan.kind === "relation.reject"
        ? ["relationKind", "fromRef", "toRef", "validFrom", "validTo"]
        : prior.kind === "card-settlement.accept" && plan.kind === "card-settlement.withdraw"
          ? ["proposalId"]
          : null;
  if (!fields || !fields.every((field) => original[field] === next[field])) return invalid();
  const refs = JSON.parse(row.refs_json) as string[];
  const operations = refs.filter((ref) => ref.startsWith("operation:"));
  const decisions = refs.filter((ref) => ref.startsWith("decision:"));
  if (operations.length !== 1 || decisions.length !== 1) return invalid();
  const found = await getReceipt(store, row.principal, operations[0]!.slice(10));
  if (!found.ok) return invalid();
  const receipt = found.receipt;
  if (
    receipt.operationId !== operations[0]!.slice(10) ||
    receipt.planId !== prior.planId ||
    receipt.planDigest !== prior.planDigest ||
    receipt.operationKind !== prior.kind ||
    receipt.principal !== row.principal ||
    receipt.decisionRevisionId !== decisions[0]!.slice(9) ||
    receipt.result?.decisionRevisionId !== receipt.decisionRevisionId ||
    expectedRevisionsJson(receipt.expectedRevisions) !==
      expectedRevisionsJson(prior.expectedRevisions)
  )
    return invalid();
  const revision = receipt.result.revision;
  const primary =
    prior.kind === "identity.assign"
      ? identitySubjectRef(
          (plan.payload as IdentityReleasePayload).subject,
          String(original.referenceId),
        )
      : prior.kind === "relation.accept"
        ? relationSubjectRef(plan.payload as RelationPayload)
        : `card-settlement:${String(original.proposalId)}`;
  if (
    !Number.isSafeInteger(revision) ||
    Number(revision) <= 0 ||
    prior.expectedRevisions[primary] === undefined ||
    prior.expectedRevisions[primary]! + 1 !== revision ||
    plan.expectedRevisions[primary] !== revision
  )
    return invalid();

  let target: CommitGuard;
  let subjectKind: string, subjectRef: string, decisionKind: string;
  if (prior.kind === "identity.assign") {
    if (typeof receipt.result.mappingId !== "string") return invalid();
    const account = original.subject === "account";
    const table = account ? "account_mappings" : "instrument_mappings";
    const reference = account ? "source_account_id" : "identifier_id";
    const entity = account ? "account_id" : "instrument_id";
    subjectKind = account ? "account_mapping" : "instrument_mapping";
    subjectRef = String(original.referenceId);
    decisionKind = "assign";
    target = {
      sql: `d.superseded_by IS NULL AND EXISTS(SELECT 1 FROM ${table} m WHERE m.id=? AND m.${reference}=? AND m.revision=? AND m.${entity}=?)`,
      binds: [receipt.result.mappingId, subjectRef, revision, original.targetId],
    };
  } else if (prior.kind === "relation.accept") {
    if (typeof receipt.result.relationId !== "string") return invalid();
    subjectKind = "relation";
    subjectRef = receipt.result.relationId;
    decisionKind = "accept";
    target = {
      sql: "EXISTS(SELECT 1 FROM entity_relations r WHERE r.id=? AND r.decision_revision_id=d.id AND r.kind=? AND r.from_ref=? AND r.to_ref=? AND r.valid_from IS ? AND r.valid_to IS ? AND r.status='accepted')",
      binds: [
        subjectRef,
        original.relationKind,
        original.fromRef,
        original.toRef,
        original.validFrom,
        original.validTo,
      ],
    };
  } else {
    subjectKind = "relation";
    subjectRef = primary;
    decisionKind = "accept";
    target = {
      sql: "EXISTS(SELECT 1 FROM card_settlement_reviews c WHERE c.id=? AND c.revision=? AND c.decision_revision_id=d.id AND c.status='accepted')",
      binds: [original.proposalId, revision],
    };
  }
  const guard: CommitGuard = {
    sql: `EXISTS(SELECT 1 FROM decision_revisions d JOIN decision_operations op ON op.operation_id=d.operation_id WHERE d.id=? AND d.actor_id=? AND d.operation_id=? AND d.subject_kind=? AND d.subject_ref=? AND d.revision=? AND d.decision_kind=? AND d.method='manual' AND op.actor_verification='server' AND ${target.sql}) AND ${expectedRevisionsSql("?")}`,
    binds: [
      receipt.decisionRevisionId,
      row.principal,
      receipt.operationId,
      subjectKind,
      subjectRef,
      revision,
      decisionKind,
      ...target.binds,
      expectedRevisionsJson({ [primary]: Number(revision) }),
    ],
  };
  if (!(await store.first("SELECT 1 AS valid WHERE " + guard.sql, guard.binds))) return invalid();
  return guard;
}
