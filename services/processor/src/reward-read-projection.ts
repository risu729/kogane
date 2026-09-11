// The reward second stage: expiry estimates and replayed simulations built
// into the READ database from a fixed evaluation input (unified plan 04 §2,
// 05 §3–§6; U16), behind `REWARD_READ_PROJECTION_ENABLED`.
//
// Chapter 04 §2 admits `expiry_estimates` and `conversion_simulations` into
// READ on one condition: the evaluation time, the original request and the
// rule have to be fixed. This lane is that condition, made operational.
//
//   1. capture, with the optimistic protocol of 05 §3 (revision r0, read,
//      revision r1, keep it only when they agree) over the reward tables —
//      which migration 0041 put into the revision ledger, so the protocol can
//      actually see a rule or claim change;
//   2. `evaluatedAt` and the evaluation calendar go *inside* the captured
//      content, so they are hashed into the input digest. A later evaluation
//      is a different input, a different snapshot and never an update of the
//      published one (G2-19);
//   3. the canonical bytes go to the same DATA bucket under
//      `projection-inputs/<digest>/` and are pinned by the same CORE record as
//      the balance build, so an invocation that resumes reads the input it
//      fixed rather than CORE's present;
//   4. rows are written in chunks, each with its checkpoint in the same batch,
//      under a writer lease and fence;
//   5. the seal and the pointer switch are one batch. Only after READ has
//      published does the lane report `complete`.
//
// A saved simulation is replayed only when the stored row retained its
// request. One that kept nothing but a digest is written as
// `not_reproducible`; nothing here recomputes it against today's offers and
// calls it the same simulation (G2-20).
//
// The CORE tables of migration 0033 are read, never written: the reference
// claims, the provider claims and CORE's own `expiry_estimates` /
// `conversion_simulations` keep working exactly as they do with the flag off.
import {
  abandonRewardSnapshot,
  activeRewardSnapshot,
  beginRewardSnapshot,
  claimRewardWriterLease,
  ensureReadInstance,
  inputRefDigest,
  oldestBuildingRewardSnapshot,
  READ_CONTRACT_VERSION,
  releaseRewardWriterLease,
  retireOldRewardSnapshots,
  rewardCheckpoint,
  rewardEstimateDigest,
  rewardPointer,
  rewardPointerStatement,
  rewardSimulationDigest,
  rewardSnapshotForContent,
  readContentKey,
  rewardWriterFence,
  sealAndPublishRewardSnapshot,
  writeRewardEstimateChunk,
  writeRewardSimulationChunk,
  writtenRewardRowsMatch,
  type D1Like,
  type RewardInputRef,
  type RewardSnapshotRow,
} from "../../../packages/storage-d1/src/read/index.ts";
import {
  buildRewardProjection,
  CONVERSION_OFFERS_SQL,
  CURRENT_REWARD_BUCKETS_SQL,
  d1Executor,
  EXPIRY_RULES_SQL,
  MEMBERSHIP_SQL,
  REWARD_EVALUATION_CALENDAR,
  REWARD_PAGE_LIMIT,
  REWARD_PROJECTION_CONTRACT_VERSION,
  REWARD_PROJECTION_PROMOTION_RELEASE,
  REWARD_PROJECTION_RELEASE,
  rewardProjectionBuildDigest,
  ruleSetDigest,
  type ConversionOfferSqlRow,
  type ExpiryRuleSqlRow,
  type MembershipSqlRow,
  type RewardBucketSqlRow,
  type RewardExpiryProjectionRow,
  type RewardProjectionInputContent,
  type RewardSimulationProjectionRow,
  type SavedSimulationSqlRow,
} from "../../../packages/read-model/src/index";
import { canonicalJson, sha256Hex } from "../../../packages/domain/src/context.ts";
import {
  captureDigest,
  insertInputRecord,
  loadProjectionInput,
  readInputRecord,
  restoreProjectionInput,
  storeProjectionInput,
  type CapturedProjectionInput,
  type FixedProjectionInput,
  type ProjectionInputStore,
} from "./projection-input.ts";
import { currentCoreRevision } from "./balance-projection-job.ts";

/** Rows written per invocation; one cron tick stays bounded whatever the size. */
export const REWARD_WRITE_BUDGET = 500;
const WRITE_CHUNK = 100;
/** How long one invocation holds a build; shorter than the cron period. */
const WRITER_LEASE_MS = 60_000;
/** Optimistic captures before the lane yields and waits for a quiet tick. */
const CAPTURE_ATTEMPTS = 3;
/**
 * Bounds of one capture. Every one of them is fail-closed: a set larger than
 * its bound is refused, never cut down to size and sealed as if it were
 * complete (05 §3).
 */
const RULE_BOUND = 200;
const OFFER_BOUND = 200;
const SIMULATION_BOUND = 200;

/**
 * The instant one capture evaluates against: the start of the captured day in
 * the evaluation calendar (`REWARD_EVALUATION_CALENDAR`, UTC).
 *
 * The rules consume a calendar day, not a time of day, so this is exactly what
 * the deadlines are computed against — and pinning it to the day is what keeps
 * two ticks of the same day one input. Were the raw instant used, every cron
 * tick would digest to new content and rebuild rows identical to the published
 * ones, five minutes apart, for ever.
 */
export function evaluationInstant(now: string): string {
  return `${now.slice(0, 10)}T00:00:00.000Z`;
}

/** The reward claim window a capture reads; the reader's release. */
const PROMOTION_RELEASE = REWARD_PROJECTION_PROMOTION_RELEASE;

const SAVED_SIMULATIONS_SQL = `SELECT input_digest, plan_json, search_coverage, policy_release,
    computed_at FROM conversion_simulations ORDER BY input_digest LIMIT ?1`;
const CLAIMS_HIGH_WATER_SQL = `SELECT coalesce(max(id),0) AS high_water
  FROM reward_bucket_claims WHERE promotion_release=?1`;

/**
 * The target flag. Off by default and off everywhere until a deployment turns
 * it on: with it off the lane does not run at all, nothing is written to READ,
 * and the reward routes keep answering from CORE exactly as before.
 */
export function rewardReadProjectionEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** The READ binding, when the deployment has one. */
export function rewardReadDatabase(env: Env): D1Like | null {
  return (env as unknown as { READ?: D1Like }).READ ?? null;
}

export interface RewardReadProjectionResult {
  enabled: boolean;
  snapshotId: string | null;
  /**
   * `refused` is a fail-closed bound refusal, `retryable` a transient failure
   * (a lost fence, an unreadable stored input) and `pending` a context that
   * would not hold still long enough to be captured. None is a finished build.
   */
  status: "skipped" | "unchanged" | "building" | "complete" | "refused" | "retryable" | "pending";
  written: number;
  estimateCount: number;
  simulationCount: number;
  retired: number;
  reasonCode: string | null;
  sourceRevision: number | null;
  inputDigest: string | null;
  /** The instant this build's deadlines are computed against. */
  evaluatedAt: string | null;
  /** Whether the active pointer publishes this snapshot. */
  active: boolean;
}

const halted = (
  status: RewardReadProjectionResult["status"],
  reasonCode: string,
  snapshotId: string | null = null,
  written = 0,
): RewardReadProjectionResult => ({
  enabled: true,
  snapshotId,
  status,
  written,
  estimateCount: 0,
  simulationCount: 0,
  retired: 0,
  reasonCode,
  sourceRevision: null,
  inputDigest: null,
  evaluatedAt: null,
  active: false,
});

export interface RewardProjectionOptions {
  /** Injected clock; the value it returns is the fixed evaluation instant. */
  now?: () => string;
  /** Injected writer token, so a test can simulate a displaced writer. */
  writerToken?: string;
  /** Rows written in this invocation. */
  writeBudget?: number;
  /** Test seam: a writer that lands between the two revision reads. */
  duringCapture?: (attempt: number) => Promise<void>;
}

type RewardFixedInput = FixedProjectionInput<RewardProjectionInputContent>;
type RewardCapturedInput = CapturedProjectionInput<RewardProjectionInputContent>;

export type RewardCaptureOutcome =
  | { ok: true; captured: RewardCapturedInput }
  | { ok: false; status: "refused" | "pending"; code: string };

/**
 * Fix the input of one reward build (05 §3).
 *
 *     read revision r0
 *       -> read the rules, the current claims, the membership, the offers and
 *          the saved simulations
 *     read revision r1
 *     r0 == r1  -> this is the input
 *     r0 != r1  -> discard it and retry, bounded
 *
 * `evaluatedAt` is read once, before the data, and travels inside the content:
 * a resumed build cannot quietly evaluate the same rules at a later time, and
 * two captures a minute apart are two inputs rather than one input with a
 * moving clock.
 */
export async function captureRewardInput(
  db: D1Like,
  options: RewardProjectionOptions = {},
): Promise<RewardCaptureOutcome> {
  const clock = options.now ?? (() => new Date().toISOString());
  const sql = d1Executor(db);
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt += 1) {
    const before = await currentCoreRevision(db);
    const evaluatedAt = evaluationInstant(clock());
    const rules = await sql.all<ExpiryRuleSqlRow>(EXPIRY_RULES_SQL, [null]);
    if (rules.length > RULE_BOUND)
      return { ok: false, status: "refused", code: "rule_set_too_large" };
    const buckets = await sql.all<RewardBucketSqlRow>(CURRENT_REWARD_BUCKETS_SQL, [
      PROMOTION_RELEASE,
      null,
      0,
    ]);
    // The reader's page limit is a page, not a bound on the holding: a larger
    // set is refused rather than projected as if it were everything.
    if (buckets.length > REWARD_PAGE_LIMIT)
      return { ok: false, status: "refused", code: "claim_set_too_large" };
    const membership = await sql.all<MembershipSqlRow>(MEMBERSHIP_SQL, [null]);
    const offers = await sql.all<ConversionOfferSqlRow>(CONVERSION_OFFERS_SQL, [null, 0]);
    if (offers.length > OFFER_BOUND)
      return { ok: false, status: "refused", code: "offer_set_too_large" };
    const simulations = await sql.all<SavedSimulationSqlRow>(SAVED_SIMULATIONS_SQL, [
      SIMULATION_BOUND + 1,
    ]);
    if (simulations.length > SIMULATION_BOUND)
      return { ok: false, status: "refused", code: "simulation_set_too_large" };
    const highWater = await db
      .prepare(CLAIMS_HIGH_WATER_SQL)
      .bind(PROMOTION_RELEASE)
      .first<{ high_water: number }>();
    await options.duringCapture?.(attempt);
    const after = await currentCoreRevision(db);
    if (
      after.source_revision !== before.source_revision ||
      after.visibility_revision !== before.visibility_revision ||
      after.core_epoch !== before.core_epoch
    )
      continue;
    const content: RewardProjectionInputContent = {
      manifest: {
        evaluatedAt,
        evaluationCalendar: REWARD_EVALUATION_CALENDAR,
        promotionRelease: PROMOTION_RELEASE,
        policyRelease: REWARD_PROJECTION_RELEASE,
        claimsHighWater: highWater?.high_water ?? 0,
        ruleCount: rules.length,
        bucketCount: buckets.length,
        membershipCount: membership.length,
        offerCount: offers.length,
        simulationCount: simulations.length,
      },
      rules,
      buckets,
      membership,
      offers,
      simulations,
    };
    return {
      ok: true,
      captured: await captureDigest<RewardProjectionInputContent>({
        contractVersion: REWARD_PROJECTION_CONTRACT_VERSION,
        sourceRevision: before.source_revision,
        visibilityRevision: before.visibility_revision,
        coreEpoch: before.core_epoch,
        capturedAt: evaluatedAt,
        content,
      }),
    };
  }
  return { ok: false, status: "pending", code: "input_capture_unstable" };
}

/**
 * The CORE references this build was made from, copied into the snapshot so an
 * estimate can be checked against them without a cross-database join (04 §3).
 * The rules and offers are named one by one, because the triggers check them;
 * the claim set is pinned by one digest over the rows the capture read.
 */
export async function rewardInputRefs(
  input: RewardFixedInput,
  used: { ruleRefs: readonly string[]; offerRefs: readonly string[] },
): Promise<RewardInputRef[]> {
  const content = input.content;
  const refs: RewardInputRef[] = [];
  const ruleRows = new Map<string, ExpiryRuleSqlRow>(
    content.rules.map((rule) => [`${rule.rule_id}@${rule.version}`, rule]),
  );
  for (const ref of used.ruleRefs)
    refs.push({
      kind: "expiry_rule",
      id: ref,
      digest: await inputRefDigest("expiry_rule", ref, ruleRows.get(ref) ?? null),
    });
  const offerRows = new Map<string, ConversionOfferSqlRow>(
    content.offers.map((offer) => [`${offer.offer_id}@${offer.version}`, offer]),
  );
  for (const ref of used.offerRefs)
    refs.push({
      kind: "conversion_offer",
      id: ref,
      digest: await inputRefDigest("conversion_offer", ref, offerRows.get(ref) ?? null),
    });
  refs.push(
    {
      // The evaluation instant, as a reference of its own: it is the part of
      // this input nobody can re-derive from CORE later (05 §3).
      kind: "evaluation_clock",
      id: content.manifest.evaluatedAt,
      digest: await inputRefDigest("evaluation_clock", content.manifest.evaluatedAt, {
        evaluatedAt: content.manifest.evaluatedAt,
        calendar: content.manifest.evaluationCalendar,
      }),
    },
    {
      kind: "calendar_rule",
      id: content.manifest.evaluationCalendar,
      digest: await inputRefDigest(
        "calendar_rule",
        content.manifest.evaluationCalendar,
        content.rules.map((rule) => rule.deadline_calendar_ref),
      ),
    },
    {
      // The claim window: which promotion release, how far it had got, and the
      // exact rows the capture read.
      kind: "promotion_release",
      id: `${content.manifest.promotionRelease}@${String(content.manifest.claimsHighWater)}`,
      digest: await sha256Hex(canonicalJson(content.buckets)),
    },
    {
      kind: "membership_claim",
      id: `${content.manifest.promotionRelease}:membership`,
      digest: await sha256Hex(canonicalJson(content.membership)),
    },
    {
      // What a reader may see, as the build saw it: a later restriction moves
      // this number and the app refuses the snapshot rather than filtering it.
      kind: "restriction_revision",
      id: String(input.visibilityRevision),
      digest: await inputRefDigest("restriction_revision", String(input.visibilityRevision), {
        coreEpoch: input.coreEpoch,
        visibilityRevision: input.visibilityRevision,
      }),
    },
  );
  return refs;
}

interface RewardBuild {
  snapshotId: string;
  inputDigest: string;
  input: RewardFixedInput;
}

/**
 * One bounded step of the reward READ build. The statuses are the balance
 * lane's, so the scheduled log reads the same way for both projections.
 */
export async function runRewardReadProjection(
  env: Env,
  store: ProjectionInputStore,
  options: RewardProjectionOptions = {},
): Promise<RewardReadProjectionResult> {
  const read = rewardReadDatabase(env);
  if (!read) return halted("retryable", "read_binding_missing");
  const db = env.DB as unknown as D1Like;
  const now = (options.now ?? (() => new Date().toISOString()))();
  const lease = options.writerToken ?? crypto.randomUUID();
  const instance = await ensureReadInstance(read, now);
  // The database has the shape of another baseline (06 §2). Building into it
  // would publish rows a reader of this contract cannot read.
  if (instance.contract_version !== READ_CONTRACT_VERSION)
    return halted("refused", "read_contract_mismatch");

  // 1. An unfinished build continues from its own fixed input, never from CORE.
  const resumed = await resumeBuild(read, db, store);
  if (resumed !== null && "status" in resumed) return resumed;

  let build: RewardBuild;
  if (resumed !== null) build = resumed;
  else {
    const capture = await captureRewardInput(db, options);
    if (!capture.ok) return halted(capture.status, capture.code);
    const buildDigest = await rewardProjectionBuildDigest();
    const contentKey = await readContentKey(
      capture.captured.digest,
      buildDigest,
      REWARD_PROJECTION_CONTRACT_VERSION,
    );
    const existing = await rewardSnapshotForContent(read, contentKey);
    if (existing?.status === "complete")
      return await unchanged(read, instance.read_instance_id, existing, capture.captured, now);
    if (existing?.status === "building")
      return halted("retryable", "reward_build_in_progress", existing.snapshot_id);
    // The input exists before the build that references it: a crash the other
    // way round would leave a build whose input cannot be read.
    const record = await readInputRecord(db, capture.captured.digest);
    if (!record) await storeProjectionInput(store, capture.captured);
    else if (!(await loadProjectionInput<RewardProjectionInputContent>(store, record)))
      await restoreProjectionInput<RewardProjectionInputContent>(
        store,
        record,
        capture.captured.input.content,
        capture.captured.input.capturedAt,
      );
    const projection = buildRewardProjection(capture.captured.input.content);
    const started = await beginRewardSnapshot(
      read,
      instance.read_instance_id,
      {
        contentKey,
        inputDigest: capture.captured.digest,
        buildDigest,
        contractVersion: REWARD_PROJECTION_CONTRACT_VERSION,
        evaluatedAt: capture.captured.input.content.manifest.evaluatedAt,
        calendarRuleId: capture.captured.input.content.manifest.evaluationCalendar,
        ruleSetDigest: await ruleSetDigest(projection.ruleRefs),
        ruleCount: projection.ruleRefs.length,
        claimsRelease: capture.captured.input.content.manifest.promotionRelease,
        claimsHighWater: capture.captured.input.content.manifest.claimsHighWater,
        sourceRevision: capture.captured.input.sourceRevision,
        visibilityRevision: capture.captured.input.visibilityRevision,
        coreEpoch: capture.captured.input.coreEpoch,
        inputManifestJson: JSON.stringify(capture.captured.input.content.manifest),
        policyRelease: REWARD_PROJECTION_RELEASE,
        inputRefs: await rewardInputRefs(capture.captured.input, projection),
      },
      now,
    );
    // Another invocation started this content between the lookup and the
    // insert; the loser continues that build on its next tick.
    if (!started) return halted("retryable", "reward_build_in_progress");
    if (!record) await insertInputRecord(db, capture.captured, started.snapshotId, now).run();
    build = {
      snapshotId: started.snapshotId,
      inputDigest: capture.captured.digest,
      input: capture.captured.input,
    };
  }

  // 2. Take the lease and raise the fence.
  const nowMs = Date.now();
  if (!(await claimRewardWriterLease(read, build.snapshotId, lease, nowMs, WRITER_LEASE_MS)))
    return halted("retryable", "writer_lease_unavailable", build.snapshotId);
  try {
    return await rewardBuildStep(read, instance.read_instance_id, build, {
      budget: options.writeBudget ?? REWARD_WRITE_BUDGET,
      lease,
      now,
    });
  } finally {
    await releaseRewardWriterLease(read, build.snapshotId, lease);
  }
}

/** The oldest unfinished build, resumed from the input it fixed (G2-05). */
async function resumeBuild(
  read: D1Like,
  db: D1Like,
  store: ProjectionInputStore,
): Promise<RewardBuild | RewardReadProjectionResult | null> {
  const unfinished = await oldestBuildingRewardSnapshot(read);
  if (!unfinished) return null;
  const record = await readInputRecord(db, unfinished.input_digest);
  if (!record) {
    // Its input is not on record: it can only be rebuilt from a fresh capture,
    // so this attempt is abandoned and the next tick starts one.
    await abandonRewardSnapshot(read, unfinished.snapshot_id);
    return halted("retryable", "projection_input_missing", unfinished.snapshot_id);
  }
  const input = await loadProjectionInput<RewardProjectionInputContent>(store, record);
  if (!input) return halted("retryable", "projection_input_unreadable", unfinished.snapshot_id);
  return {
    snapshotId: unfinished.snapshot_id,
    inputDigest: unfinished.input_digest,
    input,
  };
}

/**
 * The content is unchanged and already published: nothing is rebuilt. What can
 * still move is how current that snapshot is, so the pointer's watermark is
 * refreshed under the revision and the visibility revision this capture saw
 * (05 §5).
 *
 * This is not a detail. The digest covers the captured content, not the
 * counters, so a restriction that changes no claim leaves the content
 * identical — and without this refresh the pointer would keep its old
 * visibility revision, the App would keep refusing the snapshot, and no
 * rebuild would ever clear it.
 */
async function unchanged(
  read: D1Like,
  readInstanceId: string,
  existing: RewardSnapshotRow,
  captured: RewardCapturedInput,
  now: string,
): Promise<RewardReadProjectionResult> {
  const published = await activeRewardSnapshot(read);
  if (published !== null || existing.output_digest !== null)
    await rewardPointerStatement(
      read,
      {
        snapshotId: existing.snapshot_id,
        readInstanceId,
        sourceRevision: captured.input.sourceRevision,
        visibilityRevision: captured.input.visibilityRevision,
        coreEpoch: captured.input.coreEpoch,
        evaluatedAt: existing.evaluated_at,
        outputDigest: existing.output_digest ?? "",
      },
      now,
    ).run();
  const pointer = await rewardPointer(read);
  return {
    enabled: true,
    snapshotId: existing.snapshot_id,
    status: "unchanged",
    written: 0,
    estimateCount: existing.estimate_count,
    simulationCount: existing.simulation_count,
    retired: 0,
    reasonCode: null,
    sourceRevision: captured.input.sourceRevision,
    inputDigest: captured.digest,
    evaluatedAt: existing.evaluated_at,
    active: pointer?.snapshot_id === existing.snapshot_id,
  };
}

async function rewardBuildStep(
  read: D1Like,
  readInstanceId: string,
  build: RewardBuild,
  { budget, lease, now }: { budget: number; lease: string; now: string },
): Promise<RewardReadProjectionResult> {
  const projection = buildRewardProjection(build.input.content);
  const estimates: { row: RewardExpiryProjectionRow; digest: string }[] = [];
  for (const row of projection.estimates)
    estimates.push({ row, digest: await rewardEstimateDigest(row) });
  const simulations: { row: RewardSimulationProjectionRow; digest: string }[] = [];
  for (const row of projection.simulations)
    simulations.push({ row, digest: await rewardSimulationDigest(row) });
  const fence = await rewardWriterFence(read, build.snapshotId, lease);
  if (fence === null) return halted("retryable", "writer_lease_lost", build.snapshotId);

  const evaluatedAt = build.input.content.manifest.evaluatedAt;
  const building = (written: number): RewardReadProjectionResult => ({
    enabled: true,
    snapshotId: build.snapshotId,
    status: "building",
    written,
    estimateCount: estimates.length,
    simulationCount: simulations.length,
    retired: 0,
    reasonCode: null,
    sourceRevision: build.input.sourceRevision,
    inputDigest: build.inputDigest,
    evaluatedAt,
    active: false,
  });

  let written = 0;
  // Estimates first, then the replays: one budget across both stages, each
  // with its own checkpoint, so a bounded invocation stops anywhere.
  const estimateFrom = await rewardCheckpoint(read, build.snapshotId, "estimates");
  const pendingEstimates = estimates.filter((entry) => entry.row.rowSeq > estimateFrom);
  const estimateSlice = pendingEstimates.slice(0, budget);
  for (let start = 0; start < estimateSlice.length; start += WRITE_CHUNK) {
    const chunk = estimateSlice.slice(start, start + WRITE_CHUNK);
    const outcome = await writeRewardEstimateChunk(read, build.snapshotId, chunk, {
      lease,
      fence,
      now,
      rowsWritten: estimateFrom + 1 + written,
    });
    if (outcome === "lease_lost")
      return halted("retryable", "writer_lease_lost", build.snapshotId, written);
    written += chunk.length;
  }
  if (estimateSlice.length < pendingEstimates.length) return building(written);

  const simulationFrom = await rewardCheckpoint(read, build.snapshotId, "simulations");
  const pendingSimulations = simulations.filter((entry) => entry.row.rowSeq > simulationFrom);
  const simulationSlice = pendingSimulations.slice(0, Math.max(budget - written, 0));
  let simulationsWritten = 0;
  for (let start = 0; start < simulationSlice.length; start += WRITE_CHUNK) {
    const chunk = simulationSlice.slice(start, start + WRITE_CHUNK);
    const outcome = await writeRewardSimulationChunk(read, build.snapshotId, chunk, {
      lease,
      fence,
      now,
      rowsWritten: simulationFrom + 1 + simulationsWritten,
    });
    if (outcome === "lease_lost")
      return halted("retryable", "writer_lease_lost", build.snapshotId, written);
    simulationsWritten += chunk.length;
    written += chunk.length;
  }
  if (simulationSlice.length < pendingSimulations.length) return building(written);

  // 3. Verify what was written, then seal and switch the pointer in one batch.
  if (
    !(await writtenRewardRowsMatch(read, build.snapshotId, {
      estimates: estimates.map((entry) => entry.digest),
      simulations: simulations.map((entry) => entry.digest),
    }))
  )
    return halted("retryable", "reward_rows_unverified", build.snapshotId, written);
  const sealed = await sealAndPublishRewardSnapshot(
    read,
    {
      snapshotId: build.snapshotId,
      readInstanceId,
      sourceRevision: build.input.sourceRevision,
      visibilityRevision: build.input.visibilityRevision,
      coreEpoch: build.input.coreEpoch,
      evaluatedAt,
    },
    {
      estimateCount: estimates.length,
      simulationCount: simulations.length,
      rowDigests: [
        ...estimates.map((entry) => entry.digest),
        ...simulations.map((entry) => entry.digest),
      ],
    },
    { lease, now },
  );
  if (!sealed.sealed) return halted("retryable", "writer_lease_lost", build.snapshotId, written);
  const retired = await retireOldRewardSnapshots(read, build.snapshotId);
  return {
    enabled: true,
    snapshotId: build.snapshotId,
    status: "complete",
    written,
    estimateCount: estimates.length,
    simulationCount: simulations.length,
    retired,
    reasonCode: null,
    sourceRevision: build.input.sourceRevision,
    inputDigest: build.inputDigest,
    evaluatedAt,
    active: sealed.published,
  };
}

/** The DATA bucket the fixed inputs are written through; EVIDENCE is the same
 * physical bucket in production and the fallback for a deployment without the
 * second binding. */
function rewardInputBucket(env: Env): ProjectionInputStore {
  const bound = (env as unknown as { DATA?: ProjectionInputStore }).DATA;
  return bound ?? (env.EVIDENCE as unknown as ProjectionInputStore);
}

/** The scheduled lane. `runScheduled` skips it entirely while the flag is off. */
export async function rewardReadProjectionStage(env: Env): Promise<object> {
  return await runRewardReadProjection(env, rewardInputBucket(env));
}
