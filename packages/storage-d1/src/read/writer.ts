// The writer side of the READ database (unified plan 05 §4–§5, U11).
//
// Everything a build does to READ is here, and every step is decidable:
//
//   * `ensureReadInstance` claims the physical database once. A rebuilt
//     database gets a new id, which is what expires the old cursors;
//   * `beginSnapshot` allocates the next attempt of a content key and writes
//     the snapshot row together with the CORE references it was built from, so
//     a relation can never claim a decision the snapshot did not fix (04 §3);
//   * `claimWriterLease` raises the fence. A writer whose lease was taken can
//     no longer write, seal or publish (G2-09);
//   * `writeRowChunk` commits the chunk and its checkpoint in one batch, so a
//     statement error rolls both back (G2-08) and a re-sent chunk is a no-op
//     only when its content is identical (G2-07);
//   * `sealAndPublish` seals the snapshot and switches the pointer in one
//     batch, under the lease, and only forward (G2-10).
//
// CORE is never written from here, and this database is never asked to decide
// anything a reader could not rebuild.
import { canonicalJson, sha256Hex } from "../../../domain/src/context.ts";
import type { DerivedScopeRelation, ProjectionRow } from "../../../read-model/src/index.ts";
import {
  readOutputDigest,
  readSnapshotId,
  READ_CONTRACT_VERSION,
  type SnapshotInputRef,
} from "./identity.ts";
import {
  NEXT_ATTEMPT_SQL,
  OLDEST_BUILDING_SNAPSHOT_SQL,
  READ_INSTANCE_SQL,
  READ_POINTER_AT_REVISION_SQL,
  READ_POINTER_DETAIL_SQL,
  RETIREABLE_SNAPSHOTS_SQL,
  ROW_CHECKPOINT_SQL,
  SNAPSHOT_FOR_CONTENT_SQL,
  WRITTEN_ROW_DIGESTS_SQL,
} from "./sql.ts";
import { runBatch, type D1Like, type D1StatementLike } from "../d1.ts";

/** Rows written in one batch with the checkpoint that records them. */
export const READ_WRITE_CHUNK = 100;
/** Complete snapshots kept besides the published one, so an open cursor survives a rebuild. */
export const READ_RETAINED_SNAPSHOTS = 2;

export interface ReadInstance {
  read_instance_id: string;
  created_at: string;
  contract_version: string;
}

/**
 * The identity of this physical database, claimed on first use.
 *
 * A migration cannot generate an id, so the first writer does. The single-row
 * trigger settles a race: the loser's insert aborts and it reads the winner's
 * row, so two Workers can never disagree about which instance this is.
 */
export async function ensureReadInstance(
  db: D1Like,
  now: string,
  id: string = crypto.randomUUID(),
): Promise<ReadInstance> {
  const existing = await db.prepare(READ_INSTANCE_SQL).bind().first<ReadInstance>();
  if (existing) return existing;
  try {
    await db
      .prepare(
        `INSERT INTO read_instance(id,read_instance_id,created_at,contract_version)
         VALUES(1,?1,?2,?3)`,
      )
      .bind(id, now, READ_CONTRACT_VERSION)
      .run();
  } catch {
    // Another writer claimed it between the read and the insert.
  }
  const claimed = await db.prepare(READ_INSTANCE_SQL).bind().first<ReadInstance>();
  if (!claimed) throw new Error("storage-d1: the read instance could not be claimed");
  return claimed;
}

export interface ContentSnapshotRow {
  snapshot_id: string;
  attempt: number;
  status: "building" | "complete";
  row_count: number;
  output_digest: string | null;
  source_revision: number;
  visibility_revision: number;
  core_epoch: string;
  input_digest: string;
}

/**
 * The build of this content that may be continued (`building`) or reused
 * (`complete`). Retired builds are deliberately not returned: their content is
 * built again under a new attempt, which is the fix for CORE's wedge where a
 * retired id was final.
 */
export async function snapshotForContent(
  db: D1Like,
  contentKey: string,
): Promise<ContentSnapshotRow | null> {
  return await db.prepare(SNAPSHOT_FOR_CONTENT_SQL).bind(contentKey).first<ContentSnapshotRow>();
}

export interface BuildingSnapshotRow {
  snapshot_id: string;
  attempt: number;
  content_key: string;
  input_digest: string;
  build_digest: string;
  contract_version: string;
  source_revision: number;
  visibility_revision: number;
  core_epoch: string;
  row_count: number;
}

/** The oldest unfinished build; the next invocation continues it from its own input. */
export async function oldestBuildingSnapshot(db: D1Like): Promise<BuildingSnapshotRow | null> {
  return await db.prepare(OLDEST_BUILDING_SNAPSHOT_SQL).bind().first<BuildingSnapshotRow>();
}

export interface SnapshotPlan {
  contentKey: string;
  inputDigest: string;
  buildDigest: string;
  /** The contract version of the fixed input; part of the content identity. */
  contractVersion: string;
  sourceRevision: number;
  visibilityRevision: number;
  coreEpoch: string;
  /** The operational input summary, copied so a page needs no CORE read. */
  inputManifestJson: string;
  projectionRelease: string;
  /** CORE references and their digests, copied from the fixed input (04 §3). */
  inputRefs: readonly SnapshotInputRef[];
}

export interface StartedSnapshot {
  snapshotId: string;
  attempt: number;
}

/**
 * Start a build: the next attempt of this content, its snapshot row and its
 * input refs, in one batch. The refs go in with the row because the relation
 * trigger reads them, so a decision-backed relation can only name a decision
 * this snapshot fixed.
 *
 * The row is inserted only while no `building` or `complete` build of the
 * content exists, so two invocations that both looked and found nothing cannot
 * both start one: the loser's insert matches nothing (or hits the unique
 * attempt), the refs in the same batch then abort it, and the batch is rolled
 * back. The caller gets `null` and continues the winner's build on its next
 * tick.
 */
export async function beginSnapshot(
  db: D1Like,
  readInstanceId: string,
  plan: SnapshotPlan,
  now: string,
): Promise<StartedSnapshot | null> {
  const next = await db
    .prepare(NEXT_ATTEMPT_SQL)
    .bind(plan.contentKey)
    .first<{ attempt: number }>();
  const attempt = next?.attempt ?? 1;
  const snapshotId = await readSnapshotId(plan.contentKey, attempt, plan.contractVersion);
  try {
    await runBatch(db, [
      db
        .prepare(
          `INSERT INTO balance_read_snapshots(snapshot_id,content_key,attempt,input_digest,
            build_digest,contract_version,read_instance_id,source_revision,visibility_revision,
            core_epoch,status,row_count,relation_count,output_digest,writer_lease,
            writer_lease_until_ms,writer_fence,input_manifest_json,projection_release,created_at,
            completed_at)
           SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'building',0,0,NULL,NULL,0,0,?11,?12,?13,NULL
           WHERE NOT EXISTS(SELECT 1 FROM balance_read_snapshots b
             WHERE b.content_key=?2 AND b.status IN ('building','complete'))`,
        )
        .bind(
          snapshotId,
          plan.contentKey,
          attempt,
          plan.inputDigest,
          plan.buildDigest,
          plan.contractVersion,
          readInstanceId,
          plan.sourceRevision,
          plan.visibilityRevision,
          plan.coreEpoch,
          plan.inputManifestJson,
          plan.projectionRelease,
          now,
        ),
      // The first ref doubles as the guard's witness: with no row inserted,
      // its `building` trigger aborts the batch. A plan without refs cannot
      // occur (the restriction revision is always one), and is refused below.
      ...plan.inputRefs.map((ref) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO snapshot_input_refs(snapshot_id,ref_kind,ref_id,ref_digest,
              core_epoch,created_at) VALUES(?1,?2,?3,?4,?5,?6)`,
          )
          .bind(snapshotId, ref.kind, ref.id, ref.digest, plan.coreEpoch, now),
      ),
    ]);
  } catch (error) {
    if (await snapshotForContent(db, plan.contentKey)) return null;
    throw error;
  }
  if (plan.inputRefs.length === 0) {
    // Nothing witnessed the guard; settle it by reading the row back.
    const started = await snapshotForContent(db, plan.contentKey);
    if (started?.snapshot_id !== snapshotId) return null;
  }
  return { snapshotId, attempt };
}

/**
 * Claim the build for this invocation and raise the fence. A live lease held by
 * another writer is respected; an expired one is taken over, so a writer that
 * crashed does not leave the build `building` for ever.
 */
export async function claimWriterLease(
  db: D1Like,
  snapshotId: string,
  lease: string,
  nowMs: number,
  leaseMs: number,
): Promise<boolean> {
  const claim = await db
    .prepare(
      `UPDATE balance_read_snapshots SET writer_lease=?2,writer_lease_until_ms=?3,
        writer_fence=writer_fence+1
       WHERE snapshot_id=?1 AND status='building'
         AND (writer_lease IS NULL OR writer_lease=?2 OR writer_lease_until_ms<=?4)`,
    )
    .bind(snapshotId, lease, nowMs + leaseMs, nowMs)
    .run();
  return claim.meta.changes === 1;
}

/** Hand the build back so the next invocation takes it over without waiting. */
export async function releaseWriterLease(
  db: D1Like,
  snapshotId: string,
  lease: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE balance_read_snapshots SET writer_lease=NULL,writer_lease_until_ms=0
       WHERE snapshot_id=?1 AND status='building' AND writer_lease=?2`,
    )
    .bind(snapshotId, lease)
    .run();
}

/** The fence this invocation holds, or null when the lease is gone. */
export async function writerFence(
  db: D1Like,
  snapshotId: string,
  lease: string,
): Promise<number | null> {
  const held = await db
    .prepare(
      `SELECT writer_fence FROM balance_read_snapshots
       WHERE snapshot_id=?1 AND status='building' AND writer_lease=?2`,
    )
    .bind(snapshotId, lease)
    .first<{ writer_fence: number }>();
  return held?.writer_fence ?? null;
}

/** Where the bounded build got to; -1 before its first chunk. */
export async function rowCheckpoint(db: D1Like, snapshotId: string): Promise<number> {
  const row = await db
    .prepare(ROW_CHECKPOINT_SQL)
    .bind(snapshotId)
    .first<{ position: string; rows_written: number }>();
  return row === null ? -1 : Number(row.position);
}

/** Content digest of one projection row; the key to a decidable re-send. */
export async function rowDigest(row: ProjectionRow): Promise<string> {
  return await sha256Hex(canonicalJson(row));
}

function insertRow(
  db: D1Like,
  snapshotId: string,
  row: ProjectionRow,
  digest: string,
): D1StatementLike {
  return db
    .prepare(
      `INSERT OR IGNORE INTO current_balance_projection(
        snapshot_id,scope_key,subject_scope_key,row_seq,representative_observation_ref,
        member_evidence_refs_json,member_metrics_json,evidence_count,metric_id,definition_release,
        quantity_coefficient,quantity_scale,value_status,unit_ref,state,reason_code,
        as_of_role,as_of_kind,as_of_value,temporal_json,freshness,freshness_reason,sort_as_of,
        source_id,source_account,metric,instrument,parser,observation_id,parse_run_id,
        fetch_artifact_id,amount_minor,amount_text,as_of,observed_at,measure_view,latest_in_group,
        row_digest)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
        ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38)`,
    )
    .bind(
      snapshotId,
      row.scopeKey,
      row.subjectScopeKey,
      row.rowSeq,
      row.representativeObservationRef,
      JSON.stringify(row.memberEvidence),
      JSON.stringify(row.memberMetrics),
      row.evidenceCount,
      row.metricId,
      row.definitionRelease,
      row.quantityCoefficient,
      row.quantityScale,
      row.valueStatus,
      row.unitRef,
      row.state,
      row.reasonCode,
      row.asOfRole,
      row.asOfKind,
      row.asOfValue,
      JSON.stringify(row.temporal),
      row.freshness,
      row.freshnessReason,
      row.sortAsOf,
      row.sourceId,
      row.sourceAccount,
      row.metric,
      row.instrument,
      row.parser,
      row.observationId,
      row.parseRunId,
      row.fetchArtifactId,
      row.amountMinor,
      row.amountText,
      row.asOf,
      row.observedAt,
      row.measureView,
      row.latestInGroup ? 1 : 0,
      digest,
    );
}

function checkpointStatement(
  db: D1Like,
  snapshotId: string,
  stage: "rows" | "relations",
  position: string,
  rowsWritten: number,
  lease: string,
  fence: number,
  now: string,
): D1StatementLike {
  // The checkpoint is guarded by the lease exactly like the rows it records, so
  // a displaced writer's batch changes nothing and says so.
  return db
    .prepare(
      `INSERT INTO read_build_checkpoints(snapshot_id,stage,position,rows_written,writer_lease,
        writer_fence,updated_at)
       SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM balance_read_snapshots s
         WHERE s.snapshot_id=?1 AND s.status='building' AND s.writer_lease=?5)
       ON CONFLICT(snapshot_id,stage) DO UPDATE SET position=excluded.position,
         rows_written=excluded.rows_written,writer_lease=excluded.writer_lease,
         writer_fence=excluded.writer_fence,updated_at=excluded.updated_at`,
    )
    .bind(snapshotId, stage, position, rowsWritten, lease, fence, now);
}

export type ChunkOutcome = "written" | "lease_lost";

/**
 * One chunk of rows and the checkpoint that records it, in one batch. A
 * statement error rolls back both, so a checkpoint can never claim rows that
 * are not there; a re-sent chunk with the same content is ignored, and one with
 * different content raises `projection chunk conflict` in the trigger.
 */
export async function writeRowChunk(
  db: D1Like,
  snapshotId: string,
  rows: readonly { row: ProjectionRow; digest: string }[],
  context: { lease: string; fence: number; now: string; rowsWritten: number },
): Promise<ChunkOutcome> {
  if (rows.length === 0) return "written";
  const last = rows[rows.length - 1] as { row: ProjectionRow; digest: string };
  const results = await runBatch(db, [
    ...rows.map((entry) => insertRow(db, snapshotId, entry.row, entry.digest)),
    checkpointStatement(
      db,
      snapshotId,
      "rows",
      String(last.row.rowSeq),
      context.rowsWritten + rows.length,
      context.lease,
      context.fence,
      context.now,
    ),
  ]);
  const checkpoint = results[results.length - 1];
  return checkpoint !== undefined && checkpoint.meta.changes === 1 ? "written" : "lease_lost";
}

/**
 * The snapshot's scope relations, written in chunks with their own checkpoint.
 * Policy relations are reproducible from the release in the manifest, so only
 * evidence-backed claims are stored — the same rule the CORE build follows.
 */
export async function writeScopeRelations(
  db: D1Like,
  snapshotId: string,
  relations: readonly DerivedScopeRelation[],
  context: { lease: string; fence: number; now: string },
): Promise<ChunkOutcome> {
  const stored = relations.filter((relation) => relation.source !== "policy");
  if (stored.length === 0) return "written";
  let written = 0;
  for (let start = 0; start < stored.length; start += READ_WRITE_CHUNK) {
    const chunk = stored.slice(start, start + READ_WRITE_CHUNK);
    const results = await runBatch(db, [
      ...chunk.map((relation) =>
        db
          .prepare(
            `INSERT INTO scope_relations(snapshot_id,from_scope_key,to_scope_key,relation,source,
              decision_revision_id,release,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(snapshot_id,from_scope_key,to_scope_key) DO UPDATE SET
              relation=excluded.relation,source=excluded.source,
              decision_revision_id=excluded.decision_revision_id`,
          )
          .bind(
            snapshotId,
            relation.fromScopeKey,
            relation.toScopeKey,
            relation.relation,
            relation.source,
            relation.decisionRevisionId,
            relation.release,
            context.now,
          ),
      ),
      checkpointStatement(
        db,
        snapshotId,
        "relations",
        String(start + chunk.length),
        written + chunk.length,
        context.lease,
        context.fence,
        context.now,
      ),
    ]);
    const checkpoint = results[results.length - 1];
    if (checkpoint === undefined || checkpoint.meta.changes !== 1) return "lease_lost";
    written += chunk.length;
  }
  return "written";
}

/**
 * What was written is what the build produced: the same number of rows, a dense
 * sequence in the contract order, and the same digest at every position. A
 * build that cannot prove this does not seal (05 §5).
 */
export async function writtenRowsMatch(
  db: D1Like,
  snapshotId: string,
  digests: readonly string[],
): Promise<boolean> {
  const stored = await db
    .prepare(WRITTEN_ROW_DIGESTS_SQL)
    .bind(snapshotId)
    .all<{ row_seq: number; row_digest: string }>();
  if (stored.results.length !== digests.length) return false;
  return stored.results.every(
    (row, index) => row.row_seq === index && row.row_digest === digests[index],
  );
}

export interface SealOutcome {
  sealed: boolean;
  published: boolean;
  outputDigest: string;
}

/**
 * Seal the snapshot and switch the pointer in one batch, under the lease.
 *
 * The seal keeps the lease on the row as "sealed by", and the pointer statement
 * names only a complete snapshot sealed by that lease. A writer whose lease was
 * taken between its last chunk and its seal therefore matches no row in either
 * statement — even when the writer that displaced it has already sealed and
 * published the same build — so the batch reports the lost fence instead of
 * re-switching the pointer or a trigger aborting it (G2-09). The switch happens
 * only when the new snapshot is at least as current as the published one under
 * the same epoch, so a build that finishes late is complete but not published
 * (G2-10).
 */
export async function sealAndPublish(
  db: D1Like,
  snapshot: {
    snapshotId: string;
    readInstanceId: string;
    sourceRevision: number;
    visibilityRevision: number;
    coreEpoch: string;
  },
  build: { rowCount: number; relationCount: number; rowDigests: readonly string[] },
  context: { lease: string; now: string },
): Promise<SealOutcome> {
  const outputDigest = await readOutputDigest(build.rowDigests);
  const results = await runBatch(db, [
    db
      .prepare(
        `UPDATE balance_read_snapshots SET status='complete',completed_at=?2,row_count=?3,
          relation_count=?4,output_digest=?5,writer_lease_until_ms=0
         WHERE snapshot_id=?1 AND status='building' AND writer_lease=?6`,
      )
      .bind(
        snapshot.snapshotId,
        context.now,
        build.rowCount,
        build.relationCount,
        outputDigest,
        context.lease,
      ),
    activePointerStatement(db, { ...snapshot, outputDigest }, context.now, context.lease),
  ]);
  const seal = results[0];
  const pointer = results[1];
  return {
    sealed: seal !== undefined && seal.meta.changes === 1,
    published: pointer !== undefined && pointer.meta.changes === 1,
    outputDigest,
  };
}

/**
 * Switch the active pointer to a complete snapshot, forward only. Exported so
 * the test that proves the rule runs the statement the writer runs, and so a
 * capture that digests to an already published snapshot can advance the
 * watermark without rebuilding anything (05 §5).
 *
 * `sealedBy` is the lease of the seal in the same batch: with it the statement
 * names only a snapshot that lease sealed, so a displaced writer cannot switch
 * the pointer to a build its successor finished. Without it (the watermark
 * advance) any complete snapshot qualifies.
 */
export function activePointerStatement(
  db: D1Like,
  snapshot: {
    snapshotId: string;
    readInstanceId: string;
    sourceRevision: number;
    visibilityRevision: number;
    coreEpoch: string;
    outputDigest: string;
  },
  now: string,
  sealedBy: string | null = null,
): D1StatementLike {
  return db
    .prepare(
      `INSERT INTO balance_snapshot_pointer(id,snapshot_id,source_revision,visibility_revision,
        core_epoch,read_instance_id,output_digest,switched_at)
       SELECT 1,?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM balance_read_snapshots s
         WHERE s.snapshot_id=?1 AND s.status='complete' AND (?8 IS NULL OR s.writer_lease=?8))
       ON CONFLICT(id) DO UPDATE SET snapshot_id=excluded.snapshot_id,
         source_revision=excluded.source_revision,
         visibility_revision=excluded.visibility_revision,core_epoch=excluded.core_epoch,
         read_instance_id=excluded.read_instance_id,output_digest=excluded.output_digest,
         switched_at=excluded.switched_at
       WHERE excluded.core_epoch<>balance_snapshot_pointer.core_epoch
          OR excluded.source_revision>=balance_snapshot_pointer.source_revision`,
    )
    .bind(
      snapshot.snapshotId,
      snapshot.sourceRevision,
      snapshot.visibilityRevision,
      snapshot.coreEpoch,
      snapshot.readInstanceId,
      snapshot.outputDigest,
      now,
      sealedBy,
    );
}

export interface PointerRow {
  snapshot_id: string;
  source_revision: number;
  visibility_revision: number;
  core_epoch: string;
  read_instance_id: string;
  output_digest: string;
  switched_at: string;
}

export async function activePointer(db: D1Like): Promise<PointerRow | null> {
  return await db.prepare(READ_POINTER_DETAIL_SQL).bind().first<PointerRow>();
}

/**
 * The published snapshot when it covers `requiredSourceRevision` under
 * `coreEpoch`. This is the whole question the outbox processor asks: a lost
 * response converges here on the next tick, because the pointer already carries
 * the revision the decision moved (G2-12).
 */
export async function publishedSnapshotAt(
  db: D1Like,
  requiredSourceRevision: number | null,
  coreEpoch: string | null,
): Promise<{ snapshot_id: string; output_digest: string; source_revision: number } | null> {
  return await db
    .prepare(READ_POINTER_AT_REVISION_SQL)
    .bind(requiredSourceRevision, coreEpoch)
    .first<{ snapshot_id: string; output_digest: string; source_revision: number }>();
}

/**
 * Retire builds older than the retained window and delete their rows. A reader
 * on an older cursor gets `context_expired` rather than a silently different
 * list, and the published snapshot is never retired.
 */
export async function retireOldSnapshots(
  db: D1Like,
  keep: string,
  now: string,
  retained: number = READ_RETAINED_SNAPSHOTS,
): Promise<number> {
  const stale = await db
    .prepare(RETIREABLE_SNAPSHOTS_SQL)
    .bind(keep, Math.max(retained - 1, 0))
    .all<{ snapshot_id: string }>();
  for (const row of stale.results) {
    await db
      .prepare("UPDATE balance_read_snapshots SET status='retired' WHERE snapshot_id=?1")
      .bind(row.snapshot_id)
      .run();
    await runBatch(db, [
      db
        .prepare("DELETE FROM current_balance_projection WHERE snapshot_id=?1")
        .bind(row.snapshot_id),
      db.prepare("DELETE FROM scope_relations WHERE snapshot_id=?1").bind(row.snapshot_id),
      db.prepare("DELETE FROM snapshot_input_refs WHERE snapshot_id=?1").bind(row.snapshot_id),
      db.prepare("DELETE FROM read_build_checkpoints WHERE snapshot_id=?1").bind(row.snapshot_id),
    ]);
  }
  return stale.results.length;
}

/** Retire one unfinished build and drop what it wrote; the next tick starts a new attempt. */
export async function abandonSnapshot(db: D1Like, snapshotId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE balance_read_snapshots SET status='retired' WHERE snapshot_id=?1 AND status='building'",
    )
    .bind(snapshotId)
    .run();
  await runBatch(db, [
    db.prepare("DELETE FROM current_balance_projection WHERE snapshot_id=?1").bind(snapshotId),
    db.prepare("DELETE FROM scope_relations WHERE snapshot_id=?1").bind(snapshotId),
    db.prepare("DELETE FROM snapshot_input_refs WHERE snapshot_id=?1").bind(snapshotId),
    db.prepare("DELETE FROM read_build_checkpoints WHERE snapshot_id=?1").bind(snapshotId),
  ]);
}
