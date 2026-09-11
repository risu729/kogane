// The reads of the READ database that CORE does not have.
//
// The page, subtotal and coverage statements are deliberately *not* here: the
// projection table has the same columns as CORE's, so the reviewed builders in
// `packages/read-model/src/balance-projection-sql.ts` run against this database
// unchanged. What is new is how a snapshot is chosen — only through the active
// pointer, never "the newest complete one" — and the instance identity.

/** Columns of a snapshot, in the shape `BalanceSnapshotRow` declares. */
const SNAPSHOT_COLUMNS = `s.snapshot_id AS snapshot_id, s.created_at AS created_at,
    s.row_count AS row_count, s.input_manifest_json AS input_manifest_json,
    s.projection_release AS projection_release, s.input_digest AS input_digest,
    s.source_revision AS source_revision, s.visibility_revision AS visibility_revision,
    s.core_epoch AS core_epoch, s.read_instance_id AS read_instance_id`;

/** The identity of this physical READ database, or nothing before it is claimed. */
export const READ_INSTANCE_SQL =
  "SELECT read_instance_id, created_at, contract_version FROM read_instance WHERE id=1";

/**
 * The published snapshot: the one the pointer names, and only if it is
 * complete. There is deliberately no "otherwise the newest complete build"
 * fallback — a database with no pointer publishes nothing, and the App answers
 * `unavailable` rather than an empty success (05 §7, G3-01).
 */
export const ACTIVE_SNAPSHOT_SQL = `SELECT ${SNAPSHOT_COLUMNS}
  FROM balance_snapshot_pointer p
  JOIN balance_read_snapshots s ON s.snapshot_id=p.snapshot_id AND s.status='complete'
  WHERE p.id=1`;

/** A snapshot a cursor names; absent or retired means the context expired. */
export const READ_SNAPSHOT_SQL = `SELECT ${SNAPSHOT_COLUMNS}
  FROM balance_read_snapshots s WHERE s.snapshot_id=?1 AND s.status='complete'`;

/** The pointer itself, in the shape `ActivePointerRow` declares. */
export const READ_POINTER_SQL = `SELECT snapshot_id, source_revision, read_instance_id,
    core_epoch, switched_at FROM balance_snapshot_pointer WHERE id=1`;

/** The pointer with the fields only this database has, for the writer's checks. */
export const READ_POINTER_DETAIL_SQL = `SELECT snapshot_id, source_revision,
    visibility_revision, core_epoch, read_instance_id, output_digest, switched_at
  FROM balance_snapshot_pointer WHERE id=1`;

/**
 * The published snapshot when it covers a required CORE revision, under the
 * same epoch. This is the one question the outbox processor asks after a build
 * (05 §6): a decision's own write moved the revision, so a published snapshot
 * at or above it carries the decision.
 */
export const READ_POINTER_AT_REVISION_SQL = `SELECT p.snapshot_id AS snapshot_id,
    s.output_digest AS output_digest, p.source_revision AS source_revision
  FROM balance_snapshot_pointer p
  JOIN balance_read_snapshots s ON s.snapshot_id=p.snapshot_id AND s.status='complete'
  WHERE p.id=1 AND (?1 IS NULL OR p.source_revision>=?1)
    AND (?2 IS NULL OR p.core_epoch=?2)`;

/** The build of this content that may still be continued or reused. */
export const SNAPSHOT_FOR_CONTENT_SQL = `SELECT snapshot_id, attempt, status, row_count,
    output_digest, source_revision, visibility_revision, core_epoch, input_digest
  FROM balance_read_snapshots
  WHERE content_key=?1 AND status IN ('building','complete')
  ORDER BY status='building' DESC, attempt DESC LIMIT 1`;

/** The oldest unfinished build, which the next invocation continues. */
export const OLDEST_BUILDING_SNAPSHOT_SQL = `SELECT snapshot_id, attempt, content_key,
    input_digest, build_digest, contract_version, source_revision, visibility_revision,
    core_epoch, row_count
  FROM balance_read_snapshots WHERE status='building'
  ORDER BY created_at, snapshot_id LIMIT 1`;

export const NEXT_ATTEMPT_SQL =
  "SELECT coalesce(max(attempt),0)+1 AS attempt FROM balance_read_snapshots WHERE content_key=?1";

/** Written rows of a build, in contract order, with their digests. */
export const WRITTEN_ROW_DIGESTS_SQL = `SELECT row_seq, row_digest
  FROM current_balance_projection WHERE snapshot_id=?1 ORDER BY row_seq`;

/** Where a bounded build got to; -1 before its first chunk. */
export const ROW_CHECKPOINT_SQL = `SELECT position, rows_written
  FROM read_build_checkpoints WHERE snapshot_id=?1 AND stage='rows'`;

/** Builds that may be retired: complete or abandoned, never the published one. */
export const RETIREABLE_SNAPSHOTS_SQL = `SELECT snapshot_id FROM balance_read_snapshots
  WHERE snapshot_id<>?1 AND status IN ('complete','building')
    AND snapshot_id<>coalesce((SELECT p.snapshot_id FROM balance_snapshot_pointer p
      WHERE p.id=1),'')
  ORDER BY created_at DESC, snapshot_id DESC LIMIT 50 OFFSET ?2`;
