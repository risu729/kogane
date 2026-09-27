// `identity.crosswalk.accept` (ADR 0030): an operator records that a
// collector-era identity value continues an importer-era one.
//
// The plan measures the overlap on the server (`CROSSWALK_PAIR_SQL`), refuses
// unless it is exactly the one-to-one overlap the payload names, and pins the
// automatic mapping revision of every collector source account that carries
// the new value. The commit re-measures the overlap inside its reservation
// statement, so evidence that moved after the plan writes nothing, and then
// appends, under the receipt: the decision, the crosswalk row, and a new rule
// revision for each pinned mapping that still points elsewhere. Nothing is
// updated or deleted; a manual decision on a source account is left as it is.
import { canonicalDigest } from "../../../domain/src/context.ts";
import {
  CROSSWALK_PAIR_SQL,
  CROSSWALK_PRECONDITION_SQL,
  CROSSWALK_SUBJECTS_SQL,
  type CrosswalkCounts,
  type CrosswalkPairRow,
  type CrosswalkSubjectRow,
  crosswalkCounts,
  crosswalkId,
  crosswalkPairUnique,
  crosswalkPreconditionBinds,
  crosswalkSubjectRef,
  importerEntityId,
} from "../../../storage-d1/src/core/identity-crosswalk.ts";
import {
  commandKey,
  type ChangeKind,
  type ChangePayload,
  type CommandStore,
  type IdentityCrosswalkPayload,
  type MutationPlanner,
  type OutboxTarget,
  type PlanTarget,
  type PreparedWrite,
} from "../command/contract.ts";
import { commandError, type CommandResult } from "../command/errors.ts";
import { identitySubjectRef } from "./sql.ts";
import type { ResolvedPlan } from "./targets.ts";

const MAPPING_PREFIX = "account_mapping:";

/** What the plan's collector source accounts attribute today; counts only. */
const SUBJECT_IMPACT_SQL = `SELECT count(*) AS observations,
 count(DISTINCT o.parse_run_id) AS parse_runs,
 sum(CASE WHEN o.kind IN ('balance','position','valuation') THEN 1 ELSE 0 END) AS measures
 FROM current_identity_observations o
 WHERE o.source_account_id IN (SELECT value FROM json_each(?1))
 AND EXISTS(SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id=o.parse_run_id)`;

const DECISION_REVISION_SQL = `SELECT coalesce(max(revision),0) AS revision FROM decision_revisions
 WHERE subject_kind='relation' AND subject_ref=?1`;

function countsOf(payload: IdentityCrosswalkPayload): CrosswalkCounts {
  return {
    sharedRows: payload.sharedRows,
    newOnlyRows: payload.newOnlyRows,
    oldOnlyRows: payload.oldOnlyRows,
    months: payload.months,
  };
}

function sameCounts(left: CrosswalkCounts, right: CrosswalkCounts): boolean {
  return (
    left.sharedRows === right.sharedRows &&
    left.newOnlyRows === right.newOnlyRows &&
    left.oldOnlyRows === right.oldOnlyRows &&
    left.months === right.months
  );
}

/** A mapping the crosswalk supersedes: automatic, unprotected, pointing elsewhere. */
function supersedes(subject: CrosswalkSubjectRow, entity: string): boolean {
  return subject.method === "rule" && subject.protected === 0 && subject.account_id !== entity;
}

/** The digest stored as the crosswalk's evidence: the proposal as reviewed. */
export async function crosswalkProposalDigest(payload: IdentityCrosswalkPayload): Promise<string> {
  return canonicalDigest({
    source: payload.source,
    oldKeyRef: payload.fromRef,
    newKeyRef: payload.toRef,
    ...countsOf(payload),
    verdict: "unique",
  });
}

export async function identityCrosswalkPlan(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
): Promise<CommandResult<{ resolved: ResolvedPlan }>> {
  const crosswalk = payload as IdentityCrosswalkPayload;
  const { source, fromRef, toRef } = crosswalk;
  const subjectRef = crosswalkSubjectRef(source, fromRef, toRef);
  // One old value maps to at most one new value and the other way round: a
  // second crosswalk for either would make the entity ambiguous.
  const recorded = await store.first<{ n: number }>(
    `SELECT count(*) AS n FROM account_identity_crosswalk
     WHERE source_id=?1 AND (from_account_ref=?2 OR to_account_ref=?3)`,
    [source, fromRef, toRef],
  );
  if ((recorded?.n ?? 0) > 0) return commandError("target_ambiguous", [subjectRef]);
  const pair = await store.first<CrosswalkPairRow>(CROSSWALK_PAIR_SQL, [source, toRef, fromRef]);
  if (!pair || pair.shared === 0) return commandError("incomplete_evidence", [subjectRef]);
  if (!crosswalkPairUnique(pair)) return commandError("target_ambiguous", [subjectRef]);
  if (!sameCounts(crosswalkCounts(pair), countsOf(crosswalk)))
    return commandError("stale_context", [subjectRef]);
  const entity = await importerEntityId(source, fromRef);
  const known = await store.first<{ n: number }>("SELECT count(*) AS n FROM accounts WHERE id=?1", [
    entity,
  ]);
  if ((known?.n ?? 0) === 0) return commandError("target_missing", [subjectRef]);
  const subjects = await store.all<CrosswalkSubjectRow>(CROSSWALK_SUBJECTS_SQL, [source, toRef]);
  if (subjects.length === 0) return commandError("target_missing", [subjectRef]);
  const decision = await store.first<{ revision: number }>(DECISION_REVISION_SQL, [subjectRef]);
  const revision = decision?.revision ?? 0;
  const impact = (await store.first<{
    observations: number;
    parse_runs: number;
    measures: number | null;
  }>(SUBJECT_IMPACT_SQL, [JSON.stringify(subjects.map((row) => row.source_account_id))])) ?? {
    observations: 0,
    parse_runs: 0,
    measures: 0,
  };
  const targets: PlanTarget[] = [
    {
      subjectRef,
      currentRevision: revision,
      currentTargetRef: null,
      proposedTargetRef: `account:${entity}`,
    },
    ...subjects.map((row): PlanTarget => ({
      subjectRef: identitySubjectRef("account", row.source_account_id),
      currentRevision: row.revision,
      currentTargetRef: row.account_id,
      proposedTargetRef: supersedes(row, entity) ? entity : row.account_id,
    })),
  ];
  const expectedRevisions: Record<string, number> = {};
  for (const target of targets) expectedRevisions[target.subjectRef] = target.currentRevision;
  const measures = impact.measures ?? 0;
  const outboxTargets: OutboxTarget[] = ["identity-projection"];
  if (measures > 0) outboxTargets.push("balance-projection");
  return {
    ok: true,
    resolved: {
      targets,
      expectedRevisions,
      simulation: {
        kind,
        targets,
        // The rows stay where they are; the collector's source accounts change
        // the entity they are attributed to. The count is the blast radius.
        before: { attributedObservations: impact.observations, relations: 0 },
        after: { attributedObservations: impact.observations, relations: 0 },
        invalidations: [
          "read-model:identity-catalogue",
          "read-model:organization",
          ...(measures > 0 ? ["read-model:balances", "snapshot:dataset-snapshots"] : []),
        ],
        affectedScopes: [source],
        affectedParseRuns: impact.parse_runs,
        outboxTargets,
      },
    },
  };
}

export const identityCrosswalkMutation: MutationPlanner = async (input) => {
  const { plan, principal, operationId, now, guard } = input;
  if (plan.kind !== "identity.crosswalk.accept") return null;
  const payload = plan.payload as IdentityCrosswalkPayload;
  const { source, fromRef, toRef } = payload;
  const subjectRef = crosswalkSubjectRef(source, fromRef, toRef);
  const expected = plan.expectedRevisions[subjectRef];
  if (expected === undefined) return null;
  const entity = await importerEntityId(source, fromRef);
  const id = await crosswalkId(source, fromRef, toRef);
  const decisionId = await commandKey("dr", ["identity-crosswalk", operationId]);
  const counts = countsOf(payload);
  const evidence = { ...counts, proposalDigest: await crosswalkProposalDigest(payload) };
  const mappings = Object.entries(plan.expectedRevisions)
    .filter(([ref]) => ref.startsWith(MAPPING_PREFIX))
    .map(([ref, revision]) => ({ sourceAccountId: ref.slice(MAPPING_PREFIX.length), revision }))
    .sort((a, b) => (a.sourceAccountId < b.sourceAccountId ? -1 : 1));
  const result = {
    crosswalkId: id,
    source,
    fromRef,
    toRef,
    accountId: entity,
    decisionRevisionId: decisionId,
    pinnedMappings: mappings.length,
  };
  const writes: PreparedWrite[] = [];
  const add = (sql: string, binds: unknown[]) =>
    writes.push({ sql: `${sql} AND ${guard.sql}`, binds: [...binds, ...guard.binds] });
  add(
    `INSERT INTO decision_operations(operation_id,actor_id,actor_verification,action,payload_digest,result_json,created_at)
 SELECT ?,?,'server',?,?,?,? WHERE 1`,
    [operationId, principal.id, plan.kind, plan.planId, JSON.stringify(result), now],
  );
  add(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,created_at)
 SELECT ?,'relation',?,?,'accept','manual',?,?,?,json_array(?),?,? WHERE 1`,
    [
      decisionId,
      subjectRef,
      expected + 1,
      principal.id,
      operationId,
      payload.reason,
      `identity-crosswalk:${id}`,
      expected || null,
      now,
    ],
  );
  add(
    `INSERT INTO account_identity_crosswalk(id,source_id,from_account_ref,to_account_ref,evidence_json,decision_revision_id,operation_id,actor_id,created_at)
 SELECT ?,?,?,?,?,?,?,?,? WHERE 1`,
    [
      id,
      source,
      fromRef,
      toRef,
      JSON.stringify(evidence),
      decisionId,
      operationId,
      principal.id,
      now,
    ],
  );
  // The automatic mapping of each collector source account moves to the
  // importer-era entity by a new rule revision, as the rule now derives it
  // (`accountEntityId`). Same policy version, reason, label and status; only
  // the entity differs. A mapping that moved since the plan fails the
  // expected-revision guard before anything is written; one a manual decision
  // holds, or that already points at the entity, is left alone.
  for (const mapping of mappings)
    add(
      `INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
 SELECT ?,c.source_account_id,c.revision+1,?,'rule',c.reason,c.policy_version,?,c.label,c.status
 FROM current_account_mappings c WHERE c.source_account_id=? AND c.revision=? AND c.method='rule' AND c.account_id<>?
 AND NOT EXISTS(SELECT 1 FROM protected_mapping_subjects p WHERE p.subject_kind='account_mapping' AND p.subject_ref=c.source_account_id)`,
      [
        await commandKey("am", ["identity-crosswalk", id, mapping.sourceAccountId]),
        entity,
        now,
        mapping.sourceAccountId,
        mapping.revision,
        entity,
      ],
    );
  return {
    writes,
    decisionRevisionId: decisionId,
    result,
    precondition: {
      sql: `${CROSSWALK_PRECONDITION_SQL} AND EXISTS(SELECT 1 FROM accounts WHERE id=?)`,
      binds: [...crosswalkPreconditionBinds(source, fromRef, toRef, counts), entity],
    },
  };
};
