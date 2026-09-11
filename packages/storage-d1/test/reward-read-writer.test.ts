// The reward READ adapters of migration 0002 (unified plan 04 §2, 05 §3–§5;
// U16).
//
// Acceptance: G2-19 (the evaluation instant is part of the identity: the same
// input rebuilds identically, a later instant is a new snapshot and the old one
// is never mutated), G2-20 (a saved simulation that kept only a digest is
// stored as `not_reproducible`), plus the baseline's rules carried over —
// a re-sent chunk, a displaced writer, and a pointer that never moves
// backwards. Every value below is synthetic.
import { describe, expect, test } from "bun:test";
import {
  abandonRewardSnapshot,
  activeRewardSnapshot,
  beginRewardSnapshot,
  claimRewardWriterLease,
  ensureReadInstance,
  readContentKey,
  retireOldRewardSnapshots,
  rewardCheckpoint,
  rewardEstimateDigest,
  rewardEstimatePage,
  rewardPointer,
  rewardPointerStatement,
  rewardSimulationDigest,
  rewardSimulationPage,
  rewardSnapshotForContent,
  rewardWriterFence,
  sealAndPublishRewardSnapshot,
  writeRewardEstimateChunk,
  writeRewardSimulationChunk,
  writtenRewardRowsMatch,
  type RewardSnapshotPlan,
} from "../src/read/index.ts";
import { createSqliteReadDatabase } from "./sqlite-read-database.ts";
import {
  buildRewardProjection,
  type RewardExpiryProjectionRow,
  type RewardSimulationProjectionRow,
} from "../../read-model/src/index.ts";
import { rewardInput, REWARD_DIGEST_A, REWARD_DIGEST_B } from "./reward-fixtures.ts";
import type { D1Like } from "../src/d1.ts";
import type { Database } from "bun:sqlite";

const NOW = "2026-09-11T00:00:00.000Z";
const EVALUATED_AT = "2026-09-11T00:00:00.000Z";

async function claimed(): Promise<{ db: D1Like; sqlite: Database; instanceId: string }> {
  const { d1: db, sqlite } = createSqliteReadDatabase();
  const instance = await ensureReadInstance(db, NOW, "reward-instance-0001");
  return { db, sqlite, instanceId: instance.read_instance_id };
}

async function plan(overrides: Partial<RewardSnapshotPlan> = {}): Promise<RewardSnapshotPlan> {
  const projection = buildRewardProjection(rewardInput({ evaluatedAt: EVALUATED_AT }).content);
  return {
    contentKey: await readContentKey(REWARD_DIGEST_A, REWARD_DIGEST_B),
    inputDigest: REWARD_DIGEST_A,
    buildDigest: REWARD_DIGEST_B,
    contractVersion: "reward-projection-input-v1",
    evaluatedAt: EVALUATED_AT,
    calendarRuleId: "UTC:start-of-day:assumed",
    ruleSetDigest: "c".repeat(64),
    ruleCount: projection.ruleRefs.length,
    claimsRelease: "reward-promotion-v1",
    claimsHighWater: 12,
    sourceRevision: 10,
    visibilityRevision: 3,
    coreEpoch: "core-epoch-1",
    inputManifestJson: JSON.stringify({ evaluatedAt: EVALUATED_AT }),
    policyRelease: "reward-projection-v1",
    inputRefs: [
      ...projection.ruleRefs.map((ref) => ({
        kind: "expiry_rule" as const,
        id: ref,
        digest: "d".repeat(64),
      })),
      ...projection.offerRefs.map((ref) => ({
        kind: "conversion_offer" as const,
        id: ref,
        digest: "e".repeat(64),
      })),
      { kind: "evaluation_clock" as const, id: EVALUATED_AT, digest: "f".repeat(64) },
    ],
    ...overrides,
  };
}

async function digested(rows: {
  estimates: RewardExpiryProjectionRow[];
  simulations: RewardSimulationProjectionRow[];
}) {
  const estimates = [];
  for (const row of rows.estimates)
    estimates.push({ row, digest: await rewardEstimateDigest(row) });
  const simulations = [];
  for (const row of rows.simulations)
    simulations.push({ row, digest: await rewardSimulationDigest(row) });
  return { estimates, simulations };
}

/** One complete build, from `beginRewardSnapshot` to the pointer switch. */
async function build(
  db: D1Like,
  instanceId: string,
  overrides: Partial<RewardSnapshotPlan> = {},
  lease = "lease-1",
): Promise<{ snapshotId: string; published: boolean }> {
  const snapshotPlan = await plan(overrides);
  const started = await beginRewardSnapshot(db, instanceId, snapshotPlan, NOW);
  if (!started) throw new Error("a build of this content is already under way");
  const projection = buildRewardProjection(
    rewardInput({ evaluatedAt: snapshotPlan.evaluatedAt }).content,
  );
  const rows = await digested(projection);
  await claimRewardWriterLease(db, started.snapshotId, lease, 1_000, 60_000);
  const fence = (await rewardWriterFence(db, started.snapshotId, lease)) as number;
  await writeRewardEstimateChunk(db, started.snapshotId, rows.estimates, {
    lease,
    fence,
    now: NOW,
    rowsWritten: 0,
  });
  await writeRewardSimulationChunk(db, started.snapshotId, rows.simulations, {
    lease,
    fence,
    now: NOW,
    rowsWritten: 0,
  });
  const sealed = await sealAndPublishRewardSnapshot(
    db,
    {
      snapshotId: started.snapshotId,
      readInstanceId: instanceId,
      sourceRevision: snapshotPlan.sourceRevision,
      visibilityRevision: snapshotPlan.visibilityRevision,
      coreEpoch: snapshotPlan.coreEpoch,
      evaluatedAt: snapshotPlan.evaluatedAt,
    },
    {
      estimateCount: rows.estimates.length,
      simulationCount: rows.simulations.length,
      rowDigests: [
        ...rows.estimates.map((entry) => entry.digest),
        ...rows.simulations.map((entry) => entry.digest),
      ],
    },
    { lease, now: NOW },
  );
  expect(sealed.sealed).toBe(true);
  return { snapshotId: started.snapshotId, published: sealed.published };
}

describe("the fixed evaluation input (G2-19)", () => {
  test("the same input rebuilds identically, and a later instant is a different snapshot", async () => {
    const first = buildRewardProjection(rewardInput({ evaluatedAt: EVALUATED_AT }).content);
    const again = buildRewardProjection(rewardInput({ evaluatedAt: EVALUATED_AT }).content);
    // Row for row, digest for digest: the rebuild is the same projection.
    const digestsOf = async (rows: RewardExpiryProjectionRow[]) =>
      await Promise.all(rows.map(rewardEstimateDigest));
    expect(await digestsOf(again.estimates)).toEqual(await digestsOf(first.estimates));
    expect(again.estimates.length).toBeGreaterThan(0);

    // A different instant is a different answer, and therefore a different
    // content: it is never written over the first one.
    const later = buildRewardProjection(
      rewardInput({ evaluatedAt: "2027-03-01T00:00:00.000Z" }).content,
    );
    expect(await digestsOf(later.estimates)).not.toEqual(await digestsOf(first.estimates));
  });

  test("a snapshot's evaluation instant is immutable once written", async () => {
    const { db, sqlite, instanceId } = await claimed();
    const { snapshotId } = await build(db, instanceId);
    expect(() =>
      sqlite
        .query("UPDATE reward_expiry_snapshots SET evaluated_at=?2 WHERE snapshot_id=?1")
        .run(snapshotId, "2027-01-01T00:00:00.000Z"),
    ).toThrow(/invalid reward snapshot transition/u);
    expect(() =>
      sqlite
        .query("UPDATE reward_expiry_snapshots SET calendar_rule_id='Other' WHERE snapshot_id=?1")
        .run(snapshotId),
    ).toThrow(/invalid reward snapshot transition/u);
  });

  test("re-evaluating later builds a second snapshot and leaves the first intact", async () => {
    const { db, instanceId } = await claimed();
    const first = await build(db, instanceId);
    const firstRows = await rewardEstimatePage(db, first.snapshotId, {
      afterRowSeq: -1,
      limit: 100,
    });
    const later = await build(db, instanceId, {
      contentKey: await readContentKey(REWARD_DIGEST_B, REWARD_DIGEST_A),
      inputDigest: REWARD_DIGEST_B,
      evaluatedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(later.snapshotId).not.toBe(first.snapshotId);
    expect(later.published).toBe(true);
    // The first snapshot still answers exactly as it did.
    expect(await rewardEstimatePage(db, first.snapshotId, { afterRowSeq: -1, limit: 100 })).toEqual(
      firstRows,
    );
    expect((await rewardPointer(db))?.evaluated_at).toBe("2026-09-12T00:00:00.000Z");
  });
});

describe("the replayed simulations (G2-20)", () => {
  test("a request-retaining row is reproduced and a digest-only row is not", async () => {
    const { db, instanceId } = await claimed();
    const { snapshotId } = await build(db, instanceId);
    const rows = await rewardSimulationPage(db, snapshotId, { afterRowSeq: -1, limit: 100 });
    const byState = new Map(rows.map((row) => [row.reproducibility, row]));
    const reproduced = byState.get("reproduced");
    const refused = byState.get("not_reproducible");
    expect(reproduced?.result_json).not.toBeNull();
    expect(reproduced?.offer_id).toBe("offer:synthetic");
    expect(refused?.result_json).toBeNull();
    expect(refused?.reason_code).toBe("simulation_input_not_retained");
    // A digest-only row never carries a request either: nothing was retained
    // to replay, and nothing was invented to stand in for it.
    expect(refused?.request_json).toBeNull();
  });

  test("a replay cannot name an offer the snapshot did not fix", async () => {
    const { db, sqlite, instanceId } = await claimed();
    const snapshotPlan = await plan();
    const started = await beginRewardSnapshot(db, instanceId, snapshotPlan, NOW);
    expect(() =>
      sqlite
        .query(
          `INSERT INTO reward_conversion_simulations(snapshot_id,request_digest,row_seq,
            reproducibility,reason_code,request_json,offer_id,offer_version,result_json,
            search_coverage,evaluated_at,policy_release,row_digest)
           VALUES(?1,?2,0,'reproduced',NULL,'{}','offer:absent','v1','{}','bounded',?3,
             'reward-projection-v1',?4)`,
        )
        .run(started!.snapshotId, "a".repeat(64), EVALUATED_AT, "b".repeat(64)),
    ).toThrow(/offer in the snapshot input refs/u);
  });
});

describe("the reward build", () => {
  test("an estimate cannot name a rule the snapshot did not fix", async () => {
    const { db, sqlite, instanceId } = await claimed();
    const started = await beginRewardSnapshot(db, instanceId, await plan(), NOW);
    expect(() =>
      sqlite
        .query(
          `INSERT INTO reward_expiry_estimates(snapshot_id,row_key,row_seq,program_id,holding_ref,
            bucket_ref,rule_id,rule_version,bucket_kind,state,deadline_basis,expires_on,
            amount_coefficient,amount_scale,amount_status,unit_ref,provider_observed_json,
            policy_estimated_json,reason_codes_json,uncertainty_codes_json,basis_refs_json,
            row_digest)
           VALUES(?1,'k',0,'program:x','holding:x','bucket:x','rule:absent','v9','regular',
             'computed','policy-estimated','2026-12-31',NULL,NULL,'missing','points:x',
             NULL,NULL,'[]','[]','[]',?2)`,
        )
        .run(started!.snapshotId, "a".repeat(64)),
    ).toThrow(/rule in the snapshot input refs/u);
  });

  test("a second start of the same content is refused while one is under way", async () => {
    const { db, instanceId } = await claimed();
    const snapshotPlan = await plan();
    expect(await beginRewardSnapshot(db, instanceId, snapshotPlan, NOW)).not.toBeNull();
    expect(await beginRewardSnapshot(db, instanceId, snapshotPlan, NOW)).toBeNull();
  });

  test("a re-sent chunk is a no-op, and different content for a written row is a conflict", async () => {
    const { db, instanceId } = await claimed();
    const snapshotPlan = await plan();
    const started = await beginRewardSnapshot(db, instanceId, snapshotPlan, NOW);
    const projection = buildRewardProjection(rewardInput({ evaluatedAt: EVALUATED_AT }).content);
    const rows = await digested(projection);
    const lease = "lease-chunk";
    await claimRewardWriterLease(db, started!.snapshotId, lease, 1_000, 60_000);
    const fence = (await rewardWriterFence(db, started!.snapshotId, lease)) as number;
    const context = { lease, fence, now: NOW, rowsWritten: 0 };
    expect(await writeRewardEstimateChunk(db, started!.snapshotId, rows.estimates, context)).toBe(
      "written",
    );
    expect(await writeRewardEstimateChunk(db, started!.snapshotId, rows.estimates, context)).toBe(
      "written",
    );
    expect(await rewardCheckpoint(db, started!.snapshotId, "estimates")).toBe(
      rows.estimates.length - 1,
    );
    const first = rows.estimates[0]!;
    await expect(
      writeRewardEstimateChunk(
        db,
        started!.snapshotId,
        [{ row: { ...first.row, expiresOn: "2099-01-01" }, digest: "9".repeat(64) }],
        context,
      ),
    ).rejects.toThrow(/reward estimate chunk conflict/u);
  });

  test("a displaced writer writes nothing, seals nothing and publishes nothing", async () => {
    const { db, instanceId } = await claimed();
    const snapshotPlan = await plan();
    const started = await beginRewardSnapshot(db, instanceId, snapshotPlan, NOW);
    const projection = buildRewardProjection(rewardInput({ evaluatedAt: EVALUATED_AT }).content);
    const rows = await digested(projection);
    await claimRewardWriterLease(db, started!.snapshotId, "lease-old", 1_000, 60_000);
    const staleFence = (await rewardWriterFence(db, started!.snapshotId, "lease-old")) as number;
    // The lease is taken over by the next invocation.
    await claimRewardWriterLease(db, started!.snapshotId, "lease-new", 100_000, 60_000);
    expect(await rewardWriterFence(db, started!.snapshotId, "lease-old")).toBeNull();
    expect(
      await writeRewardEstimateChunk(db, started!.snapshotId, rows.estimates, {
        lease: "lease-old",
        fence: staleFence,
        now: NOW,
        rowsWritten: 0,
      }),
    ).toBe("lease_lost");
    const sealed = await sealAndPublishRewardSnapshot(
      db,
      {
        snapshotId: started!.snapshotId,
        readInstanceId: instanceId,
        sourceRevision: 10,
        visibilityRevision: 3,
        coreEpoch: "core-epoch-1",
        evaluatedAt: EVALUATED_AT,
      },
      { estimateCount: 0, simulationCount: 0, rowDigests: [] },
      { lease: "lease-old", now: NOW },
    );
    expect(sealed).toMatchObject({ sealed: false, published: false });
    expect(await rewardPointer(db)).toBeNull();
  });

  test("a build that cannot prove what it wrote does not seal", async () => {
    const { db, instanceId } = await claimed();
    const started = await beginRewardSnapshot(db, instanceId, await plan(), NOW);
    expect(
      await writtenRewardRowsMatch(db, started!.snapshotId, {
        estimates: ["a".repeat(64)],
        simulations: [],
      }),
    ).toBe(false);
  });

  test("an abandoned build leaves nothing behind and its content can start again", async () => {
    const { db, instanceId } = await claimed();
    const snapshotPlan = await plan();
    const started = await beginRewardSnapshot(db, instanceId, snapshotPlan, NOW);
    await abandonRewardSnapshot(db, started!.snapshotId);
    expect(await rewardSnapshotForContent(db, snapshotPlan.contentKey)).toBeNull();
    const again = await beginRewardSnapshot(db, instanceId, snapshotPlan, NOW);
    expect(again?.attempt).toBe(2);
    expect(again?.snapshotId).not.toBe(started?.snapshotId);
  });
});

describe("publication", () => {
  test("the pointer publishes only a complete local snapshot and never moves backwards", async () => {
    const { db, instanceId } = await claimed();
    const current = await build(db, instanceId, { sourceRevision: 20 });
    expect(current.published).toBe(true);
    expect((await activeRewardSnapshot(db))?.snapshot_id).toBe(current.snapshotId);

    // A build of an older CORE context finishes late: complete, not published.
    const late = await build(
      db,
      instanceId,
      {
        contentKey: await readContentKey(REWARD_DIGEST_B, REWARD_DIGEST_B),
        inputDigest: REWARD_DIGEST_B,
        buildDigest: REWARD_DIGEST_B,
        sourceRevision: 5,
      },
      "lease-late",
    );
    expect(late.published).toBe(false);
    expect((await rewardPointer(db))?.snapshot_id).toBe(current.snapshotId);
  });

  test("a watermark refresh never regresses the pointer and never names an unfinished build", async () => {
    // The lane's `unchanged` path re-runs the pointer statement without a
    // sealing lease, to carry the revision a capture verified the published
    // content under. That statement is bounded exactly like the seal's switch:
    // it moves nothing backwards and publishes nothing that is not complete.
    const { db, instanceId } = await claimed();
    const current = await build(db, instanceId, { sourceRevision: 20, visibilityRevision: 3 });
    expect(current.published).toBe(true);
    const outputDigest = (await activeRewardSnapshot(db))!.output_digest as string;
    const refresh = (overrides: {
      snapshotId?: string;
      sourceRevision: number;
      visibilityRevision?: number;
      evaluatedAt?: string;
      coreEpoch?: string;
    }) =>
      rewardPointerStatement(
        db,
        {
          snapshotId: overrides.snapshotId ?? current.snapshotId,
          readInstanceId: instanceId,
          sourceRevision: overrides.sourceRevision,
          visibilityRevision: overrides.visibilityRevision ?? 3,
          coreEpoch: overrides.coreEpoch ?? "core-epoch-1",
          evaluatedAt: overrides.evaluatedAt ?? EVALUATED_AT,
          outputDigest,
        },
        "2026-09-11T01:00:00.000Z",
      ).run();
    const pointerNow = async () => (await rewardPointer(db))!;

    // An older revision under the same epoch: refused, nothing changes.
    expect((await refresh({ sourceRevision: 19 })).meta.changes).toBe(0);
    expect(await pointerNow()).toMatchObject({ source_revision: 20, visibility_revision: 3 });
    // The same revision but an older evaluation instant: refused as well.
    expect(
      (await refresh({ sourceRevision: 20, evaluatedAt: "2026-09-10T00:00:00.000Z" })).meta.changes,
    ).toBe(0);
    expect(await pointerNow()).toMatchObject({ evaluated_at: EVALUATED_AT });
    // A build that is not complete is never named, whatever revision it claims.
    const started = await beginRewardSnapshot(
      db,
      instanceId,
      await plan({
        contentKey: await readContentKey(REWARD_DIGEST_B, REWARD_DIGEST_A),
        inputDigest: REWARD_DIGEST_B,
        sourceRevision: 25,
      }),
      NOW,
    );
    expect(
      (await refresh({ snapshotId: started!.snapshotId, sourceRevision: 25 })).meta.changes,
    ).toBe(0);
    expect((await pointerNow()).snapshot_id).toBe(current.snapshotId);
    // The verified watermark moves forward on the same published content: the
    // snapshot stays, the revisions it was verified under advance.
    expect((await refresh({ sourceRevision: 21, visibilityRevision: 4 })).meta.changes).toBe(1);
    expect(await pointerNow()).toMatchObject({
      snapshot_id: current.snapshotId,
      source_revision: 21,
      visibility_revision: 4,
      evaluated_at: EVALUATED_AT,
      output_digest: outputDigest,
    });
  });

  test("retiring an older build deletes its rows and keeps the published one", async () => {
    const { db, instanceId } = await claimed();
    const first = await build(db, instanceId, { sourceRevision: 10 });
    const second = await build(db, instanceId, {
      contentKey: await readContentKey(REWARD_DIGEST_B, REWARD_DIGEST_A),
      inputDigest: REWARD_DIGEST_B,
      sourceRevision: 11,
      evaluatedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(await retireOldRewardSnapshots(db, second.snapshotId, 1)).toBe(1);
    expect(await rewardEstimatePage(db, first.snapshotId, { afterRowSeq: -1, limit: 10 })).toEqual(
      [],
    );
    expect(
      (await rewardEstimatePage(db, second.snapshotId, { afterRowSeq: -1, limit: 10 })).length,
    ).toBeGreaterThan(0);
    expect((await activeRewardSnapshot(db))?.snapshot_id).toBe(second.snapshotId);
  });

  test("a page walks the contract order and filters by programme", async () => {
    const { db, instanceId } = await claimed();
    const { snapshotId } = await build(db, instanceId);
    const all = await rewardEstimatePage(db, snapshotId, { afterRowSeq: -1, limit: 100 });
    expect(all.map((row) => row.row_seq)).toEqual(all.map((_, index) => index));
    const first = await rewardEstimatePage(db, snapshotId, { afterRowSeq: -1, limit: 1 });
    expect(first).toEqual(all.slice(0, 1));
    const rest = await rewardEstimatePage(db, snapshotId, {
      afterRowSeq: first[0]!.row_seq,
      limit: 100,
    });
    expect(rest).toEqual(all.slice(1));
    expect(
      await rewardEstimatePage(db, snapshotId, {
        programId: "program:absent",
        afterRowSeq: -1,
        limit: 100,
      }),
    ).toEqual([]);
  });
});
