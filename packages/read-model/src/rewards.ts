// Reward read model (A11). The queries here are the only way the evidence
// browser reaches migration 0033's tables; the API never sees a table name.
//
// Two properties are enforced in the SQL rather than in a caller.
//   * A claim is only visible while the parse run it came from is still the
//     published one, so a rollback removes it from every reward read exactly
//     as it removes the underlying balance row (docs/publication-gate.md).
//   * Only the newest claim per bucket slot is current. Claims are append-only
//     history; the read picks one per slot instead of summing the history.
//
// Nothing in this module converts a reward quantity into an asset subtotal.
import {
  type BucketKind,
  BUCKET_KINDS,
  type ConversionOffer,
  type ExpiryFamily,
  EXPIRY_FAMILIES,
  type ExpiryRule,
  type MembershipState,
  type QualificationMeasure,
  type RewardBucket,
  type RewardHolding,
  type RewardProgram,
  type RuleVerification,
  RULE_VERIFICATIONS,
} from "../../domain/src/rewards";
import { validTemporalValue, type TemporalValue } from "../../domain/src/time";
import type { Quantity, RoundingMode, ValueStatus } from "../../domain/src/values";
import type { SqlExecutor } from "./reader";

/** Promotion release the read side treats as current (docs/rewards.md). */
export const REWARD_READ_RELEASE = "reward-promotion-v1";
/** One page plus one row, so truncation is reported without a count query. */
export const REWARD_PAGE_LIMIT = 200;

export interface Page<T> {
  rows: T[];
  coverage: { limit: number; truncated: boolean; nextOffset: number | null };
}

export function page<T>(rows: T[], offset: number, limit = REWARD_PAGE_LIMIT): Page<T> {
  const truncated = rows.length > limit;
  return {
    rows: rows.slice(0, limit),
    coverage: { limit, truncated, nextOffset: truncated ? offset + limit : null },
  };
}

// ── SQL ──────────────────────────────────────────────────────────────

/**
 * Current buckets: the newest claim per (programme, holding, bucket slot),
 * restricted to claims whose parse run is still published. `?1` is the
 * promotion release, `?2` an optional programme filter, `?3` the offset.
 */
export const CURRENT_REWARD_BUCKETS_SQL = `WITH ranked AS (
  SELECT c.id,c.program_id,c.holding_ref,c.bucket_ref,c.bucket_kind,c.restriction_refs_json,
    c.unit_ref,c.quantity_coefficient,c.quantity_scale,c.quantity_status,c.observed_expiry_json,
    c.observed_at,c.parse_run_id,c.source_fact_kind,c.source_fact_id,
    row_number() OVER(PARTITION BY c.program_id,c.holding_ref,c.bucket_ref
      ORDER BY c.observed_at DESC,c.id DESC) AS rank
  FROM reward_bucket_claims c
  JOIN published_parse_runs pub ON pub.parse_run_id=c.parse_run_id
  WHERE c.promotion_release=?1 AND (?2 IS NULL OR c.program_id=?2)
)
SELECT r.id,r.program_id,r.holding_ref,r.bucket_ref,r.bucket_kind,r.restriction_refs_json,
  r.unit_ref,r.quantity_coefficient,r.quantity_scale,r.quantity_status,r.observed_expiry_json,
  r.observed_at,r.parse_run_id,r.source_fact_kind,r.source_fact_id,
  p.institution_ref,p.program_ref,p.source_id,p.unit_ref AS program_unit_ref,p.holding_kind,
  p.terms_evidence_refs_json,p.release_id
FROM ranked r JOIN reward_programs p ON p.program_id=r.program_id
WHERE r.rank=1
ORDER BY r.program_id,r.holding_ref,r.bucket_ref
LIMIT ${REWARD_PAGE_LIMIT + 1} OFFSET ?3`;

export const EXPIRY_RULES_SQL = `SELECT rule_id,version,family,program_id,applicability_json,
 qualifying_activity_policy_ref,deadline_calendar_ref,priority_policy_ref,evidence_refs_json,verification
 FROM expiry_rules WHERE (?1 IS NULL OR program_id=?1) ORDER BY program_id,rule_id,version`;

export const MEMBERSHIP_SQL = `WITH ranked AS (
  SELECT m.*, row_number() OVER(PARTITION BY m.program_id,m.holding_ref,m.tier
    ORDER BY m.id DESC) AS rank FROM membership_state_claims m
  WHERE (?1 IS NULL OR m.program_id=?1)
)
SELECT program_id,holding_ref,tier,valid_json,source,evidence_refs_json FROM ranked
WHERE rank=1 ORDER BY program_id,holding_ref,tier`;

export const CONVERSION_OFFERS_SQL = `SELECT offer_id,version,source_program_ref,destination_program_ref,
 from_unit_ref,to_unit_ref,ratio_numerator,ratio_denominator,minimum_coefficient,minimum_scale,
 increment_coefficient,increment_scale,maximum_per_request_coefficient,maximum_per_request_scale,
 shared_quota_ref,fixed_fees_json,variable_fee_policy_ref,eligibility_policy_ref,
 eligible_bucket_kinds_json,eligible_restriction_refs_json,eligible_tiers_json,
 valid_time_json,application_deadline_json,processing_policy_ref,processing_days,
 rounding_policy_ref,rounding_scale,rounding_mode,cancellation_policy_ref,evidence_refs_json,verification
 FROM conversion_offers
 WHERE (?1 IS NULL OR offer_id=?1) ORDER BY offer_id,version LIMIT ${REWARD_PAGE_LIMIT + 1} OFFSET ?2`;

// ── row shapes ───────────────────────────────────────────────────────

export interface RewardBucketSqlRow {
  id: number;
  program_id: string;
  holding_ref: string;
  bucket_ref: string;
  bucket_kind: string;
  restriction_refs_json: string;
  unit_ref: string;
  quantity_coefficient: string | null;
  quantity_scale: number | null;
  quantity_status: string;
  observed_expiry_json: string | null;
  observed_at: string;
  parse_run_id: number;
  source_fact_kind: string;
  source_fact_id: number;
  institution_ref: string;
  program_ref: string;
  source_id: string;
  program_unit_ref: string;
  holding_kind: string;
  terms_evidence_refs_json: string;
  release_id: string;
}

export interface ExpiryRuleSqlRow {
  rule_id: string;
  version: string;
  family: string;
  program_id: string;
  applicability_json: string;
  qualifying_activity_policy_ref: string | null;
  deadline_calendar_ref: string;
  priority_policy_ref: string | null;
  evidence_refs_json: string;
  verification: string;
}

export interface MembershipSqlRow {
  program_id: string;
  holding_ref: string;
  tier: string;
  valid_json: string;
  source: string;
  evidence_refs_json: string;
}

export interface ConversionOfferSqlRow {
  offer_id: string;
  version: string;
  source_program_ref: string;
  destination_program_ref: string;
  from_unit_ref: string;
  to_unit_ref: string;
  ratio_numerator: string;
  ratio_denominator: string;
  minimum_coefficient: string;
  minimum_scale: number;
  increment_coefficient: string;
  increment_scale: number;
  maximum_per_request_coefficient: string | null;
  maximum_per_request_scale: number | null;
  shared_quota_ref: string | null;
  fixed_fees_json: string;
  variable_fee_policy_ref: string | null;
  eligibility_policy_ref: string;
  eligible_bucket_kinds_json: string;
  eligible_restriction_refs_json: string;
  eligible_tiers_json: string | null;
  valid_time_json: string;
  application_deadline_json: string;
  processing_policy_ref: string;
  processing_days: number;
  rounding_policy_ref: string;
  rounding_scale: number;
  rounding_mode: string;
  cancellation_policy_ref: string | null;
  evidence_refs_json: string;
  verification: string;
}

// ── mappers ──────────────────────────────────────────────────────────

function refs(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** A stored temporal value that no longer validates becomes `unknown`, never a guess. */
function temporal(json: string | null, fallbackReason: string): TemporalValue | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return validTemporalValue(parsed) ? parsed : { kind: "unknown", reasonCode: fallbackReason };
  } catch {
    return { kind: "unknown", reasonCode: fallbackReason };
  }
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/** Stored `observed_at` text as a role-typed time; a date never becomes an instant. */
export function observedAtValue(text: string): TemporalValue {
  if (INSTANT.test(text)) {
    const candidate: TemporalValue = {
      kind: "instant",
      value: text,
      zone: "UTC",
      basis: "collector",
    };
    if (validTemporalValue(candidate)) return candidate;
  }
  if (DATE_ONLY.test(text)) {
    const candidate: TemporalValue = {
      kind: "local-date",
      value: text,
      zone: null,
      basis: "provider",
    };
    if (validTemporalValue(candidate)) return candidate;
  }
  return { kind: "unknown", reasonCode: "observed_at_unparsed" };
}

function quantity(row: RewardBucketSqlRow): Quantity {
  const status = row.quantity_status as ValueStatus;
  if (status === "exact" && row.quantity_coefficient !== null && row.quantity_scale !== null)
    return {
      unitRef: row.unit_ref,
      value: {
        status: "exact",
        value: { coefficient: row.quantity_coefficient, scale: row.quantity_scale },
        normalizationVersion: "decimal-v1",
      },
    };
  return {
    unitRef: row.unit_ref,
    value: {
      status: status === "exact" ? "unparsed" : status,
      reasonCode: `decimal-v1:${row.quantity_status}`,
    },
  };
}

function bucketKind(value: string): BucketKind {
  return (BUCKET_KINDS as readonly string[]).includes(value)
    ? (value as BucketKind)
    : "qualification";
}

export function rewardBucket(row: RewardBucketSqlRow): RewardBucket {
  return {
    bucketRef: row.bucket_ref,
    programId: row.program_id,
    holdingRef: row.holding_ref,
    kind: bucketKind(row.bucket_kind),
    restrictionRefs: refs(row.restriction_refs_json),
    quantity: quantity(row),
    observedExpiry: temporal(row.observed_expiry_json, "stored_expiry_invalid"),
    observedAt: observedAtValue(row.observed_at),
    sourceFactRefs: [`${row.source_fact_kind}:${row.source_fact_id}`],
  };
}

export function rewardProgramOf(row: RewardBucketSqlRow): RewardProgram {
  return {
    programId: row.program_id,
    institutionRef: row.institution_ref,
    programRef: row.program_ref,
    unitRef: row.program_unit_ref,
    termsEvidenceRefs: refs(row.terms_evidence_refs_json),
    release: row.release_id,
  };
}

/**
 * Qualifying-activity policies, keyed by the reference migration 0033 seeds.
 * A policy exists here only when a `docs/sources` record cites the provider's
 * own terms; a rule whose reference is absent computes no deadline at all
 * rather than falling back to the newest activity of any kind (SC12).
 */
export const QUALIFYING_ACTIVITY_POLICIES: Readonly<
  Record<string, NonNullable<ExpiryRule["qualifyingActivity"]>>
> = {
  // docs/sources/v-point.md §4.1, from the Vポイントサービス利用規約: a regular
  // point expires one year after the last movement of a regular point, and
  // earning or spending a store-limited point is not such a movement.
  "policy:v-point:qualifying-activity:v1": {
    policyRef: "policy:v-point:qualifying-activity:v1",
    kinds: ["earn", "redeem", "exchange", "fixed-expiry-redeem"],
    excludedKinds: ["store-limited-earn", "store-limited-redeem", "fixed-expiry-earn"],
    extensionMonths: 12,
    endOfMonthPolicy: "clamp",
    dateBasis: "provider-posted",
  },
};

export function expiryRule(row: ExpiryRuleSqlRow): ExpiryRule {
  let applicability: ExpiryRule["applicability"] = {
    bucketKinds: [],
    tiers: null,
    validPeriod: null,
  };
  try {
    const parsed: unknown = JSON.parse(row.applicability_json);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      applicability = {
        bucketKinds: Array.isArray(record.bucketKinds)
          ? record.bucketKinds.filter((kind): kind is BucketKind =>
              (BUCKET_KINDS as readonly unknown[]).includes(kind),
            )
          : [],
        tiers: Array.isArray(record.tiers)
          ? record.tiers.filter((tier): tier is string => typeof tier === "string")
          : null,
        validPeriod: validTemporalValue(record.validPeriod) ? record.validPeriod : null,
      };
    }
  } catch {
    /* An unreadable applicability leaves the rule scoped to nothing. */
  }
  // `zone:dayBoundary:zoneBasis`, kept separate from any display zone.
  const [zone, dayBoundary, zoneBasis] = row.deadline_calendar_ref.split(":");
  const family = (EXPIRY_FAMILIES as readonly string[]).includes(row.family)
    ? (row.family as ExpiryFamily)
    : "unsupported";
  const verification = (RULE_VERIFICATIONS as readonly string[]).includes(row.verification)
    ? (row.verification as RuleVerification)
    : "needs-rule-verification";
  return {
    ruleId: row.rule_id,
    version: row.version,
    family,
    programId: row.program_id,
    applicability,
    // The policy body is resolved from the registry above. An unresolved
    // reference leaves it null, and `estimateExpiry` then reports
    // needs-rule-verification instead of computing anything.
    qualifyingActivity:
      row.qualifying_activity_policy_ref === null
        ? null
        : (QUALIFYING_ACTIVITY_POLICIES[row.qualifying_activity_policy_ref] ?? null),
    deadlineCalendar: {
      zone: zone && zone.length > 0 ? zone : "UTC",
      dayBoundary: dayBoundary === "start-of-day" ? "start-of-day" : "end-of-day",
      zoneBasis: zoneBasis === "documented" ? "documented" : "assumed",
    },
    priorityPolicyRef: row.priority_policy_ref,
    evidenceRefs: refs(row.evidence_refs_json),
    verification,
  };
}

export function membershipState(row: MembershipSqlRow): MembershipState {
  return {
    programId: row.program_id,
    holdingRef: row.holding_ref,
    tier: row.tier,
    valid: temporal(row.valid_json, "stored_membership_period_invalid") ?? {
      kind: "unknown",
      reasonCode: "stored_membership_period_invalid",
    },
    source: row.source === "provider" ? "provider" : "self-reported",
    evidenceRefs: refs(row.evidence_refs_json),
  };
}

function fees(json: string): Quantity[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Quantity[]) : [];
  } catch {
    return [];
  }
}

export function conversionOffer(row: ConversionOfferSqlRow): ConversionOffer {
  const unknownTime: TemporalValue = { kind: "unknown", reasonCode: "stored_offer_time_invalid" };
  return {
    offerId: row.offer_id,
    version: row.version,
    sourceProgramRef: row.source_program_ref,
    destinationProgramRef: row.destination_program_ref,
    fromUnitRef: row.from_unit_ref,
    toUnitRef: row.to_unit_ref,
    ratio: { numerator: row.ratio_numerator, denominator: row.ratio_denominator },
    minimum: { coefficient: row.minimum_coefficient, scale: row.minimum_scale },
    increment: { coefficient: row.increment_coefficient, scale: row.increment_scale },
    maximumPerRequest:
      row.maximum_per_request_coefficient === null || row.maximum_per_request_scale === null
        ? null
        : {
            coefficient: row.maximum_per_request_coefficient,
            scale: row.maximum_per_request_scale,
          },
    sharedQuotaRef: row.shared_quota_ref,
    fixedFees: fees(row.fixed_fees_json),
    variableFeePolicyRef: row.variable_fee_policy_ref,
    eligibilityPolicyRef: row.eligibility_policy_ref,
    eligibleBucketKinds: refs(row.eligible_bucket_kinds_json).filter((kind): kind is BucketKind =>
      (BUCKET_KINDS as readonly string[]).includes(kind),
    ),
    eligibleRestrictionRefs: refs(row.eligible_restriction_refs_json),
    eligibleTiers: row.eligible_tiers_json === null ? null : refs(row.eligible_tiers_json),
    validTime: temporal(row.valid_time_json, "stored_offer_time_invalid") ?? unknownTime,
    applicationDeadline:
      temporal(row.application_deadline_json, "stored_offer_time_invalid") ?? unknownTime,
    processingPolicyRef: row.processing_policy_ref,
    processingDays: row.processing_days,
    roundingPolicyRef: row.rounding_policy_ref,
    rounding: { scale: row.rounding_scale, mode: row.rounding_mode as RoundingMode },
    cancellationPolicyRef: row.cancellation_policy_ref,
    evidenceRefs: refs(row.evidence_refs_json),
    verification: (RULE_VERIFICATIONS as readonly string[]).includes(row.verification)
      ? (row.verification as RuleVerification)
      : "needs-rule-verification",
  };
}

// ── reader ───────────────────────────────────────────────────────────

export interface RewardHoldingView {
  program: RewardProgram;
  holding: RewardHolding;
  holdingKind: "reward-points" | "prepaid-balance";
  sourceId: string;
  /** Observed-at text per bucket, exactly as the provider reported it. */
  observedAt: Record<string, string>;
  qualification: QualificationMeasure[];
}

export interface RewardReader {
  holdings(scope: { programId?: string; offset: number }): Promise<Page<RewardHoldingView>>;
  expiryRules(programId?: string): Promise<ExpiryRule[]>;
  membership(programId?: string): Promise<MembershipState[]>;
  offers(scope: { offerId?: string; offset: number }): Promise<Page<ConversionOffer>>;
}

export function createRewardReader(sql: SqlExecutor, release = REWARD_READ_RELEASE): RewardReader {
  return {
    async holdings(scope) {
      const rows = await sql.all<RewardBucketSqlRow>(CURRENT_REWARD_BUCKETS_SQL, [
        release,
        scope.programId ?? null,
        scope.offset,
      ]);
      // The offset walks bucket rows, not holdings: a holding whose buckets
      // straddle a page boundary is reported on both pages rather than being
      // silently completed from rows the caller did not ask for.
      const truncated = rows.length > REWARD_PAGE_LIMIT;
      const views = new Map<string, RewardHoldingView>();
      for (const row of rows.slice(0, REWARD_PAGE_LIMIT)) {
        const key = `${row.program_id} ${row.holding_ref}`;
        let view = views.get(key);
        if (!view) {
          view = {
            program: rewardProgramOf(row),
            holding: {
              holdingRef: row.holding_ref,
              programId: row.program_id,
              unitRef: row.program_unit_ref,
              buckets: [],
            },
            holdingKind:
              row.holding_kind === "prepaid-balance" ? "prepaid-balance" : "reward-points",
            sourceId: row.source_id,
            observedAt: {},
            qualification: [],
          };
          views.set(key, view);
        }
        const bucket = rewardBucket(row);
        view.observedAt[bucket.bucketRef] = row.observed_at;
        // A qualification bucket is reported beside the holding, never inside
        // it, so no consumable subtotal can ever include it.
        if (bucket.kind === "qualification")
          view.qualification.push({
            measureRef: bucket.bucketRef,
            programId: bucket.programId,
            metricRef: "reward.qualification-measure",
            quantity: bucket.quantity,
            period: observedAtValue(row.observed_at),
            consumable: false,
            sourceFactRefs: bucket.sourceFactRefs,
          });
        else view.holding.buckets.push(bucket);
      }
      return {
        rows: [...views.values()],
        coverage: {
          limit: REWARD_PAGE_LIMIT,
          truncated,
          nextOffset: truncated ? scope.offset + REWARD_PAGE_LIMIT : null,
        },
      };
    },
    async expiryRules(programId) {
      return (await sql.all<ExpiryRuleSqlRow>(EXPIRY_RULES_SQL, [programId ?? null])).map(
        expiryRule,
      );
    },
    async membership(programId) {
      return (await sql.all<MembershipSqlRow>(MEMBERSHIP_SQL, [programId ?? null])).map(
        membershipState,
      );
    },
    async offers(scope) {
      const rows = await sql.all<ConversionOfferSqlRow>(CONVERSION_OFFERS_SQL, [
        scope.offerId ?? null,
        scope.offset,
      ]);
      return page(rows.map(conversionOffer), scope.offset);
    },
  };
}
