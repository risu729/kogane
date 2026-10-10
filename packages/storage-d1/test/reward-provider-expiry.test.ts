import { expect, test } from "bun:test";
import { createSqliteReadDatabase } from "./sqlite-read-database.ts";
import {
  ensureReadInstance,
  beginRewardSnapshot,
  claimRewardWriterLease,
  rewardWriterFence,
  sealAndPublishRewardSnapshot,
  abandonRewardSnapshot,
} from "../src/read/index.ts";
import {
  rewardProviderSectionRows,
  writeRewardProviderSectionChunk,
  rewardProviderCheckpoint,
  writtenRewardProviderSectionsMatch,
  rewardProviderSections,
} from "../src/read/reward-provider-expiry.ts";
import type { RewardProviderExpirySection } from "../../domain/src/reward-expiry-observations.ts";
const section: RewardProviderExpirySection = {
  programId: "program:j-point",
  holdingRef: "conn",
  parentBucketRef: "total",
  unitRef: "points:j-point",
  coverage: "not-displayed",
  reasonCode: "provider_expiry_not_displayed",
  displays: [],
  observedAt: { kind: "unknown", reasonCode: "synthetic_time_unknown" },
  sourceFactRefs: ["balance:1"],
};
const now = "2099-01-01T00:00:00.000Z";
async function setup() {
  const { d1: db, sqlite } = createSqliteReadDatabase();
  const instance = await ensureReadInstance(db, now, "provider-instance-0001");
  const start = await beginRewardSnapshot(
    db,
    instance.read_instance_id,
    {
      contentKey: "a".repeat(64),
      inputDigest: "b".repeat(64),
      buildDigest: "c".repeat(64),
      contractVersion: "reward-projection-input-v3",
      evaluatedAt: now,
      calendarRuleId: "UTC:start-of-day:assumed",
      ruleSetDigest: "d".repeat(64),
      ruleCount: 0,
      claimsRelease: "reward-promotion-v2",
      claimsHighWater: 1,
      sourceRevision: 1,
      visibilityRevision: 1,
      coreEpoch: "synthetic-epoch",
      inputManifestJson: "{}",
      policyRelease: "reward-projection-v4",
      inputRefs: [],
    },
    now,
  );
  if (!start) throw new Error("synthetic snapshot unavailable");
  await claimRewardWriterLease(db, start.snapshotId, "lease", Date.parse(now), 60000);
  return {
    db,
    sqlite,
    snapshotId: start.snapshotId,
    instanceId: instance.read_instance_id,
    fence: (await rewardWriterFence(db, start.snapshotId, "lease"))!,
  };
}
test("companion section retains empty coverage, idempotent chunks, conflicts and lease fencing", async () => {
  const s = await setup();
  const rows = await rewardProviderSectionRows([section]);
  const ctx = { lease: "lease", fence: s.fence, now, rowsWritten: 0 };
  expect(
    await writeRewardProviderSectionChunk(s.db, s.snapshotId, rows, { ...ctx, lease: "stale" }),
  ).toBe("lease_lost");
  expect(await rewardProviderCheckpoint(s.db, s.snapshotId)).toBe(-1);
  expect(await writeRewardProviderSectionChunk(s.db, s.snapshotId, rows, ctx)).toBe("written");
  expect(await writeRewardProviderSectionChunk(s.db, s.snapshotId, rows, ctx)).toBe("written");
  expect(await rewardProviderCheckpoint(s.db, s.snapshotId)).toBe(0);
  expect(await writtenRewardProviderSectionsMatch(s.db, s.snapshotId, [])).toBe(false);
  expect(await writtenRewardProviderSectionsMatch(s.db, s.snapshotId, [rows[0]!.digest])).toBe(
    true,
  );
  const changed = await rewardProviderSectionRows([
    { ...section, coverage: "unknown", reasonCode: "provider_expiry_unavailable" },
  ]);
  await expect(writeRewardProviderSectionChunk(s.db, s.snapshotId, changed, ctx)).rejects.toThrow(
    "conflict",
  );
  expect(await rewardProviderSections(s.db, s.snapshotId)).toEqual([]);
  await abandonRewardSnapshot(s.db, s.snapshotId);
  expect(s.sqlite.query("SELECT count(*) n FROM reward_provider_expiry_sections").get()).toEqual({
    n: 0,
  });
  s.sqlite.close();
});
test("provider-only section seals without a fake rule; rows and count are immutable", async () => {
  const s = await setup();
  const rows = await rewardProviderSectionRows([section]);
  await writeRewardProviderSectionChunk(s.db, s.snapshotId, rows, {
    lease: "lease",
    fence: s.fence,
    now,
    rowsWritten: 0,
  });
  const seal = await sealAndPublishRewardSnapshot(
    s.db,
    {
      snapshotId: s.snapshotId,
      readInstanceId: s.instanceId,
      sourceRevision: 1,
      visibilityRevision: 1,
      coreEpoch: "synthetic-epoch",
      evaluatedAt: now,
    },
    {
      estimateCount: 0,
      simulationCount: 0,
      providerSectionCount: 1,
      rowDigests: rows.map((r) => r.digest),
    },
    { lease: "lease", now },
  );
  expect(seal.published).toBe(true);
  expect(await rewardProviderSections(s.db, s.snapshotId)).toEqual([section]);
  expect(() =>
    s.sqlite.run(
      "UPDATE reward_expiry_snapshots SET provider_section_count=0 WHERE snapshot_id=?",
      [s.snapshotId],
    ),
  ).toThrow("immutable");
  expect(() =>
    s.sqlite.run("UPDATE reward_provider_expiry_sections SET payload_json='{}'"),
  ).toThrow("immutable");
  expect(() => s.sqlite.run("DELETE FROM reward_provider_expiry_sections")).toThrow("retirement");
  s.sqlite.close();
});
