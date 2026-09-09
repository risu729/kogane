// Promotion of published balance observations into typed reward bucket claims
// (A11, migration 0033). This job does not parse anything and never touches a
// parser: it reads rows that are already published through the publication
// gate and writes one append-only claim per (source fact, promotion release).
//
// Three rules shape the whole file.
//   * A provider-displayed expiry is carried across exactly as observed, or as
//     `unknown` with a reason code. No deadline is ever predicted here; that is
//     `estimateExpiry` in packages/domain, and its output is a projection.
//   * "Points earned last month" is not a holding. It is promoted as a
//     `qualification` bucket so it stays visible and stays out of every
//     consumable subtotal (docs/balance-presentation.md, addendum 08 §2).
//   * The job is idempotent: `claim_digest` is a digest of the source fact
//     reference and the promotion release, and the insert ignores a conflict.
//     Re-running it, or running it while another sweep runs, adds nothing new.
import type { BucketKind } from "../../../packages/domain/src/rewards.ts";
import { validTemporalValue, type TemporalValue } from "../../../packages/domain/src/time.ts";

/** Bump to re-promote every published row under new mapping rules. */
export const REWARD_PROMOTION_RELEASE = "reward-promotion-v1";
/** Rows examined per sweep; the cursor is the highest promoted source fact id. */
export const REWARD_PROMOTION_BATCH = 500;

interface D1Like {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/** One promotion rule: which published measure becomes which kind of bucket. */
interface PromotionRule {
  sourceId: string;
  parserName: string;
  metric: string;
  /** Matched against `source_account` when present; the first match wins. */
  sourceAccountPrefix?: string;
  sourceAccountEquals?: string;
  programId: string;
  /**
   * The member holding every bucket of this rule belongs to. It is the
   * programme's account, not the provider's per-bucket display slot: those
   * become bucket references below.
   */
  holdingRef: string;
  unitRef: string;
  bucketKind: BucketKind | "expiry-dependent";
  restrictionRefs: string[];
}

/**
 * Only the three sources whose unit is documented in `docs/sources` are
 * promoted. The order matters: the store-limited prefix must be tried before
 * the general V Point bucket rule, exactly as `classifyBalance` does today.
 */
export const PROMOTION_RULES: readonly PromotionRule[] = [
  {
    sourceId: "v-point",
    parserName: "v-point-balance-info",
    metric: "available_point_bucket",
    sourceAccountPrefix: "v-point:store-limited:",
    programId: "program:v-point",
    holdingRef: "program:v-point:member",
    unitRef: "points:v-point",
    bucketKind: "restricted",
    restrictionRefs: ["restriction:v-point:store-limited"],
  },
  {
    sourceId: "v-point",
    parserName: "v-point-balance-info",
    metric: "available_point_bucket",
    // A bucket the provider dated is time-limited; one it did not is regular.
    // The provider's own `point_type` enum stays unmapped (docs/sources/v-point.md §4.1).
    programId: "program:v-point",
    holdingRef: "program:v-point:member",
    unitRef: "points:v-point",
    bucketKind: "expiry-dependent",
    restrictionRefs: [],
  },
  {
    sourceId: "v-point",
    parserName: "v-point-smfg-point",
    metric: "displayed_point_balance",
    programId: "program:v-point",
    holdingRef: "program:v-point:member",
    unitRef: "points:v-point",
    // Last month's earnings: a period total, never part of the holding.
    bucketKind: "qualification",
    restrictionRefs: ["measure:v-point:previous-month-earned"],
  },
  {
    sourceId: "v-point-pay",
    parserName: "v-point-pay-notification-event",
    metric: "prepaid_balance_after_event",
    programId: "program:v-point-pay",
    holdingRef: "program:v-point-pay:prepaid-yen",
    unitRef: "JPY",
    bucketKind: "regular",
    restrictionRefs: ["restriction:v-point-pay:prepaid-usage"],
  },
  {
    sourceId: "mobile-suica",
    parserName: "mobile-suica-sf-history",
    metric: "sf_balance_after_transaction",
    sourceAccountEquals: "mobile-suica:sf",
    programId: "program:mobile-suica-sf",
    holdingRef: "program:mobile-suica-sf:sf",
    unitRef: "JPY",
    bucketKind: "regular",
    restrictionRefs: ["restriction:mobile-suica:sf-usage"],
  },
];

interface CandidateRow {
  id: number;
  parse_run_id: number;
  source_id: string;
  parser_name: string;
  source_account: string;
  metric: string;
  instrument: string;
  observed_at: string | null;
  as_of: string | null;
  extra_json: string;
  decimal_status: "exact" | "missing" | "unparsed" | "conflict" | null;
  coefficient: string | null;
  scale: number | null;
}

// `parser_name` on a parse run carries no version suffix; the eligibility
// filter is the publication projection plus the same successful-run predicate
// every other reader uses (docs/publication-gate.md).
const CANDIDATE_SQL = `SELECT b.id,b.parse_run_id,a.source_id,p.parser_name,b.source_account,b.metric,
 b.instrument,b.observed_at,b.as_of,b.extra_json,
 d.status AS decimal_status,d.coefficient,d.scale
 FROM balance_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 LEFT JOIN observation_decimal_values d
   ON d.kind='balance' AND d.observation_id=b.id AND d.policy_version='decimal-v1'
 WHERE f.status='success' AND f.failure_count=0 AND b.id>?1
 ORDER BY b.id LIMIT ?2`;

const CURSOR_SQL = `SELECT COALESCE(MAX(source_fact_id),0) AS cursor FROM reward_bucket_claims
 WHERE source_fact_kind='balance' AND promotion_release=?1`;

const INSERT_SQL = `INSERT OR IGNORE INTO reward_bucket_claims
 (claim_digest,parse_run_id,source_fact_kind,source_fact_id,program_id,holding_ref,bucket_ref,
  bucket_kind,restriction_refs_json,unit_ref,quantity_coefficient,quantity_scale,quantity_status,
  observed_expiry_json,observed_at,promotion_release,recorded_at)
 VALUES(?1,?2,'balance',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`;

function matches(rule: PromotionRule, row: CandidateRow): boolean {
  if (rule.sourceId !== row.source_id || rule.metric !== row.metric) return false;
  if (rule.parserName !== row.parser_name) return false;
  if (rule.sourceAccountPrefix && !row.source_account.startsWith(rule.sourceAccountPrefix))
    return false;
  if (rule.sourceAccountEquals && row.source_account !== rule.sourceAccountEquals) return false;
  return true;
}

const COMPACT = /^(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/u;
const DASHED = /^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;
const SLASHED = /^(20\d{2})\/(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])$/u;
const JAPANESE = /^(20\d{2})年(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])日$/u;

/**
 * The provider's own expiry text, converted to a local date only when it is
 * unambiguously one. Anything else becomes `unknown` with a reason code: an
 * unreadable expiry is never dropped and never guessed, so the row still
 * appears in a deadline-ordered list as "not confirmed" (addendum 08 §8).
 */
export function observedExpiry(text: unknown, zone: string): TemporalValue | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const value = text.trim();
  for (const pattern of [COMPACT, DASHED, SLASHED, JAPANESE]) {
    const match = pattern.exec(value);
    if (!match) continue;
    const iso = `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
    const candidate: TemporalValue = {
      kind: "local-date",
      value: iso,
      zone,
      basis: "provider",
    };
    return validTemporalValue(candidate)
      ? candidate
      : { kind: "unknown", reasonCode: "provider_expiry_not_a_calendar_date" };
  }
  return { kind: "unknown", reasonCode: "provider_expiry_unparsed" };
}

function koganeField(extraJson: string, field: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extraJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const kogane = (parsed as Record<string, unknown>)._kogane;
  if (kogane === null || typeof kogane !== "object") return undefined;
  return (kogane as Record<string, unknown>)[field];
}

async function digest(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export interface RewardPromotionResult {
  enabled: true;
  scanned: number;
  promoted: number;
  skipped: number;
  cursor: number;
  release: string;
}

/**
 * One bounded promotion sweep. Returns counts and identifiers only; no amount,
 * account label or provider text is ever logged.
 */
export async function promoteRewardClaims(
  db: D1Like,
  options: { limit?: number; release?: string; now?: string } = {},
): Promise<RewardPromotionResult> {
  const release = options.release ?? REWARD_PROMOTION_RELEASE;
  const limit = Math.min(Math.max(options.limit ?? REWARD_PROMOTION_BATCH, 1), 5_000);
  const now = options.now ?? new Date().toISOString();
  const start = await db.prepare(CURSOR_SQL).bind(release).first<{ cursor: number }>();
  const from = start?.cursor ?? 0;
  const rows = await db.prepare(CANDIDATE_SQL).bind(from, limit).all<CandidateRow>();
  const statements: D1PreparedStatement[] = [];
  let cursor = from;
  let promoted = 0;
  let skipped = 0;
  for (const row of rows.results) {
    cursor = Math.max(cursor, row.id);
    const rule = PROMOTION_RULES.find((candidate) => matches(candidate, row));
    if (!rule) {
      skipped += 1;
      continue;
    }
    // The programme decides the unit; a provider instrument label that
    // disagrees is a mapping error, not something to reconcile silently.
    if (rule.unitRef === "JPY" && row.instrument !== "JPY") {
      skipped += 1;
      continue;
    }
    const expiry =
      rule.sourceId === "v-point"
        ? observedExpiry(koganeField(row.extra_json, "expiration"), "Asia/Tokyo")
        : null;
    const bucketKind: BucketKind =
      rule.bucketKind === "expiry-dependent"
        ? expiry === null
          ? "regular"
          : "time-limited"
        : rule.bucketKind;
    const status = row.decimal_status ?? "unparsed";
    const claimDigest = await digest(
      `balance:${row.id}:${rule.programId}:${row.source_account}:${release}`,
    );
    statements.push(
      db.prepare(INSERT_SQL).bind(
        claimDigest,
        row.parse_run_id,
        row.id,
        rule.programId,
        rule.holdingRef,
        // The provider's own display slot. A V Point array index is not a
        // durable account id (docs/sources/v-point.md §4.1), so a reader
        // takes the newest claim per slot rather than treating each claim as
        // a separate bucket.
        `${rule.programId}:${row.source_account}`,
        bucketKind,
        JSON.stringify(rule.restrictionRefs),
        rule.unitRef,
        status === "exact" ? row.coefficient : null,
        status === "exact" ? row.scale : null,
        status,
        expiry === null ? null : JSON.stringify(expiry),
        row.observed_at ?? row.as_of ?? now,
        release,
        now,
      ),
    );
    promoted += 1;
  }
  // D1 batches are bounded by the scan limit above; a conflict is ignored, so
  // a retry after a partial failure re-inserts nothing.
  for (let index = 0; index < statements.length; index += 50)
    await db.batch(statements.slice(index, index + 50));
  return {
    enabled: true,
    scanned: rows.results.length,
    promoted,
    skipped,
    cursor,
    release,
  };
}

/** Exact string match: anything but "true" leaves the stage off. */
export function rewardClaimsEnabled(env: Env): boolean {
  return String(env.REWARD_CLAIMS_ENABLED) === "true";
}

/**
 * The scheduled stage. Returns `null` while the flag is off so the disabled
 * deployment logs exactly the lines it logged before this PR.
 */
export async function rewardClaimsStage(env: Env): Promise<object | null> {
  if (!rewardClaimsEnabled(env)) return null;
  return await promoteRewardClaims(env.DB);
}
