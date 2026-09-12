// The reward routes served from the READ database (unified plan 04 §2, 05 §7;
// U16).
//
// What is different from the request-time answer the CORE path gives:
//
//   * every row was computed at one instant the snapshot names. A page says
//     `evaluatedAt`, so a reader knows what "expires in 30 days" was counted
//     from, instead of a deadline that quietly means something else on every
//     request (G2-19);
//   * a saved simulation is reported with its reproducibility. One that kept
//     only a digest is `not_reproducible` with a reason code; it is never
//     recomputed against today's offers and presented as the same simulation
//     (G2-20);
//   * nothing is served without a published snapshot. "The projection is being
//     rebuilt" is `503` with a code, never an empty success (05 §7, G3-01).
//
// The cursor is U11's: `{ snapshotId, readInstanceId, filterDigest, position }`
// over one fixed snapshot. Nothing in it is trusted and none of it is an
// authorisation — every continuation is authenticated and re-scoped like the
// first request.
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  activeRewardSnapshot,
  checkReadCursor,
  createReadProjectionReader,
  decodeReadCursor,
  encodeReadCursor,
  READ_CONTRACT_VERSION,
  rewardEstimatePage,
  rewardPointer,
  rewardSimulationPage,
  rewardSnapshot,
  type D1Like,
  type RewardEstimateRow,
  type RewardSimulationRow,
  type RewardSnapshotRow,
} from "../../../packages/storage-d1/src/read/index.ts";
import { createCoreProjectionSource, d1Executor } from "../../../packages/read-model/src/index";
import { HttpError, json } from "./http";

/** Rows per page; the same shape of limit the v2 balance routes accept. */
export const REWARD_READ_PAGE_LIMITS = [25, 50, 100, 200] as const;
export const DEFAULT_REWARD_READ_PAGE_LIMIT = 50;

/** The READ binding, when this deployment has one. */
export function rewardReadBinding(env: Env): D1Like | null {
  return (env as unknown as { READ?: D1Like }).READ ?? null;
}

export interface RewardReadContext {
  read: D1Like;
  readInstanceId: string;
  snapshot: RewardSnapshotRow;
}

/**
 * The published reward snapshot, or the reason there is none to serve.
 *
 * A database of another baseline is refused rather than read through the wrong
 * contract (06 §2), and a snapshot built under another CORE epoch or another
 * visibility revision is refused whole — a restriction does not only hide
 * rows, it invalidates the figures computed before it (05 §7).
 */
export async function rewardReadContext(
  env: Env,
): Promise<RewardReadContext | { unavailable: string }> {
  const read = rewardReadBinding(env);
  if (!read) return { unavailable: "reward_read_model_unavailable" };
  const instance = await createReadProjectionReader(
    d1Executor(env.DB),
    d1Executor(read),
  ).readInstance();
  if (!instance || instance.contract_version !== READ_CONTRACT_VERSION)
    return { unavailable: "reward_read_model_unavailable" };
  const snapshot = await activeRewardSnapshot(read);
  if (!snapshot) return { unavailable: "reward_read_model_unavailable" };
  const refusal = await snapshotRefusal(env, read, snapshot);
  if (refusal) return { unavailable: refusal };
  return { read, readInstanceId: instance.read_instance_id, snapshot };
}

async function snapshotRefusal(
  env: Env,
  read: D1Like,
  snapshot: RewardSnapshotRow,
): Promise<string | null> {
  const revision = await createCoreProjectionSource(d1Executor(env.DB)).coreRevision();
  const pointer = await rewardPointer(read);
  const vouched =
    pointer !== null && pointer.snapshot_id === snapshot.snapshot_id
      ? { epoch: pointer.core_epoch, visibility: pointer.visibility_revision }
      : { epoch: snapshot.core_epoch, visibility: snapshot.visibility_revision };
  if (vouched.epoch !== revision.core_epoch) return "reward_read_model_context_changed";
  if (vouched.visibility !== revision.visibility_revision)
    return "reward_read_model_restriction_changed";
  return null;
}

function pageLimit(url: URL): number {
  const text = url.searchParams.get("limit");
  if (text === null) return DEFAULT_REWARD_READ_PAGE_LIMIT;
  const limit = Number(text);
  if (!(REWARD_READ_PAGE_LIMITS as readonly number[]).includes(limit))
    throw new HttpError(400, "invalid_limit");
  return limit;
}

/** What a cursor is bound to: the route, the scope and the page size. */
async function filterDigest(
  route: string,
  scope: Record<string, string | number | null>,
): Promise<string> {
  return await canonicalDigest({ route, ...scope });
}

interface Continuation {
  snapshot: RewardSnapshotRow;
  afterRowSeq: number;
}

/**
 * Which snapshot serves this request: the published one without a cursor, the
 * one the cursor names with it — so membership stays fixed while a reader
 * pages. A cursor for another query is `cursor_mismatch` (400); one whose
 * context is gone is `context_expired` (410). Neither ever falls back to the
 * newest snapshot.
 */
async function continuation(
  context: RewardReadContext,
  url: URL,
  digest: string,
): Promise<Continuation> {
  const text = url.searchParams.get("cursor");
  if (text === null) return { snapshot: context.snapshot, afterRowSeq: -1 };
  const cursor = decodeReadCursor(text);
  if (!cursor) throw new HttpError(400, "invalid_cursor");
  const named = await rewardSnapshot(context.read, cursor.snapshotId);
  const rejection = checkReadCursor(cursor, {
    filterDigest: digest,
    readInstanceId: context.readInstanceId,
    snapshotReadable: named !== null,
  });
  if (rejection === "cursor_mismatch") throw new HttpError(400, "cursor_mismatch");
  if (rejection !== null || named === null) throw new HttpError(410, "context_expired");
  return { snapshot: named, afterRowSeq: cursor.position };
}

function refs(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function temporal(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function estimateDto(row: RewardEstimateRow) {
  return {
    holdingRef: row.holding_ref,
    programId: row.program_id,
    bucketRef: row.bucket_ref,
    bucketKind: row.bucket_kind,
    ruleRef: `${row.rule_id}@${row.rule_version}`,
    state: row.state,
    basis: row.deadline_basis,
    // A date, in the rule's own calendar; null keeps the row in a
    // deadline-ordered list rather than dropping it (addendum 08 §8).
    expiresOn: row.expires_on,
    quantity: {
      unitRef: row.unit_ref,
      value:
        row.amount_status === "exact" && row.amount_coefficient !== null
          ? {
              status: "exact",
              value: { coefficient: row.amount_coefficient, scale: row.amount_scale },
              normalizationVersion: "decimal-v1",
            }
          : { status: row.amount_status, reasonCode: `decimal-v1:${row.amount_status}` },
    },
    providerObserved: temporal(row.provider_observed_json),
    policyEstimated: temporal(row.policy_estimated_json),
    reasonCodes: refs(row.reason_codes_json),
    uncertaintyCodes: refs(row.uncertainty_codes_json),
    basisRefs: refs(row.basis_refs_json),
  };
}

function simulationDto(row: RewardSimulationRow) {
  return {
    requestDigest: row.request_digest,
    // The whole point of G2-20: a saved simulation says whether it could be
    // reproduced, and why not when it could not.
    reproducibility: row.reproducibility,
    reasonCode: row.reason_code,
    request: row.request_json === null ? null : (refs(row.request_json) as unknown),
    offerRef:
      row.offer_id === null ? null : `${row.offer_id}@${row.offer_version as unknown as string}`,
    result: row.result_json === null ? null : (refs(row.result_json) as unknown),
    searchCoverage: row.search_coverage,
    evaluatedAt: row.evaluated_at,
    release: row.policy_release,
  };
}

function snapshotEnvelope(snapshot: RewardSnapshotRow) {
  return {
    snapshotId: snapshot.snapshot_id,
    // What every deadline on this page was computed against, and in which
    // calendar: a reader is never left to assume "now" (05 §3).
    evaluatedAt: snapshot.evaluated_at,
    evaluationCalendar: snapshot.calendar_rule_id,
    ruleSetDigest: snapshot.rule_set_digest,
    ruleCount: snapshot.rule_count,
    claimsRelease: snapshot.claims_release,
    claimsHighWater: snapshot.claims_high_water,
    release: snapshot.policy_release,
  };
}

/** `GET /api/v2/rewards/expiry` from the published reward snapshot. */
export async function rewardExpiryFromRead(
  context: RewardReadContext,
  url: URL,
  program: string | undefined,
): Promise<Response> {
  const limit = pageLimit(url);
  const digest = await filterDigest("/api/v2/rewards/expiry", {
    program: program ?? null,
    limit,
  });
  const resolved = await continuation(context, url, digest);
  const rows = await rewardEstimatePage(context.read, resolved.snapshot.snapshot_id, {
    programId: program,
    afterRowSeq: resolved.afterRowSeq,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return json({
    rows: page.map(estimateDto),
    page: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeReadCursor({
              snapshotId: resolved.snapshot.snapshot_id,
              readInstanceId: context.readInstanceId,
              filterDigest: digest,
              sortKey: last.expires_on ?? "",
              position: last.row_seq,
            })
          : null,
    },
    snapshot: snapshotEnvelope(resolved.snapshot),
  });
}

/** `GET /api/v2/rewards/simulations`: the saved simulations of the snapshot. */
export async function rewardSimulationsFromRead(
  context: RewardReadContext,
  url: URL,
): Promise<Response> {
  const limit = pageLimit(url);
  const digest = await filterDigest("/api/v2/rewards/simulations", { limit });
  const resolved = await continuation(context, url, digest);
  const rows = await rewardSimulationPage(context.read, resolved.snapshot.snapshot_id, {
    afterRowSeq: resolved.afterRowSeq,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return json({
    rows: page.map(simulationDto),
    page: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeReadCursor({
              snapshotId: resolved.snapshot.snapshot_id,
              readInstanceId: context.readInstanceId,
              filterDigest: digest,
              sortKey: last.request_digest,
              position: last.row_seq,
            })
          : null,
    },
    snapshot: snapshotEnvelope(resolved.snapshot),
  });
}
