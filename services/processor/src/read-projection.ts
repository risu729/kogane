// The balance projection written into the READ database (unified plan 04, 05;
// U11). READ is the only projection target.
//
// Nothing about the *input* changes: the same capture protocol of 05 §3 runs
// against CORE, the canonical bytes go to the same DATA bucket, the same
// `projection_input_records` row pins them, and the content digest is the same
// digest. What changes is where the rows land — a second physical D1 that can
// be dropped and rebuilt without touching CORE or DATA.
//
// Two databases mean no shared transaction (04 §1), so the order is fixed:
// READ is finished first, CORE is completed afterwards, and a lost response
// converges on the next tick by re-reading the published snapshot rather than
// by rebuilding (05 §5, G2-11, G2-12).
//
// The write budget, the chunk size, the lease and the four outcomes are the
// CORE job's; only the target is different, so a deployment can be switched
// back by turning the flag off.
import {
  abandonSnapshot,
  activePointer,
  activePointerStatement,
  beginSnapshot,
  claimWriterLease,
  ensureReadInstance,
  inputRefDigest,
  oldestBuildingSnapshot,
  publishedSnapshotAt,
  readContentKey,
  READ_CONTRACT_VERSION,
  releaseWriterLease,
  retireOldSnapshots,
  rowCheckpoint,
  rowDigest,
  sealAndPublish,
  snapshotForContent,
  writeRowChunk,
  writeScopeRelations,
  writerFence,
  writtenRowsMatch,
  type D1Like,
  type SnapshotInputRef,
} from "../../../packages/storage-d1/src/read/index.ts";
import {
  BALANCE_PROJECTION_RELEASE,
  buildBalanceProjection,
  scopeRelationsFromEntityRelations,
  type ProjectionRow,
} from "../../../packages/read-model/src/index";
import {
  insertInputRecord,
  loadProjectionInput,
  readInputRecord,
  restoreProjectionInput,
  storeProjectionInput,
  type FixedProjectionInput,
  type ProjectionInputStore,
} from "./projection-input.ts";
import type {
  BalanceProjectionOptions,
  BalanceProjectionResult,
  CaptureOutcome,
} from "./balance-projection-job.ts";

/** Rows written per invocation and per batch; the CORE job's numbers. */
const WRITE_CHUNK = 100;
/** How long one invocation holds a build, shorter than the cron period. */
const WRITER_LEASE_MS = 60_000;

/**
 * The READ binding, when the deployment has one. A configuration that turned
 * the flag on without binding a database is a configuration error, and the job
 * says so instead of writing the CORE tables under a flag that claims READ.
 */
export function readDatabase(env: Env): D1Like | null {
  const bound = (env as unknown as { READ?: D1Like }).READ;
  return bound ?? null;
}

/** What the READ build needs from the CORE job, injected so the two modules
 * do not import each other. */
export interface ReadProjectionDeps {
  capture: (db: D1Database, options: BalanceProjectionOptions) => Promise<CaptureOutcome>;
  buildDigest: () => Promise<string>;
}

const halted = (
  status: BalanceProjectionResult["status"],
  reasonCode: string,
  snapshotId: string | null = null,
  written = 0,
): BalanceProjectionResult => ({
  enabled: true,
  snapshotId,
  status,
  written,
  rowCount: 0,
  retired: 0,
  reasonCode,
  sourceRevision: null,
  inputDigest: null,
  active: false,
});

/**
 * The CORE references this build was made from, copied into the snapshot so a
 * relation can be checked against them without a cross-database join (04 §3).
 * Decisions are the ones the fixed input carried; the releases and the
 * restriction revision come from the same input, never from CORE's present.
 */
export async function snapshotInputRefs(input: FixedProjectionInput): Promise<SnapshotInputRef[]> {
  const refs: SnapshotInputRef[] = [];
  const decisions = new Map<string, string>();
  for (const relation of input.content.relations) {
    if (relation.decision_revision_id === null) continue;
    decisions.set(relation.decision_revision_id, relation.status);
  }
  for (const [id, status] of [...decisions].sort(([left], [right]) => (left < right ? -1 : 1)))
    refs.push({
      kind: "decision_revision",
      id,
      digest: await inputRefDigest("decision_revision", id, status),
    });
  const manifest = input.content.manifest;
  refs.push(
    {
      kind: "identity_release",
      id: manifest.identityRelease,
      digest: await inputRefDigest("identity_release", manifest.identityRelease, manifest),
    },
    {
      kind: "decimal_policy_release",
      id: manifest.decimalPolicyRelease,
      digest: await inputRefDigest(
        "decimal_policy_release",
        manifest.decimalPolicyRelease,
        manifest,
      ),
    },
    {
      kind: "published_high_water",
      id: String(manifest.publishedHighWaterParseRunId),
      digest: await inputRefDigest(
        "published_high_water",
        String(manifest.publishedHighWaterParseRunId),
        manifest,
      ),
    },
    {
      // What a reader may see, as the build saw it. A later restriction moves
      // this number, which is how the App refuses the snapshot for restricted
      // scopes instead of filtering rows out of a subtotal (05 §7, G3-04).
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

interface ReadBuild {
  snapshotId: string;
  contentKey: string;
  inputDigest: string;
  input: FixedProjectionInput;
}

/**
 * One bounded step of the READ build. The statuses are the CORE job's, so the
 * outbox processor and the lane log read the same way whichever target is on.
 */
export async function runReadProjection(
  env: Env,
  deps: ReadProjectionDeps,
  options: BalanceProjectionOptions,
  store: ProjectionInputStore,
  writeBudget: number,
): Promise<BalanceProjectionResult> {
  const read = readDatabase(env);
  if (!read) return halted("retryable", "read_binding_missing");
  const db = env.DB;
  const now = (options.now ?? (() => new Date().toISOString()))();
  const lease = options.writerToken ?? crypto.randomUUID();
  const instance = await ensureReadInstance(read, now);
  // The database has the shape of another baseline (06 §2: a destructive READ
  // change is a new empty database, never a migration of this one). Building
  // into it would publish rows a reader of this contract cannot read.
  if (instance.contract_version !== READ_CONTRACT_VERSION)
    return halted("refused", "read_contract_mismatch");

  // 1. An unfinished build continues from its own fixed input, never from CORE.
  const building = await (async (): Promise<ReadBuild | BalanceProjectionResult | null> => {
    const unfinished = await oldestBuildingSnapshot(read);
    if (!unfinished) return null;
    const record = await readInputRecord(db, unfinished.input_digest);
    if (!record) {
      // Its input is not on record: it can only be rebuilt from a fresh
      // capture, so this attempt is abandoned and the next tick starts one.
      await abandonSnapshot(read, unfinished.snapshot_id);
      return halted("retryable", "projection_input_missing", unfinished.snapshot_id);
    }
    const input = await loadProjectionInput(store, record);
    if (!input) return halted("retryable", "projection_input_unreadable", unfinished.snapshot_id);
    return {
      snapshotId: unfinished.snapshot_id,
      contentKey: unfinished.content_key,
      inputDigest: unfinished.input_digest,
      input,
    };
  })();
  if (building !== null && "status" in building) return building;

  let build: ReadBuild;
  if (building !== null) build = building;
  else {
    const capture = await deps.capture(db, options);
    if (!capture.ok) return halted(capture.status, capture.code);
    const contentKey = await readContentKey(capture.captured.digest, await deps.buildDigest());
    const existing = await snapshotForContent(read, contentKey);
    if (existing?.status === "complete") {
      // The content is unchanged, so this is the same snapshot; what moved is
      // how current it is. The pointer carries that watermark, so a decision
      // that changed no row still reaches "the published snapshot covers your
      // revision" without a rebuild that has nothing to build (05 §5).
      const refreshed = await activePointerStatement(
        read,
        {
          snapshotId: existing.snapshot_id,
          readInstanceId: instance.read_instance_id,
          sourceRevision: capture.captured.input.sourceRevision,
          visibilityRevision: capture.captured.input.visibilityRevision,
          coreEpoch: capture.captured.input.coreEpoch,
          outputDigest: existing.output_digest ?? "",
        },
        now,
      ).run();
      const pointer = await activePointer(read);
      return {
        enabled: true,
        snapshotId: existing.snapshot_id,
        status: "unchanged",
        written: 0,
        rowCount: existing.row_count,
        retired: 0,
        reasonCode: null,
        sourceRevision: capture.captured.input.sourceRevision,
        inputDigest: capture.captured.digest,
        active: refreshed.meta.changes === 1 || pointer?.snapshot_id === existing.snapshot_id,
      };
    }
    if (existing?.status === "building")
      return halted("retryable", "projection_build_in_progress", existing.snapshot_id);
    // The input exists before the build that references it: a crash the other
    // way round would leave a build whose input cannot be read. The record is
    // per input and shared with any CORE build of the same input.
    const record = await readInputRecord(db, capture.captured.digest);
    if (!record) await storeProjectionInput(store, capture.captured);
    else if (!(await loadProjectionInput(store, record)))
      await restoreProjectionInput(store, record, capture.captured.input.content, now);
    const snapshotPlan = {
      contentKey,
      inputDigest: capture.captured.digest,
      buildDigest: await deps.buildDigest(),
      contractVersion: capture.captured.input.contractVersion,
      sourceRevision: capture.captured.input.sourceRevision,
      visibilityRevision: capture.captured.input.visibilityRevision,
      coreEpoch: capture.captured.input.coreEpoch,
      inputManifestJson: JSON.stringify(capture.captured.input.content.manifest),
      projectionRelease: BALANCE_PROJECTION_RELEASE,
      inputRefs: await snapshotInputRefs(capture.captured.input),
    };
    const started = await beginSnapshot(read, instance.read_instance_id, snapshotPlan, now);
    // Another invocation started this content between the lookup and the
    // insert; the loser continues that build on its next tick instead of
    // allocating a second row.
    if (!started) return halted("retryable", "projection_build_in_progress");
    if (!record) await insertInputRecord(db, capture.captured, started.snapshotId, now).run();
    build = {
      snapshotId: started.snapshotId,
      contentKey,
      inputDigest: capture.captured.digest,
      input: capture.captured.input,
    };
  }

  // 2. Take the lease and raise the fence.
  const nowMs = Date.now();
  if (!(await claimWriterLease(read, build.snapshotId, lease, nowMs, WRITER_LEASE_MS)))
    return halted("retryable", "writer_lease_unavailable", build.snapshotId);
  try {
    return await readBuildStep(read, instance.read_instance_id, build, {
      budget: writeBudget,
      lease,
      now,
    });
  } finally {
    await releaseWriterLease(read, build.snapshotId, lease);
  }
}

async function readBuildStep(
  read: D1Like,
  readInstanceId: string,
  build: ReadBuild,
  { budget, lease, now }: { budget: number; lease: string; now: string },
): Promise<BalanceProjectionResult> {
  const projection = buildBalanceProjection(
    build.input.content.candidates,
    scopeRelationsFromEntityRelations(build.input.content.relations),
  );
  const digests: string[] = [];
  for (const row of projection.rows) digests.push(await rowDigest(row));
  const fence = await writerFence(read, build.snapshotId, lease);
  if (fence === null) return halted("retryable", "writer_lease_lost", build.snapshotId);
  const resumeAt = await rowCheckpoint(read, build.snapshotId);
  const pending = projection.rows.filter((row) => row.rowSeq > resumeAt);
  const slice = pending.slice(0, budget);
  let written = 0;
  for (let start = 0; start < slice.length; start += WRITE_CHUNK) {
    const chunk = slice.slice(start, start + WRITE_CHUNK);
    const outcome = await writeRowChunk(
      read,
      build.snapshotId,
      chunk.map((row: ProjectionRow) => ({ row, digest: digests[row.rowSeq] ?? "" })),
      { lease, fence, now, rowsWritten: resumeAt + 1 + written },
    );
    if (outcome === "lease_lost")
      return halted("retryable", "writer_lease_lost", build.snapshotId, written);
    written += chunk.length;
  }
  if (slice.length < pending.length)
    return {
      enabled: true,
      snapshotId: build.snapshotId,
      status: "building",
      written,
      rowCount: projection.rows.length,
      retired: 0,
      reasonCode: null,
      sourceRevision: build.input.sourceRevision,
      inputDigest: build.inputDigest,
      active: false,
    };
  if (
    (await writeScopeRelations(read, build.snapshotId, projection.relations, {
      lease,
      fence,
      now,
    })) === "lease_lost"
  )
    return halted("retryable", "writer_lease_lost", build.snapshotId, written);

  // 3. Verify what was written, then seal and switch the pointer in one batch.
  if (!(await writtenRowsMatch(read, build.snapshotId, digests)))
    return halted("retryable", "projection_rows_unverified", build.snapshotId, written);
  const sealed = await sealAndPublish(
    read,
    {
      snapshotId: build.snapshotId,
      readInstanceId,
      sourceRevision: build.input.sourceRevision,
      visibilityRevision: build.input.visibilityRevision,
      coreEpoch: build.input.coreEpoch,
    },
    {
      rowCount: projection.rows.length,
      relationCount: projection.relations.filter((relation) => relation.source !== "policy").length,
      rowDigests: digests,
    },
    { lease, now },
  );
  if (!sealed.sealed) return halted("retryable", "writer_lease_lost", build.snapshotId, written);
  const retired = await retireOldSnapshots(read, build.snapshotId, now);
  return {
    enabled: true,
    snapshotId: build.snapshotId,
    status: "complete",
    written,
    rowCount: projection.rows.length,
    retired,
    reasonCode: null,
    sourceRevision: build.input.sourceRevision,
    inputDigest: build.inputDigest,
    active: sealed.published,
  };
}

/**
 * The published snapshot of the READ database when it covers `required` under
 * this CORE epoch. This is what makes the CORE side of a decision completable
 * after READ finished, and what converges a lost response without rebuilding
 * (G2-12): the pointer already carries the revision the decision moved.
 */
export async function readPublishedSnapshotAt(
  env: Env,
  required: number | null,
  coreEpoch: string | null,
): Promise<string | null> {
  const read = readDatabase(env);
  if (!read) return null;
  const published = await publishedSnapshotAt(read, required, coreEpoch);
  return published?.snapshot_id ?? null;
}
