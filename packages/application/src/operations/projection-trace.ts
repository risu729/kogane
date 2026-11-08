// Whether the READ projection has caught up with what an operation adopted:
// the `projected` stage (contracts/stages.json: "READ content validated and
// published"), amending ADR 0048.
//
// CORE and READ are two databases that cannot be joined (04 §1), and CORE
// keeps no record of the revision at which a given parse was published, so
// "does the published snapshot include this request's parses?" needs one fact
// written at the time: the CORE revision the projection has to reach. When the
// Processor's tracker records an execution `published`, the same batch stores
// the `projected` stage as `pending` with that revision as its reference, read
// from `core_source_revision` inside the batch. The tracker saw the
// publication before that batch ran, and the revision only rises within an
// epoch, so the stored revision is at or above the one the publication wrote
// — the rule the decision outbox already uses (`required_source_revision`,
// docs/projection-input.md).
//
// The rest is derived when the record is read, without writing anything: the
// READ pointer's `source_revision` is the watermark "the published content was
// verified against this revision" (docs/read-model-d1.md), so a pointer of
// the same epoch at or above the stored revision means the published snapshot
// was built from a CORE that already held the publication. Anything that
// cannot be checked — no READ binding, no published snapshot, another READ
// contract, another CORE epoch, a revision nobody stored — is a closed reason
// on a `pending` stage, never `completed` (INV05).
//
// Identifiers, closed codes and revisions only.
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { CORE_REVISION_SQL } from "../../../read-model/src/source-revision.ts";
import { READ_CONTRACT_VERSION } from "../../../storage-d1/src/read/identity.ts";
import { READ_INSTANCE_SQL, READ_POINTER_SQL } from "../../../storage-d1/src/read/sql.ts";
import type { CommandStore, PreparedWrite } from "../command/contract.ts";

/**
 * Why `projected` is not complete although adoption is. Closed:
 *
 *   * `projection_behind` — the published snapshot was verified against an
 *     older CORE revision than the one the adoption reached;
 *   * `read_model_unavailable` — this deployment reads no READ database, or
 *     the database has published nothing, has the shape of another contract
 *     (06 §2), or could not be read;
 *   * `read_model_context_changed` — the published snapshot, the stored
 *     revision and CORE do not share one epoch (a restore, 05 §2), so the
 *     revisions cannot be compared;
 *   * `projection_revision_unrecorded` — the execution was recorded published
 *     before the revision was stored with it, so coverage cannot be known.
 */
export const PROJECTION_PENDING_REASONS = [
  "projection_behind",
  "read_model_unavailable",
  "read_model_context_changed",
  "projection_revision_unrecorded",
] as const;
export type ProjectionPendingReason = (typeof PROJECTION_PENDING_REASONS)[number];

export type ProjectionVerdict =
  | { state: "completed"; evidenceRef: string }
  | { state: "pending"; reasonCode: ProjectionPendingReason };

/** The reference a `pending` `projected` row carries: `core-revision:<epoch>:<revision>`. */
const REQUIREMENT_PREFIX = "core-revision:";

/** The CORE revision, and its epoch, the projection has to reach. */
export interface ProjectionRequirement {
  coreEpoch: string;
  sourceRevision: number;
}

/**
 * The statement that stores the requirement, appended to the batch that
 * records the execution `published`: it writes only when that batch's own
 * update moved the row (the `published_at` it set), and never replaces a
 * `projected` row that already exists. Keyed by the singleton revision row and
 * the dispatch primary key.
 */
export function projectionRequirementWrite(
  operationId: string,
  publishedAt: string,
): PreparedWrite {
  return {
    sql: `INSERT INTO ops_request_stages
      (operation_id,stage,state,evidence_ref,failure_code,attempts,updated_at)
      SELECT ?1,'projected','pending',
        '${REQUIREMENT_PREFIX}'||r.core_epoch||':'||r.source_revision,NULL,0,?2
      FROM core_source_revision r
      WHERE r.id=1 AND EXISTS(SELECT 1 FROM ops_collector_dispatches d
        WHERE d.operation_id=?1 AND d.state='published' AND d.published_at=?2)
      ON CONFLICT(operation_id,stage) DO NOTHING`,
    binds: [operationId, publishedAt],
  };
}

/** The stored requirement, or null when the reference is not one. */
export function projectionRequirement(evidenceRef: string | null): ProjectionRequirement | null {
  if (evidenceRef === null || !evidenceRef.startsWith(REQUIREMENT_PREFIX)) return null;
  const rest = evidenceRef.slice(REQUIREMENT_PREFIX.length);
  // The epoch is free text of 1-64 characters; the revision is what follows
  // the last colon.
  const split = rest.lastIndexOf(":");
  if (split <= 0) return null;
  const revision = rest.slice(split + 1);
  if (!/^\d{1,15}$/u.test(revision)) return null;
  return { coreEpoch: rest.slice(0, split), sourceRevision: Number(revision) };
}

interface ReadInstance {
  contract_version: string;
}
interface ReadPointer {
  snapshot_id: string;
  source_revision: number;
  core_epoch: string;
}
interface CoreRevision {
  core_epoch: string;
}

/**
 * Whether the published READ snapshot covers `requirement`. `read` is the
 * READ database, or null when this deployment binds none. Three singleton
 * reads: the READ instance and pointer, and CORE's epoch.
 */
export async function projectionCoverage(
  core: Pick<CommandStore, "first">,
  read: SqlExecutor | null | undefined,
  requirement: ProjectionRequirement | null,
): Promise<ProjectionVerdict> {
  if (requirement === null)
    return { state: "pending", reasonCode: "projection_revision_unrecorded" };
  if (!read) return { state: "pending", reasonCode: "read_model_unavailable" };
  let instance: ReadInstance | null;
  let pointer: ReadPointer | null;
  try {
    [instance, pointer] = await Promise.all([
      read.first<ReadInstance>(READ_INSTANCE_SQL, []),
      read.first<ReadPointer>(READ_POINTER_SQL, []),
    ]);
  } catch {
    // A READ database that cannot be read says nothing about coverage.
    return { state: "pending", reasonCode: "read_model_unavailable" };
  }
  if (instance === null || instance.contract_version !== READ_CONTRACT_VERSION || pointer === null)
    return { state: "pending", reasonCode: "read_model_unavailable" };
  const current = await core.first<CoreRevision>(CORE_REVISION_SQL, []);
  if (
    current === null ||
    pointer.core_epoch !== requirement.coreEpoch ||
    current.core_epoch !== requirement.coreEpoch
  )
    return { state: "pending", reasonCode: "read_model_context_changed" };
  if (pointer.source_revision < requirement.sourceRevision)
    return { state: "pending", reasonCode: "projection_behind" };
  return { state: "completed", evidenceRef: `read-snapshot:${pointer.snapshot_id}` };
}
