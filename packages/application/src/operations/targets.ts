// Target resolution and impact measurement over the shared schema. The
// numbers a plan shows come from here, never from a caller: an agent that
// reports "no impact" is not believed (addendum 10 §5).
//
// Counts and identifiers only. No amount, no provider text, and no count of
// anything outside the subject the caller named.
import {
  type ChangeKind,
  type ChangePayload,
  type CommandStore,
  type ExpectedRevisions,
  type OutboxTarget,
  type PlanTarget,
  type Simulation,
} from "../command/contract.ts";
import { commandError, type CommandResult } from "../command/errors.ts";
import {
  assignPayload,
  relationPayload,
  releasePayload,
  relationSubjectRef,
  identitySubjectRef,
} from "./sql.ts";

const SCOPE_LIMIT = 50;

interface IdentitySubjectRow {
  reference_count: number;
  target_count: number;
  revision: number | null;
  current_target: string | null;
}
interface ImpactRow {
  observations: number;
  parse_runs: number;
  measures: number | null;
}
interface RelationRow {
  revision: number;
  current_status: string | null;
}

const ACCOUNT_SUBJECT_SQL = `SELECT
 (SELECT count(*) FROM source_accounts WHERE id=?1) AS reference_count,
 (SELECT count(*) FROM accounts WHERE id=?2) AS target_count,
 (SELECT max(revision) FROM account_mappings WHERE source_account_id=?1) AS revision,
 (SELECT m.account_id FROM current_account_mappings m WHERE m.source_account_id=?1) AS current_target`;
const INSTRUMENT_SUBJECT_SQL = `SELECT
 (SELECT count(*) FROM instrument_identifiers WHERE id=?1) AS reference_count,
 (SELECT count(*) FROM instruments WHERE id=?2) AS target_count,
 (SELECT max(revision) FROM instrument_mappings WHERE identifier_id=?1) AS revision,
 (SELECT m.instrument_id FROM current_instrument_mappings m WHERE m.identifier_id=?1) AS current_target`;

// What a normal reader can already see, and nothing else. Since migration 0026
// "current" is membership in `published_parse_runs`, so every impact query
// joins the projection rather than trusting the identity view's own filter
// (docs/publication-gate.md). An unadopted successful run is a future
// candidate: it must not appear in the difference an operator approves.
const PUBLISHED = `EXISTS(SELECT 1 FROM published_parse_runs published WHERE published.parse_run_id=o.parse_run_id)`;
const ACCOUNT_IMPACT_SQL = `SELECT count(*) AS observations,
 count(DISTINCT o.parse_run_id) AS parse_runs,
 sum(CASE WHEN o.kind IN ('balance','position','valuation') THEN 1 ELSE 0 END) AS measures
 FROM current_identity_observations o WHERE o.source_account_id=?1 AND ${PUBLISHED}`;
const ACCOUNT_SCOPE_SQL = `SELECT DISTINCT sa.source_id AS scope FROM source_accounts sa WHERE sa.id=?1`;
const INSTRUMENT_IMPACT_SQL = `SELECT count(*) AS observations,
 count(DISTINCT o.parse_run_id) AS parse_runs,
 sum(CASE WHEN o.kind IN ('balance','position','valuation') THEN 1 ELSE 0 END) AS measures
 FROM identity_instrument_uses u JOIN current_identity_observations o ON o.id=u.identity_observation_id
 WHERE u.identifier_id=?1 AND ${PUBLISHED}`;
const INSTRUMENT_SCOPE_SQL = `SELECT DISTINCT sa.source_id AS scope
 FROM identity_instrument_uses u JOIN current_identity_observations o ON o.id=u.identity_observation_id
 JOIN source_accounts sa ON sa.id=o.source_account_id
 WHERE u.identifier_id=?1 AND ${PUBLISHED} ORDER BY 1 LIMIT ${SCOPE_LIMIT}`;
const RELATION_SQL = `SELECT count(*) AS revision,
 (SELECT r.status FROM entity_relations r WHERE r.kind=?1 AND r.from_ref=?2 AND r.to_ref=?3
   ORDER BY r.created_at DESC,r.id DESC LIMIT 1) AS current_status
 FROM entity_relations WHERE kind=?1 AND from_ref=?2 AND to_ref=?3`;

/** Typed reference prefixes the store can resolve; anything else is opaque. */
const RESOLVABLE_REFS = [
  ["source_account:", "source_accounts"],
  ["account:", "accounts"],
  ["instrument:", "instruments"],
  ["identifier:", "instrument_identifiers"],
] as const;

export interface ResolvedPlan {
  targets: PlanTarget[];
  expectedRevisions: ExpectedRevisions;
  simulation: Simulation;
}

export async function resolveAndSimulate(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
): Promise<CommandResult<{ resolved: ResolvedPlan }>> {
  return kind === "relation.accept" || kind === "relation.reject"
    ? relationPlan(store, kind, payload)
    : identityPlan(store, kind, payload);
}

async function identityPlan(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
): Promise<CommandResult<{ resolved: ResolvedPlan }>> {
  const assign = kind === "identity.assign";
  const base = releasePayload(payload);
  const targetId = assign ? assignPayload(payload).targetId : null;
  const account = base.subject === "account";
  const subjectRef = identitySubjectRef(base.subject, base.referenceId);
  const subject = await store.first<IdentitySubjectRow>(
    account ? ACCOUNT_SUBJECT_SQL : INSTRUMENT_SUBJECT_SQL,
    [base.referenceId, targetId],
  );
  if (!subject || subject.reference_count === 0)
    return commandError("target_missing", [subjectRef]);
  if (assign && subject.target_count === 0) return commandError("target_missing", [subjectRef]);
  // Both identity kinds correct an existing mapping revision: creating the
  // first mapping for a reference is automatic policy's job, and releasing a
  // protection that is not there would record a decision about nothing. The
  // commit's own in-batch guards refuse both cases too.
  if (subject.revision === null) return commandError("target_missing", [subjectRef]);

  const impact = (await store.first<ImpactRow>(
    account ? ACCOUNT_IMPACT_SQL : INSTRUMENT_IMPACT_SQL,
    [base.referenceId],
  )) ?? { observations: 0, parse_runs: 0, measures: 0 };
  const scopes = await store.all<{ scope: string | null }>(
    account ? ACCOUNT_SCOPE_SQL : INSTRUMENT_SCOPE_SQL,
    [base.referenceId],
  );
  const revision = subject.revision ?? 0;
  const target: PlanTarget = {
    subjectRef,
    currentRevision: revision,
    currentTargetRef: subject.current_target,
    // A release does not choose a target: it lets automatic policy choose the
    // next one, so the plan shows "unknown until the policy runs", not a guess.
    proposedTargetRef: targetId,
  };
  const measures = impact.measures ?? 0;
  const outboxTargets: OutboxTarget[] = ["identity-projection"];
  if (measures > 0) outboxTargets.push("balance-projection");
  const invalidations = [
    "read-model:identity-catalogue",
    "read-model:organization",
    ...(measures > 0 ? ["read-model:balances", "snapshot:dataset-snapshots"] : []),
    ...(assign ? [] : ["policy:reapplied"]),
  ];
  return {
    ok: true,
    resolved: {
      targets: [target],
      expectedRevisions: { [subjectRef]: revision },
      simulation: {
        kind,
        targets: [target],
        // The rows do not appear or disappear; they change which account or
        // instrument they are attributed to. The count is the blast radius.
        before: { attributedObservations: impact.observations, relations: 0 },
        after: { attributedObservations: impact.observations, relations: 0 },
        invalidations,
        affectedScopes: scopes.flatMap((row) => (row.scope === null ? [] : [row.scope])),
        affectedParseRuns: impact.parse_runs,
        outboxTargets,
      },
    },
  };
}

async function relationPlan(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
): Promise<CommandResult<{ resolved: ResolvedPlan }>> {
  const relation = relationPayload(payload);
  const subjectRef = relationSubjectRef(relation);
  for (const ref of [relation.fromRef, relation.toRef]) {
    const known = RESOLVABLE_REFS.find(([prefix]) => ref.startsWith(prefix));
    if (known === undefined) continue;
    const row = await store.first<{ found: number }>(
      `SELECT count(*) AS found FROM ${known[1]} WHERE id=?1`,
      [ref.slice(known[0].length)],
    );
    if (!row || row.found === 0) return commandError("target_missing", [subjectRef]);
  }
  const current = (await store.first<RelationRow>(RELATION_SQL, [
    relation.relationKind,
    relation.fromRef,
    relation.toRef,
  ])) ?? { revision: 0, current_status: null };
  const target: PlanTarget = {
    subjectRef,
    currentRevision: current.revision,
    currentTargetRef: current.current_status,
    proposedTargetRef: kind === "relation.accept" ? "accepted" : "rejected",
  };
  return {
    ok: true,
    resolved: {
      targets: [target],
      expectedRevisions: { [subjectRef]: current.revision },
      simulation: {
        kind,
        targets: [target],
        before: { attributedObservations: 0, relations: current.revision },
        after: { attributedObservations: 0, relations: current.revision + 1 },
        // A typed relation is a claim, never a transitive merge: accepting
        // connection_contains does not create same_account (SC06).
        invalidations: ["read-model:relations"],
        affectedScopes: [],
        affectedParseRuns: 0,
        outboxTargets: ["identity-projection"],
      },
    },
  };
}
