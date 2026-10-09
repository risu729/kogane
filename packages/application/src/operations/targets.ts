// Target resolution and impact measurement over the shared schema. The
// numbers a plan shows come from here, never from a caller: an agent that
// reports "no impact" is not believed (addendum 10 §5).
//
// Counts and identifiers only. No amount, no provider text, and no count of
// anything outside the subject the caller named.
import {
  type CardReviewKind,
  type ChangeKind,
  type ChangePayload,
  type CommandStore,
  type EconomicEventCommandKind,
  isCardReviewKind,
  isEconomicEventKind,
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

import { cardSettlementPlan } from "./card-settlement-target.ts";

import { ownershipReviewRequested } from "../../../domain/src/ownership-review.ts";
import {
  PENDING_POSTED_RELATION_KIND,
  pendingPostedReviewRequested,
} from "../../../domain/src/pending-posted-review.ts";
import { ownershipReviewPlan } from "./ownership-review.ts";
import { pendingPostedReviewPlan } from "./pending-posted-review.ts";

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

/** Resolves one review kind's targets and simulates it, as `resolveAndSimulate` does. */
export type ReviewPlanner = (
  store: CommandStore,
  kind: CardReviewKind,
  payload: ChangePayload,
) => Promise<CommandResult<{ resolved: ResolvedPlan }>>;

/**
 * The card purchase review planners (ADR 0017). The kinds exist in the schema
 * (CORE 0051) and the payload contract; each becomes plannable when a later
 * change registers its planner here. An unregistered kind is refused with
 * `unsupported_semantics` before the plan is stored, so no row is written.
 */
export const REVIEW_PLANNERS: Readonly<Partial<Record<CardReviewKind, ReviewPlanner>>> = {};

/** Resolves one economic-event kind's targets and simulates it. */
export type EconomicEventPlanner = (
  store: CommandStore,
  kind: EconomicEventCommandKind,
  payload: ChangePayload,
) => Promise<CommandResult<{ resolved: ResolvedPlan }>>;

/**
 * The economic-event planners (ADR 0054, G2 vocabulary; CORE 0071). None is
 * registered: the own-transfer planners (`own-transfer-plan.ts`, ADR 0057)
 * exist but stay out of this map until ADR 0054's production gate is met. An unregistered kind is refused with
 * `unsupported_semantics` at plan, simulate, approve and commit, for every
 * principal, so no plan, approval or receipt of these kinds is ever written
 * through the lifecycle.
 */
export const ECONOMIC_EVENT_PLANNERS: Readonly<
  Partial<Record<EconomicEventCommandKind, EconomicEventPlanner>>
> = {};

export async function resolveAndSimulate(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
): Promise<CommandResult<{ resolved: ResolvedPlan }>> {
  if (isCardReviewKind(kind)) {
    const planner = REVIEW_PLANNERS[kind];
    return planner ? planner(store, kind, payload) : commandError("unsupported_semantics", [kind]);
  }
  if (isEconomicEventKind(kind)) {
    const planner = ECONOMIC_EVENT_PLANNERS[kind];
    return planner ? planner(store, kind, payload) : commandError("unsupported_semantics", [kind]);
  }
  if (kind.startsWith("card-settlement.")) return cardSettlementPlan(store, kind, payload);
  if (kind === "relation.accept" || kind === "relation.reject") {
    const relation = relationPayload(payload);
    const linkReview = pendingPostedReviewRequested(relation.evidenceRefs);
    // A pending-to-posted link is only ever reviewed through its proposal:
    // accepting one merges two purchase events, so a bare relation that
    // would claim the link without moving them is refused.
    if (linkReview !== (relation.relationKind === PENDING_POSTED_RELATION_KIND))
      return commandError("invalid_command");
    const resolved = await relationPlan(store, kind, payload);
    if (!resolved.ok) return resolved;
    if (linkReview) return pendingPostedReviewPlan(store, kind, relation, resolved.resolved);
    if (!ownershipReviewRequested(relation.evidenceRefs)) return resolved;
    return ownershipReviewPlan(store, relation, resolved.resolved);
  }
  return identityPlan(store, kind, payload);
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
  const expectedRevisions: ExpectedRevisions = { [subjectRef]: subject.revision };
  const candidate = assign ? assignPayload(payload).candidate : undefined;
  if (candidate !== undefined) {
    const anchorRef = identitySubjectRef("instrument", candidate.anchorIdentifierId);
    const anchor = await store.first<IdentitySubjectRow>(INSTRUMENT_SUBJECT_SQL, [
      candidate.anchorIdentifierId,
      targetId,
    ]);
    if (!anchor || anchor.reference_count === 0 || anchor.revision === null)
      return commandError("target_missing", [anchorRef]);
    if (
      anchor.current_target !== targetId ||
      anchor.revision !== candidate.anchorMappingRevision ||
      subject.revision !== candidate.subjectMappingRevision
    )
      return commandError("stale_context", [anchorRef, subjectRef]);
    expectedRevisions[anchorRef] = anchor.revision;
  }

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
      expectedRevisions,
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
