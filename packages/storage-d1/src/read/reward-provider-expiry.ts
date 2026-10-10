// One bounded provider-display stream inside the existing fixed reward snapshot.
import { canonicalJson, sha256Hex } from "../../../domain/src/context.ts";
import {
  validRewardProviderExpirySection,
  type RewardProviderExpirySection,
} from "../../../domain/src/reward-expiry-observations.ts";
import { runBatch, type D1Like } from "../d1.ts";
export interface RewardProviderSectionRow {
  rowSeq: number;
  rowKey: string;
  section: RewardProviderExpirySection;
  digest: string;
}
export async function rewardProviderSectionRows(
  sections: readonly RewardProviderExpirySection[],
): Promise<RewardProviderSectionRow[]> {
  const ordered = [...sections].sort((a, b) =>
    a.parentBucketRef < b.parentBucketRef ? -1 : a.parentBucketRef > b.parentBucketRef ? 1 : 0,
  );
  if (new Set(ordered.map((section) => section.parentBucketRef)).size !== ordered.length)
    throw new Error("provider_display_parent_duplicated");
  return await Promise.all(
    ordered.map(async (section, rowSeq) => {
      if (!validRewardProviderExpirySection(section)) throw new Error("provider_display_invalid");
      const rowKey = section.parentBucketRef;
      return {
        rowSeq,
        rowKey,
        section,
        digest: await sha256Hex(canonicalJson({ rowSeq, rowKey, section })),
      };
    }),
  );
}
export async function rewardProviderCheckpoint(db: D1Like, snapshotId: string): Promise<number> {
  const row = await db
    .prepare("SELECT position FROM reward_provider_display_checkpoints WHERE snapshot_id=?")
    .bind(snapshotId)
    .first<{ position: number }>();
  return row?.position ?? -1;
}
export async function writeRewardProviderSectionChunk(
  db: D1Like,
  snapshotId: string,
  rows: readonly RewardProviderSectionRow[],
  context: { lease: string; fence: number; now: string; rowsWritten: number },
): Promise<"written" | "lease_lost"> {
  if (rows.length === 0) return "written";
  const last = rows[rows.length - 1]!;
  const results = await runBatch(db, [
    ...rows.map((row) =>
      db
        .prepare(`INSERT OR IGNORE INTO reward_provider_expiry_sections(snapshot_id,row_key,row_seq,program_id,payload_json,row_digest)
 SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM reward_expiry_snapshots WHERE snapshot_id=?1 AND status='building' AND writer_lease=?7 AND writer_fence=?8)`)
        .bind(
          snapshotId,
          row.rowKey,
          row.rowSeq,
          row.section.programId,
          canonicalJson(row.section),
          row.digest,
          context.lease,
          context.fence,
        ),
    ),
    db
      .prepare(`INSERT INTO reward_provider_display_checkpoints(snapshot_id,position,rows_written,writer_lease,writer_fence,updated_at)
 SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM reward_expiry_snapshots WHERE snapshot_id=?1 AND status='building' AND writer_lease=?4 AND writer_fence=?5)
 ON CONFLICT(snapshot_id) DO UPDATE SET position=excluded.position,rows_written=excluded.rows_written,writer_lease=excluded.writer_lease,writer_fence=excluded.writer_fence,updated_at=excluded.updated_at`)
      .bind(
        snapshotId,
        last.rowSeq,
        context.rowsWritten + rows.length,
        context.lease,
        context.fence,
        context.now,
      ),
  ]);
  return results[results.length - 1]?.meta.changes === 1 ? "written" : "lease_lost";
}
export async function writtenRewardProviderSectionsMatch(
  db: D1Like,
  snapshotId: string,
  digests: readonly string[],
): Promise<boolean> {
  const rows = (
    await db
      .prepare(
        "SELECT row_seq,row_digest FROM reward_provider_expiry_sections WHERE snapshot_id=? ORDER BY row_seq",
      )
      .bind(snapshotId)
      .all<{ row_seq: number; row_digest: string }>()
  ).results;
  return (
    rows.length === digests.length &&
    rows.every((row, index) => row.row_seq === index && row.row_digest === digests[index])
  );
}
export async function rewardProviderSections(
  db: D1Like,
  snapshotId: string,
  programId?: string,
): Promise<RewardProviderExpirySection[]> {
  const rows = (
    await db
      .prepare(
        `SELECT r.payload_json FROM reward_provider_expiry_sections r JOIN reward_expiry_snapshots s ON s.snapshot_id=r.snapshot_id AND s.status='complete' WHERE r.snapshot_id=?1 AND (?2 IS NULL OR r.program_id=?2) ORDER BY r.row_seq LIMIT 201`,
      )
      .bind(snapshotId, programId ?? null)
      .all<{ payload_json: string }>()
  ).results;
  if (rows.length > 200) throw new Error("provider_display_set_too_large");
  return rows.map((row) => {
    const value: unknown = JSON.parse(row.payload_json);
    if (!validRewardProviderExpirySection(value)) throw new Error("provider_display_invalid");
    return value;
  });
}
