import { validCardSettlementFacts } from "../../../domain/src/card-settlement.ts";
import { cardSettlementReadinessCtes } from "../../../read-model/src/card-settlement-readiness.ts";
import {
  ownershipReviewPartyRef,
  ownershipReviewEvidenceRefs,
  ownershipRevisionRef,
} from "../../../domain/src/ownership-review.ts";
import { commandError, type CommandResult } from "../command/errors.ts";
import type {
  CommandStore,
  RelationPayload,
  CommitGuard,
  PlanTarget,
} from "../command/contract.ts";
import type { ResolvedPlan } from "./targets.ts";

interface CandidateRow {
  id: string;
  facts_json: string;
  revision: number;
  status: string;
  statement_current: number;
  bank_current: number;
}
interface MappingRow {
  id: string;
  source_account_id: string;
  revision: number;
  account_id: string;
}
interface OwnershipReview {
  targets: PlanTarget[];
  sourceId: string;
  precondition: CommitGuard;
}
/**
 * The candidate `?` and whether both its source facts are still current,
 * judged for that candidate alone through the keyed form of
 * `card_settlement_readiness` (packages/read-model/src/card-settlement-readiness.ts)
 * rather than the whole view.
 */
export const OWNERSHIP_REVIEW_CANDIDATE_SQL = `WITH chosen AS (SELECT ? AS id), ${cardSettlementReadinessCtes()}
SELECT c.id,c.facts_json,c.revision,c.status,r.statement_current,r.bank_current
FROM chosen JOIN card_settlement_reviews c ON c.id=chosen.id JOIN readiness r ON r.id=c.id`;
/**
 * The commit guard's candidate term, binds (id, revision): the candidate is
 * still proposed at the planned revision and both source facts are current.
 * It runs inside the statement that reserves the receipt, so it is judged
 * atomically with the commit.
 */
export const OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL = `EXISTS(WITH chosen AS (SELECT ? AS id), ${cardSettlementReadinessCtes()}
    SELECT 1 FROM chosen JOIN card_settlement_reviews c ON c.id=chosen.id JOIN readiness r ON r.id=c.id
    WHERE c.status='proposed' AND c.revision=? AND r.statement_current=1 AND r.bank_current=1)`;

export async function prepareOwnershipReview(
  store: CommandStore,
  relation: RelationPayload,
): Promise<CommandResult<{ review: OwnershipReview }>> {
  const markers = relation.evidenceRefs.filter((ref) => ref.startsWith("card-settlement:"));
  if (
    markers.length !== 1 ||
    (relation.relationKind !== "liable_party" && relation.relationKind !== "beneficial_owner") ||
    !ownershipReviewPartyRef(relation.toRef) ||
    relation.validFrom !== null ||
    relation.validTo !== null
  )
    return commandError("invalid_command");
  const marker = markers[0]!,
    proposalId = marker.slice("card-settlement:".length);
  const candidate = await store.first<CandidateRow>(OWNERSHIP_REVIEW_CANDIDATE_SQL, [proposalId]);
  if (!candidate) return commandError("target_missing", [marker]);
  if (
    candidate.status !== "proposed" ||
    candidate.statement_current !== 1 ||
    candidate.bank_current !== 1
  )
    return commandError("stale_context", [marker]);
  let facts: unknown;
  try {
    facts = JSON.parse(candidate.facts_json);
  } catch {
    return commandError("incomplete_evidence", [marker]);
  }
  if (!validCardSettlementFacts(facts)) return commandError("incomplete_evidence", [marker]);
  const side = relation.relationKind === "liable_party" ? facts.statement : facts.bankDebit;
  const observationMatch = /^(balance|transaction):([0-9]+)$/u.exec(side.ref.id);
  const parseMatch = /^parse_run:([0-9]+)$/u.exec(side.ref.revision);
  if (!observationMatch || !parseMatch || observationMatch[1] !== side.ref.kind)
    return commandError("incomplete_evidence", [marker]);
  const observationId = Number(observationMatch[2]),
    parseRunId = Number(parseMatch[1]);
  if (!Number.isSafeInteger(observationId) || !Number.isSafeInteger(parseRunId))
    return commandError("incomplete_evidence", [marker]);
  const mappings = await store.all<MappingRow>(
    `SELECT m.id,m.source_account_id,m.revision,m.account_id
 FROM current_identity_observations o JOIN current_account_mappings m ON m.source_account_id=o.source_account_id
 WHERE o.kind=? AND o.observation_id=? AND o.parse_run_id=?`,
    [side.ref.kind, observationId, parseRunId],
  );
  if (mappings.length !== 1 || !side.accountId)
    return commandError("needs_scope_resolution", [marker]);
  const mapping = mappings[0]!;
  if (mapping.account_id !== side.accountId || relation.fromRef !== "account:" + mapping.account_id)
    return commandError("stale_context", [marker]);
  const expectedEvidence = ownershipReviewEvidenceRefs(proposalId, side.ref, mapping.id);
  if (
    relation.evidenceRefs.length !== expectedEvidence.length ||
    !expectedEvidence.every((ref) => relation.evidenceRefs.includes(ref))
  )
    return commandError("incomplete_evidence", [marker]);
  const ownership = await store.first<{ revision: number }>(
    `SELECT count(*) AS revision FROM entity_relations
 WHERE kind=? AND from_ref IN(?,?)`,
    [relation.relationKind, mapping.account_id, "account:" + mapping.account_id],
  );
  return {
    ok: true,
    review: {
      sourceId: side.sourceId,
      targets: [
        {
          subjectRef: marker,
          currentRevision: candidate.revision,
          currentTargetRef: "proposed",
          proposedTargetRef: "proposed",
        },
        {
          subjectRef: "account_mapping:" + mapping.source_account_id,
          currentRevision: mapping.revision,
          currentTargetRef: mapping.account_id,
          proposedTargetRef: mapping.account_id,
        },
        {
          subjectRef: ownershipRevisionRef(relation.relationKind, mapping.account_id),
          currentRevision: ownership?.revision ?? 0,
          currentTargetRef: null,
          proposedTargetRef: relation.toRef,
        },
      ],
      precondition: {
        sql: `${OWNERSHIP_REVIEW_CANDIDATE_GUARD_SQL}
    AND (SELECT count(*) FROM current_identity_observations o JOIN current_account_mappings m ON m.source_account_id=o.source_account_id
     WHERE o.kind=? AND o.observation_id=? AND o.parse_run_id=?)=1
    AND EXISTS(SELECT 1 FROM current_identity_observations o JOIN current_account_mappings m ON m.source_account_id=o.source_account_id
     WHERE o.kind=? AND o.observation_id=? AND o.parse_run_id=? AND m.id=? AND m.account_id=?)`,
        binds: [
          proposalId,
          candidate.revision,
          side.ref.kind,
          observationId,
          parseRunId,
          side.ref.kind,
          observationId,
          parseRunId,
          mapping.id,
          mapping.account_id,
        ],
      },
    },
  };
}
export async function ownershipReviewPlan(
  store: CommandStore,
  relation: RelationPayload,
  base: ResolvedPlan,
): Promise<CommandResult<{ resolved: ResolvedPlan }>> {
  const prepared = await prepareOwnershipReview(store, relation);
  if (!prepared.ok) return prepared;
  const { review } = prepared;
  const targets = [...base.targets, ...review.targets];
  return {
    ok: true,
    resolved: {
      targets,
      expectedRevisions: Object.fromEntries(
        targets.map((target) => [target.subjectRef, target.currentRevision]),
      ),
      simulation: {
        ...base.simulation,
        targets,
        affectedScopes: [review.sourceId],
        affectedParseRuns: 1,
        invalidations: [
          "read-model:relations",
          "read-model:card-settlements",
          "review:card-ownership",
        ],
      },
    },
  };
}
