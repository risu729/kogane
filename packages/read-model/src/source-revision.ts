// The CORE change detector and the identity of a fixed projection input
// (unified plan 05 §2–§4, migration 0038).
//
// Why this exists. The read model used to decide "is my snapshot still the
// current context?" from `max(parse_run_id)` and a few row counts. Neither is
// the identity of the adopted set: moving one artifact's adopted parse from
// 100 to 150 leaves `max` alone while some unrelated run 900 exists, and two
// opposite changes leave a count alone. Migration 0038 instead bumps
// `core_source_revision` inside the same transaction as every write the
// projection depends on, so a change cannot be missed whoever wrote it.
//
// The revision detects and orders change. It is deliberately NOT the snapshot
// identity: a write that does not change what the projection reads still moves
// it, and a snapshot must stay the same snapshot when its content is the same.
// The identity is the digest of the captured input (05 §4).

import { sha256Hex } from "../../domain/src/context.ts";

/**
 * The dependency ledger: tables whose every write bumps `source_revision`.
 *
 * This list is the source of truth for the trigger set of migrations 0038 and
 * 0041, and `packages/read-model/test/source-revision.test.ts` asserts that the
 * triggers in a migrated database are exactly the ones this ledger declares —
 * so a new dependency table cannot be added to the schema, or to this list,
 * alone.
 */
export const SOURCE_REVISION_LEDGER = [
  // What is adopted, and what the adoption replaced.
  "parse_runs",
  "published_parse_runs",
  "publication_events",
  // The candidate facts and their exact quantities.
  "balance_observations",
  "observation_decimal_values",
  // What a dataset claims to cover, and the policy that reads the claim.
  "parse_coverage_claims",
  "dataset_snapshot_policies",
  // Accepted judgements: which scopes overlap, and why.
  "entity_relations",
  "decision_revisions",
  // Identity: which provider account a measurement belongs to.
  "account_mappings",
  "instrument_mappings",
  "identity_observations",
  "identity_instrument_uses",
  "identity_runs",
  "identity_run_seals",
  "accounts",
  "instruments",
  "source_accounts",
  "instrument_identifiers",
  // Calculation policy, and the seal that makes evidence visible at all.
  "calculation_policies",
  "fetch_run_seals",
  // Rewards (migration 0041, U16): the versioned reference claims and the
  // provider claims a reward capture reads. A new rule version or a promoted
  // claim changes what the reward projection computes, so the fixed-input
  // capture of 05 §3 has to be able to see it.
  "reward_programs",
  "expiry_rules",
  "conversion_offers",
  "reward_bucket_claims",
  "membership_state_claims",
] as const;

/**
 * Tables that move `visibility_revision` as well as `source_revision`. A
 * restriction does not only hide rows: a subtotal computed before it is wrong,
 * so the affected snapshots are rebuilt rather than filtered (05 §7).
 */
export const VISIBILITY_REVISION_LEDGER = [
  "evidence_use_restrictions",
  "fetch_run_annotations",
] as const;

/**
 * Deliberately outside the ledger (05 §2). Bumping the revision when the
 * projection records its own progress would make every build stale the moment
 * it wrote a row, and rebuild for ever. `fetch_runs` / `fetch_artifacts` are
 * excluded for a different reason: evidence reaches a reader only once its run
 * is sealed and its parse published, and both of those are in the ledger.
 */
export const REVISION_EXCLUDED_TABLES = [
  "projection_input_records",
  "decision_outbox",
  "operation_receipts",
  "change_plans",
  "approvals",
  "observation_parse_jobs",
  "observation_work_items",
  "observation_scan_state",
  "observation_lane_state",
  "observation_replay_plans",
  "calculation_runs",
  "report_events",
  "report_artifacts",
  "fetch_runs",
  "fetch_artifacts",
  // Operations API request records (migration 0040): an operator's request and
  // its stage log say what was asked, never what the projection reads.
  "ops_requests",
  "ops_request_stages",
] as const;

export type LedgerTable =
  | (typeof SOURCE_REVISION_LEDGER)[number]
  | (typeof VISIBILITY_REVISION_LEDGER)[number];

const TRIGGER_EVENTS = ["insert", "update", "delete"] as const;

/** Every bump trigger the ledger declares (migrations 0038 and 0041), sorted. */
export function revisionTriggerNames(): string[] {
  return [...SOURCE_REVISION_LEDGER, ...VISIBILITY_REVISION_LEDGER]
    .flatMap((table) => TRIGGER_EVENTS.map((event) => `${table}_bump_revision_${event}`))
    .sort();
}

export interface CoreRevisionRow {
  source_revision: number;
  visibility_revision: number;
  core_epoch: string;
}

/** The one read that answers "did anything I depend on change?". */
export const CORE_REVISION_SQL =
  "SELECT source_revision, visibility_revision, core_epoch FROM core_source_revision WHERE id=1";

/** The shape of the stored input; a change of shape is a change of identity. */
export const PROJECTION_INPUT_CONTRACT_VERSION = "projection-input-v1";

/**
 * `snapshotId = sha256(inputContentDigest ‖ projectionBuildDigest ‖ contractVersion)`
 * (05 §4). The content digest says what was read, the build digest says what
 * the code would do with it, and the contract version says how both were
 * encoded. Two builds agree on the id exactly when all three agree.
 */
export async function snapshotIdentity(
  inputContentDigest: string,
  projectionBuildDigest: string,
  contractVersion: string = PROJECTION_INPUT_CONTRACT_VERSION,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/u.test(inputContentDigest) || !/^[0-9a-f]{64}$/u.test(projectionBuildDigest))
    throw new Error("read-model: snapshot identity needs two sha256 digests");
  return await sha256Hex(`${inputContentDigest}${projectionBuildDigest}${contractVersion}`);
}
