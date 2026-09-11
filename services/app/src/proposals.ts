// The store behind `kogane.reconcile.propose`: the only write this Worker
// has. It appends one `decision_revisions` row of kind `propose` and one
// `entity_relations` row with status `proposed` (migration 0029), in one D1
// batch, in that order — the relation's provenance trigger requires its
// decision to exist first, so a failed guard leaves neither row.
//
// Nothing here can update, delete, adopt or accept: both tables carry
// append-only triggers, `status` is the literal `'proposed'`, and no
// statement in this file writes any other table. Reference resolution reads
// the same named concepts as every other read (packages/read-model), so a ref
// that names a row a reader may not see resolves to nothing.
import {
  isObservationKind,
  OBSERVATION_TABLES,
  visibleEvidence,
} from "../../../packages/read-model/src/index";
import type {
  ProposalStore,
  ResolvedRef,
  StoredProposal,
} from "../../../packages/application/src/index";

const OBSERVATION_REF =
  /^observation:(transaction|balance|position|valuation):([1-9][0-9]{0,15})$/u;
const ARTIFACT_REF = /^fetch_artifact:([1-9][0-9]{0,15})$/u;
const SOURCE_ACCOUNT_REF = /^source_account:(.{1,256})$/su;

const SOURCE_ACCOUNT_SQL = `SELECT s.source_id AS sourceId,
    json_extract(s.reference_json,'$[0]') AS account
  FROM source_accounts s WHERE s.id = ?`;
const ARTIFACT_SQL = `SELECT a.source_id AS sourceId FROM ${visibleEvidence.fetchArtifacts} a WHERE a.id = ?`;
function observationSql(kind: keyof typeof OBSERVATION_TABLES): string {
  return `SELECT a.source_id AS sourceId, o.source_account AS account
    FROM ${visibleEvidence.observations(OBSERVATION_TABLES[kind])} o
    JOIN parse_runs p ON p.id = o.parse_run_id
    JOIN ${visibleEvidence.fetchArtifacts} a ON a.id = p.fetch_artifact_id
    WHERE o.id = ?`;
}

interface ScopeRow {
  sourceId: string;
  account?: string | null;
}

export function proposalStore(db: D1Database): ProposalStore {
  const resolve = async (sql: string, argument: unknown): Promise<ResolvedRef | null> => {
    const row = await db.prepare(sql).bind(argument).first<ScopeRow>();
    if (!row || typeof row.sourceId !== "string") return null;
    return {
      sourceId: row.sourceId,
      account: typeof row.account === "string" ? row.account : null,
    };
  };
  return {
    async resolveTarget(ref) {
      const match = SOURCE_ACCOUNT_REF.exec(ref);
      return match ? resolve(SOURCE_ACCOUNT_SQL, match[1]!) : null;
    },
    async resolveEvidence(ref) {
      const observation = OBSERVATION_REF.exec(ref);
      if (observation && isObservationKind(observation[1]!))
        return resolve(observationSql(observation[1] as "transaction"), Number(observation[2]));
      const artifact = ARTIFACT_REF.exec(ref);
      return artifact ? resolve(ARTIFACT_SQL, Number(artifact[1])) : null;
    },
    async appendProposal(proposal: StoredProposal) {
      const evidence = JSON.stringify(proposal.evidenceRefs);
      await db.batch([
        db
          .prepare(
            `INSERT INTO decision_revisions
             (id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,
              reason,evidence_refs_json,previous_revision,superseded_by,created_at)
             VALUES (?1,'relation',?2,1,'propose',?3,?4,NULL,?5,?6,NULL,NULL,?7)`,
          )
          .bind(
            proposal.decisionRevisionId,
            proposal.relationId,
            proposal.method,
            proposal.actorId,
            proposal.reason,
            evidence,
            proposal.recordedAt,
          ),
        db
          .prepare(
            `INSERT INTO entity_relations
             (id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
             VALUES (?1,?2,?3,?4,NULL,NULL,'proposed',?5,?6,?7)`,
          )
          .bind(
            proposal.relationId,
            proposal.kind,
            proposal.fromRef,
            proposal.toRef,
            proposal.decisionRevisionId,
            evidence,
            proposal.recordedAt,
          ),
      ]);
    },
  };
}
