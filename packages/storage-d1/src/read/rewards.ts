// The reward side of the READ database (unified plan 04 §2, 05 §3–§7; U16).
//
// The same writer shape as the balance baseline — begin, lease, chunk with a
// checkpoint, verify, seal and switch the pointer in one batch — over the
// tables of migration 0002. Two things are specific to rewards:
//
//   * the evaluation instant is part of the snapshot's identity. It is
//     captured, hashed into the input digest and written on the snapshot row,
//     so re-evaluating the same claims an hour later builds a *new* snapshot
//     and the trigger refuses to change the old one (G2-19);
//   * a saved simulation is replayed only when its request was retained. The
//     rows carry `not_reproducible` with a reason code otherwise; nothing in
//     this file ever recomputes a digest-only simulation against today's
//     offers (G2-20).
//
// CORE is never written from here, and no statement joins a CORE table.
import { canonicalJson, sha256Hex } from "../../../domain/src/context.ts";
import type {
  RewardExpiryProjectionRow,
  RewardSimulationProjectionRow,
} from "../../../read-model/src/index.ts";
import { readOutputDigest, readSnapshotId } from "./identity.ts";
import { runBatch, type D1Like, type D1StatementLike } from "../d1.ts";

/** Rows written per batch, and complete snapshots kept besides the published one. */
export const REWARD_WRITE_CHUNK = 100;
export const REWARD_RETAINED_SNAPSHOTS = 2;

/** A reward CORE reference copied into the snapshot (04 §3). */
export type RewardInputRefKind =
  | "expiry_rule"
  | "conversion_offer"
  | "reward_program"
  | "bucket_claim"
  | "membership_claim"
  | "simulation_request"
  | "evaluation_clock"
  | "calendar_rule"
  | "promotion_release"
  | "restriction_revision";

export interface RewardInputRef {
  kind: RewardInputRefKind;
  id: string;
  /** Digest of the referenced value as the fixed input carried it. */
  digest: string;
}

/** Columns of a snapshot, in the shape `RewardSnapshotRow` declares. */
const snapshotColumns = (alias: string): string =>
  [
    "snapshot_id",
    "content_key",
    "attempt",
    "input_digest",
    "build_digest",
    "contract_version",
    "read_instance_id",
    "evaluated_at",
    "calendar_rule_id",
    "rule_set_digest",
    "rule_count",
    "claims_release",
    "claims_high_water",
    "source_revision",
    "visibility_revision",
    "core_epoch",
    "status",
    "estimate_count",
    "simulation_count",
    "output_digest",
    "input_manifest_json",
    "policy_release",
    "created_at",
    "completed_at",
  ]
    .map((column) => `${alias}${column} AS ${column}`)
    .join(", ");

const SNAPSHOT_COLUMNS = snapshotColumns("");

export interface RewardSnapshotRow {
  snapshot_id: string;
  content_key: string;
  attempt: number;
  input_digest: string;
  build_digest: string;
  contract_version: string;
  read_instance_id: string;
  evaluated_at: string;
  calendar_rule_id: string;
  rule_set_digest: string;
  rule_count: number;
  claims_release: string;
  claims_high_water: number;
  source_revision: number;
  visibility_revision: number;
  core_epoch: string;
  status: "building" | "complete" | "retired";
  estimate_count: number;
  simulation_count: number;
  output_digest: string | null;
  input_manifest_json: string;
  policy_release: string;
  created_at: string;
  completed_at: string | null;
}

/** The published reward snapshot; only through the pointer, never "the newest". */
export const ACTIVE_REWARD_SNAPSHOT_SQL = `SELECT ${snapshotColumns("s.")}
  FROM reward_snapshot_pointer p
  JOIN reward_expiry_snapshots s ON s.snapshot_id=p.snapshot_id AND s.status='complete'
  WHERE p.id=1`;

/** A snapshot a cursor names; absent or retired means the context expired. */
export const REWARD_SNAPSHOT_SQL = `SELECT ${SNAPSHOT_COLUMNS} FROM reward_expiry_snapshots
  WHERE snapshot_id=?1 AND status='complete'`;

export const REWARD_POINTER_SQL = `SELECT snapshot_id, source_revision, visibility_revision,
    core_epoch, read_instance_id, evaluated_at, output_digest, switched_at
  FROM reward_snapshot_pointer WHERE id=1`;

/** The build of this content that may still be continued or reused. */
export const REWARD_SNAPSHOT_FOR_CONTENT_SQL = `SELECT ${SNAPSHOT_COLUMNS}
  FROM reward_expiry_snapshots WHERE content_key=?1 AND status IN ('building','complete')
  ORDER BY status='building' DESC, attempt DESC LIMIT 1`;

export const OLDEST_BUILDING_REWARD_SNAPSHOT_SQL = `SELECT ${SNAPSHOT_COLUMNS}
  FROM reward_expiry_snapshots WHERE status='building'
  ORDER BY created_at, snapshot_id LIMIT 1`;

export const NEXT_REWARD_ATTEMPT_SQL =
  "SELECT coalesce(max(attempt),0)+1 AS attempt FROM reward_expiry_snapshots WHERE content_key=?1";

/** Written rows of a build, in contract order, with their digests. */
export const WRITTEN_REWARD_ESTIMATE_DIGESTS_SQL = `SELECT row_seq, row_digest
  FROM reward_expiry_estimates WHERE snapshot_id=?1 ORDER BY row_seq`;
export const WRITTEN_REWARD_SIMULATION_DIGESTS_SQL = `SELECT row_seq, row_digest
  FROM reward_conversion_simulations WHERE snapshot_id=?1 ORDER BY row_seq`;

export const REWARD_CHECKPOINT_SQL = `SELECT position, rows_written
  FROM reward_build_checkpoints WHERE snapshot_id=?1 AND stage=?2`;

/** Builds that may be retired: complete or abandoned, never the published one. */
export const RETIREABLE_REWARD_SNAPSHOTS_SQL = `SELECT snapshot_id FROM reward_expiry_snapshots
  WHERE snapshot_id<>?1 AND status IN ('complete','building')
    AND snapshot_id<>coalesce((SELECT p.snapshot_id FROM reward_snapshot_pointer p
      WHERE p.id=1),'')
  ORDER BY created_at DESC, snapshot_id DESC LIMIT 50 OFFSET ?2`;

/** One page of a published snapshot's estimates, in deadline-and-contract order. */
export const REWARD_ESTIMATE_PAGE_SQL = `SELECT snapshot_id, row_key, row_seq, program_id,
    holding_ref, bucket_ref, rule_id, rule_version, bucket_kind, state, deadline_basis, expires_on,
    amount_coefficient, amount_scale, amount_status, unit_ref, provider_observed_json,
    policy_estimated_json, reason_codes_json, uncertainty_codes_json, basis_refs_json, row_digest
  FROM reward_expiry_estimates
  WHERE snapshot_id=?1 AND (?2 IS NULL OR program_id=?2) AND row_seq>?3
  ORDER BY row_seq LIMIT ?4`;

export const REWARD_SIMULATION_PAGE_SQL = `SELECT snapshot_id, request_digest, row_seq,
    reproducibility, reason_code, request_json, offer_id, offer_version, result_json,
    search_coverage, evaluated_at, policy_release, row_digest
  FROM reward_conversion_simulations
  WHERE snapshot_id=?1 AND row_seq>?2 ORDER BY row_seq LIMIT ?3`;

export interface RewardEstimateRow {
  snapshot_id: string;
  row_key: string;
  row_seq: number;
  program_id: string;
  holding_ref: string;
  bucket_ref: string;
  rule_id: string;
  rule_version: string;
  bucket_kind: string;
  state: string;
  deadline_basis: string;
  expires_on: string | null;
  amount_coefficient: string | null;
  amount_scale: number | null;
  amount_status: string;
  unit_ref: string;
  provider_observed_json: string | null;
  policy_estimated_json: string | null;
  reason_codes_json: string;
  uncertainty_codes_json: string;
  basis_refs_json: string;
  row_digest: string;
}

export interface RewardSimulationRow {
  snapshot_id: string;
  request_digest: string;
  row_seq: number;
  reproducibility: "reproduced" | "not_reproducible";
  reason_code: string | null;
  request_json: string | null;
  offer_id: string | null;
  offer_version: string | null;
  result_json: string | null;
  search_coverage: string;
  evaluated_at: string;
  policy_release: string;
  row_digest: string;
}

export interface RewardPointerRow {
  snapshot_id: string;
  source_revision: number;
  visibility_revision: number;
  core_epoch: string;
  read_instance_id: string;
  evaluated_at: string;
  output_digest: string;
  switched_at: string;
}

export interface RewardSnapshotPlan {
  contentKey: string;
  inputDigest: string;
  buildDigest: string;
  contractVersion: string;
  /** The fixed evaluation instant; part of the content that was hashed. */
  evaluatedAt: string;
  calendarRuleId: string;
  ruleSetDigest: string;
  ruleCount: number;
  claimsRelease: string;
  claimsHighWater: number;
  sourceRevision: number;
  visibilityRevision: number;
  coreEpoch: string;
  inputManifestJson: string;
  policyRelease: string;
  inputRefs: readonly RewardInputRef[];
}

export interface StartedRewardSnapshot {
  snapshotId: string;
  attempt: number;
}

/** The build of this content that may be continued (`building`) or reused. */
export async function rewardSnapshotForContent(
  db: D1Like,
  contentKey: string,
): Promise<RewardSnapshotRow | null> {
  return await db
    .prepare(REWARD_SNAPSHOT_FOR_CONTENT_SQL)
    .bind(contentKey)
    .first<RewardSnapshotRow>();
}

/** The oldest unfinished build; the next invocation continues it from its input. */
export async function oldestBuildingRewardSnapshot(db: D1Like): Promise<RewardSnapshotRow | null> {
  return await db.prepare(OLDEST_BUILDING_REWARD_SNAPSHOT_SQL).bind().first<RewardSnapshotRow>();
}

/**
 * Start a build: the next attempt of this content, its snapshot row and the
 * CORE references it was built from, in one batch. The refs go in with the row
 * because the estimate and simulation triggers read them — a deadline can only
 * name a rule this snapshot fixed, and a replay only an offer it carried.
 *
 * The row is inserted only while no `building` or `complete` build of the
 * content exists, so two invocations that both looked and found nothing cannot
 * both start one: the loser's insert matches nothing, the refs in the same
 * batch then abort it (their trigger needs a building snapshot), and the batch
 * rolls back. The caller gets `null` and continues the winner's build on its
 * next tick — the same guard the balance writer keeps.
 */
export async function beginRewardSnapshot(
  db: D1Like,
  readInstanceId: string,
  plan: RewardSnapshotPlan,
  now: string,
): Promise<StartedRewardSnapshot | null> {
  const next = await db
    .prepare(NEXT_REWARD_ATTEMPT_SQL)
    .bind(plan.contentKey)
    .first<{ attempt: number }>();
  const attempt = next?.attempt ?? 1;
  const snapshotId = await readSnapshotId(plan.contentKey, attempt, plan.contractVersion);
  try {
    await runBatch(db, [
      db
        .prepare(
          `INSERT INTO reward_expiry_snapshots(snapshot_id,content_key,attempt,input_digest,
            build_digest,contract_version,read_instance_id,evaluated_at,calendar_rule_id,
            rule_set_digest,rule_count,claims_release,claims_high_water,source_revision,
            visibility_revision,core_epoch,status,estimate_count,simulation_count,output_digest,
            writer_lease,writer_lease_until_ms,writer_fence,input_manifest_json,policy_release,
            created_at,completed_at)
           SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,'building',0,0,NULL,
             NULL,0,0,?17,?18,?19,NULL
           WHERE NOT EXISTS(SELECT 1 FROM reward_expiry_snapshots r
             WHERE r.content_key=?2 AND r.status IN ('building','complete'))`,
        )
        .bind(
          snapshotId,
          plan.contentKey,
          attempt,
          plan.inputDigest,
          plan.buildDigest,
          plan.contractVersion,
          readInstanceId,
          plan.evaluatedAt,
          plan.calendarRuleId,
          plan.ruleSetDigest,
          plan.ruleCount,
          plan.claimsRelease,
          plan.claimsHighWater,
          plan.sourceRevision,
          plan.visibilityRevision,
          plan.coreEpoch,
          plan.inputManifestJson,
          plan.policyRelease,
          now,
        ),
      // The first ref doubles as the guard's witness: with no row inserted its
      // `building` trigger aborts the batch. A reward plan always carries at
      // least the evaluation clock and the calendar, and one without refs is
      // settled by the read-back below.
      ...plan.inputRefs.map((ref) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO reward_snapshot_input_refs(snapshot_id,ref_kind,ref_id,
              ref_digest,core_epoch,created_at) VALUES(?1,?2,?3,?4,?5,?6)`,
          )
          .bind(snapshotId, ref.kind, ref.id, ref.digest, plan.coreEpoch, now),
      ),
    ]);
  } catch (error) {
    if (await rewardSnapshotForContent(db, plan.contentKey)) return null;
    throw error;
  }
  if (plan.inputRefs.length === 0) {
    const started = await rewardSnapshotForContent(db, plan.contentKey);
    if (started?.snapshot_id !== snapshotId) return null;
  }
  return { snapshotId, attempt };
}

/** Claim the build for this invocation and raise the fence. */
export async function claimRewardWriterLease(
  db: D1Like,
  snapshotId: string,
  lease: string,
  nowMs: number,
  leaseMs: number,
): Promise<boolean> {
  const claim = await db
    .prepare(
      `UPDATE reward_expiry_snapshots SET writer_lease=?2,writer_lease_until_ms=?3,
        writer_fence=writer_fence+1
       WHERE snapshot_id=?1 AND status='building'
         AND (writer_lease IS NULL OR writer_lease=?2 OR writer_lease_until_ms<=?4)`,
    )
    .bind(snapshotId, lease, nowMs + leaseMs, nowMs)
    .run();
  return claim.meta.changes === 1;
}

/** Hand the build back so the next invocation takes it over without waiting. */
export async function releaseRewardWriterLease(
  db: D1Like,
  snapshotId: string,
  lease: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE reward_expiry_snapshots SET writer_lease=NULL,writer_lease_until_ms=0
       WHERE snapshot_id=?1 AND status='building' AND writer_lease=?2`,
    )
    .bind(snapshotId, lease)
    .run();
}

/** The fence this invocation holds, or null when the lease is gone. */
export async function rewardWriterFence(
  db: D1Like,
  snapshotId: string,
  lease: string,
): Promise<number | null> {
  const held = await db
    .prepare(
      `SELECT writer_fence FROM reward_expiry_snapshots
       WHERE snapshot_id=?1 AND status='building' AND writer_lease=?2`,
    )
    .bind(snapshotId, lease)
    .first<{ writer_fence: number }>();
  return held?.writer_fence ?? null;
}

export type RewardBuildStage = "estimates" | "simulations";

/** Where a bounded build got to in one stage; -1 before its first chunk. */
export async function rewardCheckpoint(
  db: D1Like,
  snapshotId: string,
  stage: RewardBuildStage,
): Promise<number> {
  const row = await db
    .prepare(REWARD_CHECKPOINT_SQL)
    .bind(snapshotId, stage)
    .first<{ position: string; rows_written: number }>();
  return row === null ? -1 : Number(row.position);
}

/** Content digest of one estimate row; the key to a decidable re-send. */
export async function rewardEstimateDigest(row: RewardExpiryProjectionRow): Promise<string> {
  return await sha256Hex(canonicalJson(row));
}

/** Content digest of one replayed simulation row. */
export async function rewardSimulationDigest(row: RewardSimulationProjectionRow): Promise<string> {
  return await sha256Hex(canonicalJson(row));
}

function checkpointStatement(
  db: D1Like,
  snapshotId: string,
  stage: RewardBuildStage,
  position: string,
  rowsWritten: number,
  lease: string,
  fence: number,
  now: string,
): D1StatementLike {
  // Guarded by the lease exactly like the rows it records, so a displaced
  // writer's batch changes nothing and reports that it changed nothing.
  return db
    .prepare(
      `INSERT INTO reward_build_checkpoints(snapshot_id,stage,position,rows_written,writer_lease,
        writer_fence,updated_at)
       SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM reward_expiry_snapshots s
         WHERE s.snapshot_id=?1 AND s.status='building' AND s.writer_lease=?5)
       ON CONFLICT(snapshot_id,stage) DO UPDATE SET position=excluded.position,
         rows_written=excluded.rows_written,writer_lease=excluded.writer_lease,
         writer_fence=excluded.writer_fence,updated_at=excluded.updated_at`,
    )
    .bind(snapshotId, stage, position, rowsWritten, lease, fence, now);
}

export type RewardChunkOutcome = "written" | "lease_lost";

function insertEstimate(
  db: D1Like,
  snapshotId: string,
  row: RewardExpiryProjectionRow,
  digest: string,
): D1StatementLike {
  return db
    .prepare(
      `INSERT OR IGNORE INTO reward_expiry_estimates(snapshot_id,row_key,row_seq,program_id,
        holding_ref,bucket_ref,rule_id,rule_version,bucket_kind,state,deadline_basis,expires_on,
        amount_coefficient,amount_scale,amount_status,unit_ref,provider_observed_json,
        policy_estimated_json,reason_codes_json,uncertainty_codes_json,basis_refs_json,row_digest)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`,
    )
    .bind(
      snapshotId,
      row.rowKey,
      row.rowSeq,
      row.programId,
      row.holdingRef,
      row.bucketRef,
      row.ruleId,
      row.ruleVersion,
      row.bucketKind,
      row.state,
      row.deadlineBasis,
      row.expiresOn,
      row.amountCoefficient,
      row.amountScale,
      row.amountStatus,
      row.unitRef,
      row.providerObserved === null ? null : JSON.stringify(row.providerObserved),
      row.policyEstimated === null ? null : JSON.stringify(row.policyEstimated),
      JSON.stringify(row.reasonCodes),
      JSON.stringify(row.uncertaintyCodes),
      JSON.stringify(row.basisRefs),
      digest,
    );
}

function insertSimulation(
  db: D1Like,
  snapshotId: string,
  row: RewardSimulationProjectionRow,
  digest: string,
): D1StatementLike {
  return db
    .prepare(
      `INSERT OR IGNORE INTO reward_conversion_simulations(snapshot_id,request_digest,row_seq,
        reproducibility,reason_code,request_json,offer_id,offer_version,result_json,
        search_coverage,evaluated_at,policy_release,row_digest)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
    )
    .bind(
      snapshotId,
      row.requestDigest,
      row.rowSeq,
      row.reproducibility,
      row.reasonCode,
      row.request === null ? null : JSON.stringify(row.request),
      row.offerId,
      row.offerVersion,
      row.result === null ? null : JSON.stringify(row.result),
      row.searchCoverage,
      row.evaluatedAt,
      row.policyRelease,
      digest,
    );
}

/**
 * One chunk of estimates and the checkpoint that records it, in one batch. A
 * statement error rolls back both; a re-sent chunk with identical content is
 * ignored, and different content for a written row raises the trigger.
 */
export async function writeRewardEstimateChunk(
  db: D1Like,
  snapshotId: string,
  rows: readonly { row: RewardExpiryProjectionRow; digest: string }[],
  context: { lease: string; fence: number; now: string; rowsWritten: number },
): Promise<RewardChunkOutcome> {
  if (rows.length === 0) return "written";
  const last = rows[rows.length - 1] as { row: RewardExpiryProjectionRow; digest: string };
  const results = await runBatch(db, [
    ...rows.map((entry) => insertEstimate(db, snapshotId, entry.row, entry.digest)),
    checkpointStatement(
      db,
      snapshotId,
      "estimates",
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

/** The same, for the replayed simulations of this snapshot. */
export async function writeRewardSimulationChunk(
  db: D1Like,
  snapshotId: string,
  rows: readonly { row: RewardSimulationProjectionRow; digest: string }[],
  context: { lease: string; fence: number; now: string; rowsWritten: number },
): Promise<RewardChunkOutcome> {
  if (rows.length === 0) return "written";
  const last = rows[rows.length - 1] as { row: RewardSimulationProjectionRow; digest: string };
  const results = await runBatch(db, [
    ...rows.map((entry) => insertSimulation(db, snapshotId, entry.row, entry.digest)),
    checkpointStatement(
      db,
      snapshotId,
      "simulations",
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
 * What was written is what the build produced: the same count, a dense
 * sequence in contract order, and the same digest at every position. A build
 * that cannot prove this does not seal (05 §5).
 */
export async function writtenRewardRowsMatch(
  db: D1Like,
  snapshotId: string,
  digests: { estimates: readonly string[]; simulations: readonly string[] },
): Promise<boolean> {
  for (const [sql, expected] of [
    [WRITTEN_REWARD_ESTIMATE_DIGESTS_SQL, digests.estimates],
    [WRITTEN_REWARD_SIMULATION_DIGESTS_SQL, digests.simulations],
  ] as const) {
    const stored = await db
      .prepare(sql)
      .bind(snapshotId)
      .all<{ row_seq: number; row_digest: string }>();
    if (stored.results.length !== expected.length) return false;
    if (
      !stored.results.every(
        (row, index) => row.row_seq === index && row.row_digest === expected[index],
      )
    )
      return false;
  }
  return true;
}

export interface RewardSealOutcome {
  sealed: boolean;
  published: boolean;
  outputDigest: string;
}

/**
 * Seal the snapshot and switch the pointer in one batch, under the lease.
 *
 * The seal keeps the lease on the row as "sealed by", and the pointer
 * statement of the same batch names only a snapshot that lease sealed: a
 * displaced writer arriving after its successor sealed the same build changes
 * nothing in either statement (G2-09).
 *
 * The pointer moves only forward: never to an older source revision under the
 * same epoch, and never — at the same revision — to an older evaluation
 * instant, so a build that finishes late is complete without pulling the
 * published deadlines back in time (G2-10).
 */
export async function sealAndPublishRewardSnapshot(
  db: D1Like,
  snapshot: {
    snapshotId: string;
    readInstanceId: string;
    sourceRevision: number;
    visibilityRevision: number;
    coreEpoch: string;
    evaluatedAt: string;
  },
  build: {
    estimateCount: number;
    simulationCount: number;
    rowDigests: readonly string[];
  },
  context: { lease: string; now: string },
): Promise<RewardSealOutcome> {
  const outputDigest = await readOutputDigest(build.rowDigests);
  const results = await runBatch(db, [
    db
      .prepare(
        // `writer_lease` stays: it is what the pointer statement below names as
        // the seal's author, and a complete build takes no further writes.
        `UPDATE reward_expiry_snapshots SET status='complete',completed_at=?2,estimate_count=?3,
          simulation_count=?4,output_digest=?5,writer_lease_until_ms=0
         WHERE snapshot_id=?1 AND status='building' AND writer_lease=?6`,
      )
      .bind(
        snapshot.snapshotId,
        context.now,
        build.estimateCount,
        build.simulationCount,
        outputDigest,
        context.lease,
      ),
    rewardPointerStatement(db, { ...snapshot, outputDigest }, context.now, context.lease),
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
 * Switch the active reward pointer to a complete snapshot, forward only.
 * Exported so the test that proves the rule runs the statement the writer
 * runs.
 *
 * `sealedBy` is the lease of the seal in the same batch: with it the statement
 * names only a snapshot that lease sealed, so a displaced writer cannot switch
 * the pointer to a build its successor finished. Without it any complete local
 * snapshot qualifies.
 */
export function rewardPointerStatement(
  db: D1Like,
  snapshot: {
    snapshotId: string;
    readInstanceId: string;
    sourceRevision: number;
    visibilityRevision: number;
    coreEpoch: string;
    evaluatedAt: string;
    outputDigest: string;
  },
  now: string,
  sealedBy: string | null = null,
): D1StatementLike {
  return db
    .prepare(
      `INSERT INTO reward_snapshot_pointer(id,snapshot_id,source_revision,visibility_revision,
        core_epoch,read_instance_id,evaluated_at,output_digest,switched_at)
       SELECT 1,?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM reward_expiry_snapshots s
         WHERE s.snapshot_id=?1 AND s.status='complete' AND (?9 IS NULL OR s.writer_lease=?9))
       ON CONFLICT(id) DO UPDATE SET snapshot_id=excluded.snapshot_id,
         source_revision=excluded.source_revision,
         visibility_revision=excluded.visibility_revision,core_epoch=excluded.core_epoch,
         read_instance_id=excluded.read_instance_id,evaluated_at=excluded.evaluated_at,
         output_digest=excluded.output_digest,switched_at=excluded.switched_at
       WHERE excluded.core_epoch<>reward_snapshot_pointer.core_epoch
          OR excluded.source_revision>reward_snapshot_pointer.source_revision
          OR (excluded.source_revision=reward_snapshot_pointer.source_revision
              AND excluded.evaluated_at>=reward_snapshot_pointer.evaluated_at)`,
    )
    .bind(
      snapshot.snapshotId,
      snapshot.sourceRevision,
      snapshot.visibilityRevision,
      snapshot.coreEpoch,
      snapshot.readInstanceId,
      snapshot.evaluatedAt,
      snapshot.outputDigest,
      now,
      sealedBy,
    );
}

export async function rewardPointer(db: D1Like): Promise<RewardPointerRow | null> {
  return await db.prepare(REWARD_POINTER_SQL).bind().first<RewardPointerRow>();
}

/** The published snapshot, or null when this database publishes nothing yet. */
export async function activeRewardSnapshot(db: D1Like): Promise<RewardSnapshotRow | null> {
  return await db.prepare(ACTIVE_REWARD_SNAPSHOT_SQL).bind().first<RewardSnapshotRow>();
}

/** A complete snapshot by id; a retired or missing one is a expired context. */
export async function rewardSnapshot(
  db: D1Like,
  snapshotId: string,
): Promise<RewardSnapshotRow | null> {
  return await db.prepare(REWARD_SNAPSHOT_SQL).bind(snapshotId).first<RewardSnapshotRow>();
}

/** One page of estimates of a published snapshot, after `afterRowSeq`. */
export async function rewardEstimatePage(
  db: D1Like,
  snapshotId: string,
  scope: { programId?: string | undefined; afterRowSeq: number; limit: number },
): Promise<RewardEstimateRow[]> {
  const rows = await db
    .prepare(REWARD_ESTIMATE_PAGE_SQL)
    .bind(snapshotId, scope.programId ?? null, scope.afterRowSeq, scope.limit)
    .all<RewardEstimateRow>();
  return rows.results;
}

/** One page of replayed simulations of a published snapshot. */
export async function rewardSimulationPage(
  db: D1Like,
  snapshotId: string,
  scope: { afterRowSeq: number; limit: number },
): Promise<RewardSimulationRow[]> {
  const rows = await db
    .prepare(REWARD_SIMULATION_PAGE_SQL)
    .bind(snapshotId, scope.afterRowSeq, scope.limit)
    .all<RewardSimulationRow>();
  return rows.results;
}

/**
 * Retire builds older than the retained window and delete their rows. A reader
 * on an older cursor gets `context_expired` rather than a silently different
 * list, and the published snapshot is never retired.
 */
export async function retireOldRewardSnapshots(
  db: D1Like,
  keep: string,
  retained: number = REWARD_RETAINED_SNAPSHOTS,
): Promise<number> {
  const stale = await db
    .prepare(RETIREABLE_REWARD_SNAPSHOTS_SQL)
    .bind(keep, Math.max(retained - 1, 0))
    .all<{ snapshot_id: string }>();
  for (const row of stale.results) await retireRewardSnapshot(db, row.snapshot_id, "retired");
  return stale.results.length;
}

/** Retire one unfinished build and drop what it wrote; the next tick starts a new attempt. */
export async function abandonRewardSnapshot(db: D1Like, snapshotId: string): Promise<void> {
  await retireRewardSnapshot(db, snapshotId, "building");
}

async function retireRewardSnapshot(
  db: D1Like,
  snapshotId: string,
  from: "building" | "retired",
): Promise<void> {
  await db
    .prepare(
      from === "building"
        ? "UPDATE reward_expiry_snapshots SET status='retired' WHERE snapshot_id=?1 AND status='building'"
        : "UPDATE reward_expiry_snapshots SET status='retired' WHERE snapshot_id=?1",
    )
    .bind(snapshotId)
    .run();
  await runBatch(db, [
    db.prepare("DELETE FROM reward_expiry_estimates WHERE snapshot_id=?1").bind(snapshotId),
    db.prepare("DELETE FROM reward_conversion_simulations WHERE snapshot_id=?1").bind(snapshotId),
    db.prepare("DELETE FROM reward_snapshot_input_refs WHERE snapshot_id=?1").bind(snapshotId),
    db.prepare("DELETE FROM reward_build_checkpoints WHERE snapshot_id=?1").bind(snapshotId),
  ]);
}
