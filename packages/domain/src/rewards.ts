// Reward programs, restricted buckets, expiry rules and bounded conversion
// simulation (addendum 08, scenarios SC11-SC14).
//
// Three separations carry the whole module. (1) A program unit is not a
// currency and not another program's unit: points are only ever summed inside
// one `unitRef`, and nothing here converts a reward quantity into an asset
// subtotal. (2) A quantity that can be consumed is not a qualification
// measure: status indicators are reported beside a holding, never inside it.
// (3) A provider-observed expiry is not a computed one: both are kept, and a
// disagreement is `conflict`, not a silent choice. Nothing in this file
// performs an exchange; `simulateConversion` and `findConversionPaths` return
// bounded plans and the conditions that still need checking.
import {
  hasExactKeys,
  isArrayOf,
  isOneOf,
  isRecord,
  isRefList,
  isSafeInt,
  isText,
  isTextOrNull,
} from "./guards.ts";
import {
  addMonths,
  civilFromDays,
  compareTemporal,
  daysFromCivil,
  formatLocalDate,
  parseLocalDate,
  periodContainsDate,
  validTemporalValue,
  validZone,
  type CivilDate,
  type EndOfMonthPolicy,
  type LocalDateValue,
  type TemporalValue,
} from "./time.ts";
import {
  compareDecimals,
  divideDecimals,
  exactQuantity,
  integerDecimal,
  multiplyByRatio,
  multiplyDecimals,
  subtractDecimals,
  sumQuantities,
  validExactDecimal,
  validExactRatio,
  validQuantity,
  validRounding,
  type ExactDecimal,
  type ExactRatio,
  type Quantity,
  type Rounding,
  type ValueError,
} from "./values.ts";

/** Release stamped on everything this module derives. */
export const REWARD_POLICY_RELEASE = "reward-model-v1";
/** Search release; bumped whenever the traversal rules change a returned plan. */
export const CONVERSION_SEARCH_RELEASE = "conversion-search-v1";

// ── program, holding, bucket ─────────────────────────────────────────

/**
 * `regular` and `restricted` differ in what they may be spent on;
 * `time-limited` in when. `pending-award` is announced but not held, and
 * `qualification` is a status measure that is never consumable. The kinds are
 * deliberately not ordered: none of them is a superset of another.
 */
export const BUCKET_KINDS = [
  "regular",
  "restricted",
  "time-limited",
  "pending-award",
  "qualification",
] as const;
export type BucketKind = (typeof BUCKET_KINDS)[number];
/** Kinds that may be summed into the holding's consumable quantity. */
export const CONSUMABLE_BUCKET_KINDS: readonly BucketKind[] = [
  "regular",
  "restricted",
  "time-limited",
];

export interface RewardProgram {
  programId: string;
  institutionRef: string;
  programRef: string;
  /** The program's own counting unit. Two programs never share one, even under the same name. */
  unitRef: string;
  termsEvidenceRefs: string[];
  release: string;
}

export interface RewardBucket {
  bucketRef: string;
  programId: string;
  /** The member holding (source account) the bucket belongs to. */
  holdingRef: string;
  kind: BucketKind;
  /** What the bucket may be spent on; empty for an unrestricted bucket. */
  restrictionRefs: string[];
  quantity: Quantity;
  /** Exactly what the provider displayed; never a prediction. */
  observedExpiry: TemporalValue | null;
  observedAt: TemporalValue;
  sourceFactRefs: string[];
}

export interface RewardHolding {
  holdingRef: string;
  programId: string;
  unitRef: string;
  buckets: RewardBucket[];
}

/**
 * A measure of membership progress (lifetime miles, status points, period
 * totals). `consumable` is a literal `false` so a qualification measure cannot
 * be assigned where a spendable quantity is expected.
 */
export interface QualificationMeasure {
  measureRef: string;
  programId: string;
  metricRef: string;
  quantity: Quantity;
  period: TemporalValue;
  consumable: false;
  sourceFactRefs: string[];
}

export const MEMBERSHIP_SOURCES = ["provider", "self-reported"] as const;
export type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];
export interface MembershipState {
  programId: string;
  holdingRef: string;
  tier: string;
  /** The period the tier is claimed for; a tier is never applied outside it. */
  valid: TemporalValue;
  source: MembershipSource;
  evidenceRefs: string[];
}

// ── expiry rules ─────────────────────────────────────────────────────

export const EXPIRY_FAMILIES = [
  "fixed-lot",
  "inactivity",
  "fixed-account",
  "none",
  "unsupported",
] as const;
export type ExpiryFamily = (typeof EXPIRY_FAMILIES)[number];
export const RULE_VERIFICATIONS = ["verified", "needs-rule-verification"] as const;
export type RuleVerification = (typeof RULE_VERIFICATIONS)[number];

/**
 * The deadline calendar is the program's, not the reader's. A UI may render a
 * deadline in the viewer's zone, but the day it falls on is decided here.
 */
export interface DeadlineCalendar {
  zone: string;
  dayBoundary: "end-of-day" | "start-of-day";
  /** How the zone was established; an assumed zone raises an uncertainty code. */
  zoneBasis: "documented" | "assumed";
}

export interface QualifyingActivityPolicy {
  policyRef: string;
  /** Activity kinds that extend the deadline. Anything not listed does not. */
  kinds: readonly string[];
  /** Kinds named in the terms as explicitly *not* extending it (family transfers). */
  excludedKinds: readonly string[];
  extensionMonths: number;
  endOfMonthPolicy: EndOfMonthPolicy;
  /** Which date of an activity anchors the deadline. */
  dateBasis: "provider-posted" | "member-used";
}

export interface ExpiryRuleApplicability {
  bucketKinds: readonly BucketKind[];
  /** `null` means every tier; a list means the rule needs a matching membership. */
  tiers: readonly string[] | null;
  /** The period the rule text itself is in force. */
  validPeriod: TemporalValue | null;
}

export interface ExpiryRule {
  ruleId: string;
  version: string;
  family: ExpiryFamily;
  programId: string;
  applicability: ExpiryRuleApplicability;
  qualifyingActivity: QualifyingActivityPolicy | null;
  deadlineCalendar: DeadlineCalendar;
  priorityPolicyRef: string | null;
  evidenceRefs: string[];
  verification: RuleVerification;
}

export interface RewardActivity {
  activityRef: string;
  kind: string;
  /** Provider posting date and member usage date are different roles. */
  postedDate: TemporalValue;
  usedDate: TemporalValue | null;
}

export const HISTORY_COMPLETENESS = ["complete", "partial", "unknown"] as const;
export type HistoryCompleteness = (typeof HISTORY_COMPLETENESS)[number];
export interface ActivityHistory {
  windowRef: string;
  completeness: HistoryCompleteness;
  /** The earliest date the window actually covers; older activity is unobserved. */
  earliestObserved: TemporalValue | null;
  activities: readonly RewardActivity[];
}

export const EXPIRY_ESTIMATE_STATES = [
  "computed",
  "partial",
  "conflict",
  "needs-rule-verification",
] as const;
export type ExpiryEstimateState = (typeof EXPIRY_ESTIMATE_STATES)[number];
export const DEADLINE_BASES = ["provider-observed", "policy-estimated", "unknown"] as const;
export type DeadlineBasis = (typeof DEADLINE_BASES)[number];

/**
 * Release of the expiry derivation: stamped on every computed expiry and
 * bumped whenever the same inputs could produce a different date or reason.
 */
export const EXPIRY_DERIVATION_RELEASE = "reward-expiry-v1";

/**
 * The deadline the provider displayed for one bucket. An observation, never a
 * prediction: `value` is exactly what the claim promoted, including an
 * `unknown` with the reason the display could not be read.
 */
export interface DisplayedExpiry {
  value: TemporalValue;
  /** When the provider displayed it: the bucket claim's own observation time. */
  observedAt: TemporalValue;
  /** The claims the display came from. */
  sourceFactRefs: string[];
}

/**
 * The rule version a computed expiry was derived under, and where its terms
 * are confirmed: `evidenceRefs` are the repository records the rule cites for
 * the provider's own terms (docs/sources), copied from the stored rule.
 */
export interface ExpiryRuleBasis {
  ruleRef: string;
  ruleId: string;
  version: string;
  family: ExpiryFamily;
  verification: RuleVerification;
  /** The period this version's text is in force; null for an open-ended version. */
  validPeriod: TemporalValue | null;
  evidenceRefs: string[];
  qualifyingActivityPolicyRef: string | null;
  deadlineCalendar: DeadlineCalendar;
}

/** The activity facts an inactivity rule consumed. */
export interface ExpiryActivityBasis {
  windowRef: string;
  completeness: HistoryCompleteness;
  earliestObserved: TemporalValue | null;
  /** The newest qualifying activity, which the deadline is counted from. */
  anchorActivityRef: string | null;
  anchorDate: LocalDateValue | null;
}

export interface ExpiryMembershipClaimBasis {
  tier: string;
  source: MembershipSource;
  valid: TemporalValue;
  evidenceRefs: string[];
}

/** The membership facts a tier-gated rule consumed. */
export interface ExpiryMembershipBasis {
  requiredTiers: string[];
  /** This holding's claims for one of the required tiers, whether or not they covered the anchor. */
  claims: ExpiryMembershipClaimBasis[];
}

export const COMPUTED_EXPIRY_STATUSES = ["date", "no-expiry", "unavailable"] as const;
export type ComputedExpiryStatus = (typeof COMPUTED_EXPIRY_STATUSES)[number];

/**
 * Why no deadline was computed. A closed list: every code names the missing
 * or unconfirmed input, and none of them is a date, a zero or "no expiry".
 */
export const COMPUTED_EXPIRY_REASONS = [
  /** The rule is stored as needing verification: its terms are not confirmed in the repository. */
  "rule_not_verified",
  /** The terms are recorded but not reduced to a calculation. */
  "rule_family_unsupported",
  /** The evaluation day lies outside the period this rule version is in force. */
  "rule_out_of_force",
  /** The deadline or its anchor falls outside this version's period; what the next version does with it is not recorded. */
  "rule_transition_unconfirmed",
  /** This rule version does not apply to the bucket's kind. */
  "rule_bucket_kind_not_covered",
  /** The rule fixes each lot's own deadline; only the provider's display states it. */
  "fixed_deadline_not_derivable",
  /** An inactivity rule whose qualifying-activity policy did not resolve. */
  "qualifying_activity_policy_missing",
  /** A tier-gated rule and no claim of a required tier for this holding. */
  "membership_out_of_scope",
  /** A required tier exists but did not cover the anchor activity. */
  "membership_not_retroactive",
  /** A qualifying activity's date could not be read, so it may be the newest one. */
  "activity_date_unknown",
  /** No qualifying activity in the observed history. */
  "no_qualifying_activity_observed",
  /** Whether the history window has gaps is unknown, so a newer qualifying activity may be missing. */
  "history_completeness_unknown",
] as const;
export type ComputedExpiryReason = (typeof COMPUTED_EXPIRY_REASONS)[number];

/**
 * The deadline a rule version yields for one bucket: a derivation, kept apart
 * from the provider's display. `date` carries a calendar day in the rule's own
 * calendar; `no-expiry` is only reachable from verified, open-ended terms of
 * family `none`; `unavailable` carries exactly one closed reason.
 */
export interface ComputedExpiry {
  status: ComputedExpiryStatus;
  value: LocalDateValue | null;
  reasonCode: ComputedExpiryReason | null;
  rule: ExpiryRuleBasis;
  activity: ExpiryActivityBasis | null;
  membership: ExpiryMembershipBasis | null;
  /** Conditions that qualify the result without preventing it (an assumed zone, an older gap). */
  uncertaintyCodes: string[];
  release: string;
}

export const EXPIRY_AGREEMENTS = ["agree", "disagree", "not-comparable"] as const;
export type ExpiryAgreement = (typeof EXPIRY_AGREEMENTS)[number];

/** Both sides of one bucket's deadline, and whether they agree. */
export interface BucketExpiryBasis {
  displayed: DisplayedExpiry | null;
  computed: ComputedExpiry;
  agreement: ExpiryAgreement;
}

export interface ExpiringBucket {
  bucketRef: string;
  quantity: Quantity;
  /**
   * The deadline shown first in a deadline-ordered list: the provider's
   * readable display, else the computed date, else `unknown`. It is a
   * presentation choice; `expiryBasis` keeps both sides apart.
   */
  deadline: TemporalValue;
  basis: DeadlineBasis;
  providerObserved: TemporalValue | null;
  /** The computed date, exactly `expiryBasis.computed.value`. */
  policyEstimated: TemporalValue | null;
  reasonCodes: string[];
  expiryBasis: BucketExpiryBasis;
}

export interface ExpiryEstimate {
  holdingRef: string;
  ruleRef: string;
  contextId: string;
  state: ExpiryEstimateState;
  expiringBuckets: ExpiringBucket[];
  uncertaintyCodes: string[];
  sourceExpiryRefs: string[];
  release: string;
}

/** Every reason code this module can attach; the UI renders text for each. */
export const REWARD_UNCERTAINTY_CODES = [
  "history_incomplete",
  "history_completeness_unknown",
  "no_qualifying_activity_observed",
  "rule_not_verified",
  "rule_family_unsupported",
  "rule_out_of_force",
  "rule_bucket_kind_not_covered",
  "membership_required",
  "membership_self_reported",
  "membership_not_retroactive",
  "membership_out_of_scope",
  "deadline_zone_assumed",
  "provider_and_policy_differ",
  "provider_expiry_only",
  "no_expiry_under_verified_terms",
  "acquisition_date_unknown",
  "activity_date_unknown",
  "deadline_passed",
  "rule_transition_unconfirmed",
] as const;
export type RewardUncertaintyCode = (typeof REWARD_UNCERTAINTY_CODES)[number];

// ── conversion offers ────────────────────────────────────────────────

export interface ConversionOffer {
  offerId: string;
  version: string;
  sourceProgramRef: string;
  destinationProgramRef: string;
  fromUnitRef: string;
  toUnitRef: string;
  /** Exact integers; a decimal "rate" would lose the provider's own wording. */
  ratio: ExactRatio;
  minimum: ExactDecimal;
  increment: ExactDecimal;
  maximumPerRequest: ExactDecimal | null;
  /** Offers sharing a quota cannot both be used inside one plan. */
  sharedQuotaRef: string | null;
  fixedFees: Quantity[];
  variableFeePolicyRef: string | null;
  eligibilityPolicyRef: string;
  /** Bucket kinds and restriction refs the eligibility policy admits. */
  eligibleBucketKinds: readonly BucketKind[];
  eligibleRestrictionRefs: readonly string[];
  /** Tiers the offer is open to; `null` means every tier. */
  eligibleTiers: readonly string[] | null;
  validTime: TemporalValue;
  applicationDeadline: TemporalValue;
  processingPolicyRef: string;
  /** Calendar days between an accepted application and the destination credit. */
  processingDays: number;
  roundingPolicyRef: string;
  rounding: Rounding;
  cancellationPolicyRef: string | null;
  evidenceRefs: string[];
  verification: RuleVerification;
}

export const OFFER_ELIGIBILITY_STATES = [
  "available",
  "not-eligible",
  "needs-rule-verification",
] as const;
export type OfferEligibilityState = (typeof OFFER_ELIGIBILITY_STATES)[number];

export interface OfferEligibility {
  offerRef: string;
  state: OfferEligibilityState;
  /** Sum of the eligible buckets, in the offer's source unit. */
  eligible: Quantity;
  eligibleBucketRefs: string[];
  excluded: { bucketRef: string; reasonCode: string }[];
  uncertaintyCodes: string[];
}

export interface ConversionPlan {
  offerRef: string;
  offerVersion: string;
  use: Quantity;
  receive: Quantity;
  remainder: Quantity;
  fees: Quantity[];
  feasible: boolean;
  reasonCodes: string[];
  /** Always a policy estimate: an application is not a credit. */
  basis: "policy-estimated";
  conditionRefs: string[];
  release: string;
}

export const CONVERSION_REASON_CODES = [
  "below_minimum",
  "capped_by_maximum",
  "rounded_down_to_increment",
  "unit_mismatch",
  "quantity_not_exact",
  "offer_not_verified",
  "credit_is_not_the_application",
] as const;

// ── redemption lifecycle ─────────────────────────────────────────────

export const REDEMPTION_STAGES = [
  "requested",
  "debited",
  "credited",
  "cancelled",
  "returned",
] as const;
export type RedemptionStage = (typeof REDEMPTION_STAGES)[number];

export interface RedemptionEvent {
  eventRef: string;
  stage: RedemptionStage;
  /** Source-unit for request/debit/cancel, destination-unit for a credit, source-unit for a return. */
  quantity: Quantity;
  /** Where a return landed; a return creates a bucket, it never revives the debited one. */
  returnedToBucketRef: string | null;
  at: TemporalValue;
  evidenceRefs: string[];
}

export interface RedemptionPosition {
  stage: RedemptionStage;
  /** Still in the source program's buckets. */
  sourceHeld: Quantity;
  /** Debited but not yet observed on the destination side. */
  inTransit: Quantity;
  /** Observed on the destination side, in the destination unit. */
  destinationCredited: Quantity;
  uncertaintyCodes: string[];
}

export interface RedemptionTrace {
  positions: RedemptionPosition[];
  violations: string[];
  /** Return claims: each is a new bucket with its own kind and observed expiry. */
  returnedBuckets: { bucketRef: string; quantity: Quantity; eventRef: string }[];
}

// ── value model (addendum 08 §7) ─────────────────────────────────────

export const REWARD_VALUE_KINDS = [
  "provider-displayed",
  "cash-like-redemption-estimate",
  "planned-redemption-estimate",
  "realized-benefit-estimate",
] as const;
export type RewardValueKind = (typeof REWARD_VALUE_KINDS)[number];

/**
 * No reward value ever joins an asset subtotal: `netAssetEligible` is the
 * literal `false`, exactly as in the metric registry. A cash-like estimate
 * exists only with a named offer and carries the conditions that produced it.
 */
export interface RewardValueClaim {
  kind: RewardValueKind;
  quantity: Quantity;
  offerRef: string | null;
  conditionRefs: string[];
  netAssetEligible: false;
  sourceAuthority: "provider-reported" | "policy-estimated";
}

// ── validators ───────────────────────────────────────────────────────

const REF = (value: unknown): value is string => isText(value, 512);

export function validRewardProgram(value: unknown): value is RewardProgram {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "programId",
      "institutionRef",
      "programRef",
      "unitRef",
      "termsEvidenceRefs",
      "release",
    ]) &&
    REF(value.programId) &&
    REF(value.institutionRef) &&
    REF(value.programRef) &&
    isText(value.unitRef, 128) &&
    isRefList(value.termsEvidenceRefs, 100) &&
    isText(value.release, 64)
  );
}

export function validRewardBucket(value: unknown): value is RewardBucket {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "bucketRef",
      "programId",
      "holdingRef",
      "kind",
      "restrictionRefs",
      "quantity",
      "observedExpiry",
      "observedAt",
      "sourceFactRefs",
    ]) &&
    REF(value.bucketRef) &&
    REF(value.programId) &&
    REF(value.holdingRef) &&
    isOneOf(BUCKET_KINDS)(value.kind) &&
    isRefList(value.restrictionRefs, 100) &&
    validQuantity(value.quantity) &&
    (value.observedExpiry === null || validTemporalValue(value.observedExpiry)) &&
    validTemporalValue(value.observedAt) &&
    isRefList(value.sourceFactRefs, 100)
  );
}

export function validQualificationMeasure(value: unknown): value is QualificationMeasure {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "measureRef",
      "programId",
      "metricRef",
      "quantity",
      "period",
      "consumable",
      "sourceFactRefs",
    ]) &&
    REF(value.measureRef) &&
    REF(value.programId) &&
    REF(value.metricRef) &&
    validQuantity(value.quantity) &&
    validTemporalValue(value.period) &&
    value.consumable === false &&
    isRefList(value.sourceFactRefs, 100)
  );
}

export function validMembershipState(value: unknown): value is MembershipState {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["programId", "holdingRef", "tier", "valid", "source", "evidenceRefs"]) &&
    REF(value.programId) &&
    REF(value.holdingRef) &&
    isText(value.tier, 128) &&
    validTemporalValue(value.valid) &&
    isOneOf(MEMBERSHIP_SOURCES)(value.source) &&
    isRefList(value.evidenceRefs, 100)
  );
}

function validDeadlineCalendar(value: unknown): value is DeadlineCalendar {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["zone", "dayBoundary", "zoneBasis"]) &&
    validZone(value.zone) &&
    isOneOf(["end-of-day", "start-of-day"] as const)(value.dayBoundary) &&
    isOneOf(["documented", "assumed"] as const)(value.zoneBasis)
  );
}

function validQualifyingActivityPolicy(value: unknown): value is QualifyingActivityPolicy {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "policyRef",
      "kinds",
      "excludedKinds",
      "extensionMonths",
      "endOfMonthPolicy",
      "dateBasis",
    ]) &&
    REF(value.policyRef) &&
    isRefList(value.kinds, 100) &&
    isRefList(value.excludedKinds, 100) &&
    isSafeInt(value.extensionMonths, 1, 1200) &&
    isOneOf(["clamp", "preserve-end-of-month"] as const)(value.endOfMonthPolicy) &&
    isOneOf(["provider-posted", "member-used"] as const)(value.dateBasis)
  );
}

export function validExpiryRule(value: unknown): value is ExpiryRule {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ruleId",
      "version",
      "family",
      "programId",
      "applicability",
      "qualifyingActivity",
      "deadlineCalendar",
      "priorityPolicyRef",
      "evidenceRefs",
      "verification",
    ])
  )
    return false;
  const applicability = value.applicability;
  return (
    REF(value.ruleId) &&
    isText(value.version, 64) &&
    isOneOf(EXPIRY_FAMILIES)(value.family) &&
    REF(value.programId) &&
    isRecord(applicability) &&
    hasExactKeys(applicability, ["bucketKinds", "tiers", "validPeriod"]) &&
    isArrayOf(isOneOf(BUCKET_KINDS), 10)(applicability.bucketKinds) &&
    (applicability.tiers === null || isRefList(applicability.tiers, 100)) &&
    (applicability.validPeriod === null || validTemporalValue(applicability.validPeriod)) &&
    (value.qualifyingActivity === null ||
      validQualifyingActivityPolicy(value.qualifyingActivity)) &&
    validDeadlineCalendar(value.deadlineCalendar) &&
    isTextOrNull(value.priorityPolicyRef, 512) &&
    isRefList(value.evidenceRefs, 100) &&
    isOneOf(RULE_VERIFICATIONS)(value.verification)
  );
}

function validDisplayedExpiry(value: unknown): value is DisplayedExpiry {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["value", "observedAt", "sourceFactRefs"]) &&
    validTemporalValue(value.value) &&
    validTemporalValue(value.observedAt) &&
    isRefList(value.sourceFactRefs, 100)
  );
}

function validExpiryRuleBasis(value: unknown): value is ExpiryRuleBasis {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "ruleRef",
      "ruleId",
      "version",
      "family",
      "verification",
      "validPeriod",
      "evidenceRefs",
      "qualifyingActivityPolicyRef",
      "deadlineCalendar",
    ]) &&
    REF(value.ruleRef) &&
    REF(value.ruleId) &&
    isText(value.version, 64) &&
    value.ruleRef === `${value.ruleId}@${value.version}` &&
    isOneOf(EXPIRY_FAMILIES)(value.family) &&
    isOneOf(RULE_VERIFICATIONS)(value.verification) &&
    (value.validPeriod === null || validTemporalValue(value.validPeriod)) &&
    isRefList(value.evidenceRefs, 100) &&
    isTextOrNull(value.qualifyingActivityPolicyRef, 512) &&
    validDeadlineCalendar(value.deadlineCalendar)
  );
}

function validLocalDate(value: unknown): value is LocalDateValue {
  return validTemporalValue(value) && value.kind === "local-date";
}

function validExpiryActivityBasis(value: unknown): value is ExpiryActivityBasis {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "windowRef",
      "completeness",
      "earliestObserved",
      "anchorActivityRef",
      "anchorDate",
    ]) &&
    REF(value.windowRef) &&
    isOneOf(HISTORY_COMPLETENESS)(value.completeness) &&
    (value.earliestObserved === null || validTemporalValue(value.earliestObserved)) &&
    isTextOrNull(value.anchorActivityRef, 512) &&
    (value.anchorDate === null || validLocalDate(value.anchorDate)) &&
    (value.anchorActivityRef === null) === (value.anchorDate === null)
  );
}

function validExpiryMembershipBasis(value: unknown): value is ExpiryMembershipBasis {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["requiredTiers", "claims"]) &&
    isRefList(value.requiredTiers, 100) &&
    isArrayOf(
      (claim: unknown): claim is ExpiryMembershipClaimBasis =>
        isRecord(claim) &&
        hasExactKeys(claim, ["tier", "source", "valid", "evidenceRefs"]) &&
        isText(claim.tier, 128) &&
        isOneOf(MEMBERSHIP_SOURCES)(claim.source) &&
        validTemporalValue(claim.valid) &&
        isRefList(claim.evidenceRefs, 100),
      100,
    )(value.claims)
  );
}

function validComputedExpiry(value: unknown): value is ComputedExpiry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "status",
      "value",
      "reasonCode",
      "rule",
      "activity",
      "membership",
      "uncertaintyCodes",
      "release",
    ]) ||
    !isOneOf(COMPUTED_EXPIRY_STATUSES)(value.status) ||
    !(value.value === null || validLocalDate(value.value)) ||
    !(value.reasonCode === null || isOneOf(COMPUTED_EXPIRY_REASONS)(value.reasonCode))
  )
    return false;
  // The three statuses are exclusive: a date has no reason, a reason has no
  // date, and "no expiry" has neither — it is never a missing value.
  const shape =
    value.status === "date"
      ? value.value !== null && value.reasonCode === null
      : value.status === "no-expiry"
        ? value.value === null && value.reasonCode === null
        : value.value === null && value.reasonCode !== null;
  return (
    shape &&
    validExpiryRuleBasis(value.rule) &&
    (value.activity === null || validExpiryActivityBasis(value.activity)) &&
    (value.membership === null || validExpiryMembershipBasis(value.membership)) &&
    isRefList(value.uncertaintyCodes, 100) &&
    isText(value.release, 64)
  );
}

/** The wire and storage shape of one bucket's displayed and computed expiry. */
export function validBucketExpiryBasis(value: unknown): value is BucketExpiryBasis {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["displayed", "computed", "agreement"]) &&
    (value.displayed === null || validDisplayedExpiry(value.displayed)) &&
    validComputedExpiry(value.computed) &&
    isOneOf(EXPIRY_AGREEMENTS)(value.agreement) &&
    // Agreement needs two sides: no display, or no computed answer, is never "agree".
    (value.agreement === "not-comparable" ||
      (value.displayed !== null && value.computed.status !== "unavailable"))
  );
}

export function validConversionOffer(value: unknown): value is ConversionOffer {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "offerId",
      "version",
      "sourceProgramRef",
      "destinationProgramRef",
      "fromUnitRef",
      "toUnitRef",
      "ratio",
      "minimum",
      "increment",
      "maximumPerRequest",
      "sharedQuotaRef",
      "fixedFees",
      "variableFeePolicyRef",
      "eligibilityPolicyRef",
      "eligibleBucketKinds",
      "eligibleRestrictionRefs",
      "eligibleTiers",
      "validTime",
      "applicationDeadline",
      "processingPolicyRef",
      "processingDays",
      "roundingPolicyRef",
      "rounding",
      "cancellationPolicyRef",
      "evidenceRefs",
      "verification",
    ]) &&
    REF(value.offerId) &&
    isText(value.version, 64) &&
    REF(value.sourceProgramRef) &&
    REF(value.destinationProgramRef) &&
    isText(value.fromUnitRef, 128) &&
    isText(value.toUnitRef, 128) &&
    validExactRatio(value.ratio) &&
    validExactDecimal(value.minimum) &&
    validExactDecimal(value.increment) &&
    (value.maximumPerRequest === null || validExactDecimal(value.maximumPerRequest)) &&
    isTextOrNull(value.sharedQuotaRef, 512) &&
    isArrayOf(validQuantity, 20)(value.fixedFees) &&
    isTextOrNull(value.variableFeePolicyRef, 512) &&
    REF(value.eligibilityPolicyRef) &&
    isArrayOf(isOneOf(BUCKET_KINDS), 10)(value.eligibleBucketKinds) &&
    isRefList(value.eligibleRestrictionRefs, 100) &&
    (value.eligibleTiers === null || isRefList(value.eligibleTiers, 100)) &&
    validTemporalValue(value.validTime) &&
    validTemporalValue(value.applicationDeadline) &&
    REF(value.processingPolicyRef) &&
    isSafeInt(value.processingDays, 0, 3650) &&
    REF(value.roundingPolicyRef) &&
    validRounding(value.rounding) &&
    isTextOrNull(value.cancellationPolicyRef, 512) &&
    isRefList(value.evidenceRefs, 100) &&
    isOneOf(RULE_VERIFICATIONS)(value.verification)
  );
}

// ── holding summary: consumable quantity apart from qualification ────

export interface RewardHoldingSummary {
  holdingRef: string;
  programId: string;
  unitRef: string;
  /** Sum of the consumable buckets only, in the program's own unit. */
  consumable: Quantity;
  /** Per-kind subtotals; `pending-award` and `qualification` stay outside `consumable`. */
  byKind: { kind: BucketKind; quantity: Quantity; bucketRefs: string[] }[];
  /** Buckets deliberately left out of `consumable`, each with its reason. */
  excluded: { bucketRef: string; kind: BucketKind; reasonCode: string }[];
  qualificationMeasures: QualificationMeasure[];
  uncertaintyCodes: string[];
  error: ValueError | null;
}

function bucketError(quantities: readonly Quantity[], unitRef: string): ValueError | null {
  const summed = sumQuantities(unitRef, quantities);
  return summed.ok ? null : summed.error;
}

/**
 * A holding's consumable quantity and its qualification measures, never mixed.
 * A holding with no consumable bucket reports an exact zero only because the
 * bucket list itself is the complete observed set; an unparsed bucket makes
 * the whole sum an error rather than a smaller number (INV05).
 */
export function summarizeHolding(
  holding: RewardHolding,
  qualifications: readonly QualificationMeasure[] = [],
): RewardHoldingSummary {
  const uncertaintyCodes: string[] = [];
  const excluded: RewardHoldingSummary["excluded"] = [];
  const consumableBuckets: RewardBucket[] = [];
  for (const bucket of holding.buckets) {
    if (bucket.quantity.unitRef !== holding.unitRef) {
      excluded.push({
        bucketRef: bucket.bucketRef,
        kind: bucket.kind,
        reasonCode: "unit_mismatch",
      });
      continue;
    }
    if (CONSUMABLE_BUCKET_KINDS.includes(bucket.kind)) consumableBuckets.push(bucket);
    else
      excluded.push({
        bucketRef: bucket.bucketRef,
        kind: bucket.kind,
        reasonCode:
          bucket.kind === "qualification" ? "qualification_not_consumable" : "award_not_yet_held",
      });
  }
  const byKind: RewardHoldingSummary["byKind"] = [];
  for (const kind of BUCKET_KINDS) {
    const group = holding.buckets.filter(
      (bucket) => bucket.kind === kind && bucket.quantity.unitRef === holding.unitRef,
    );
    if (group.length === 0) continue;
    const summed = sumQuantities(
      holding.unitRef,
      group.map((bucket) => bucket.quantity),
    );
    byKind.push({
      kind,
      quantity: summed.ok
        ? summed.quantity
        : {
            unitRef: holding.unitRef,
            value: { status: "conflict", reasonCode: summed.error.code },
          },
      bucketRefs: group.map((bucket) => bucket.bucketRef),
    });
  }
  const error = bucketError(
    consumableBuckets.map((bucket) => bucket.quantity),
    holding.unitRef,
  );
  const summed = sumQuantities(
    holding.unitRef,
    consumableBuckets.map((bucket) => bucket.quantity),
  );
  const measures = qualifications.filter((measure) => measure.programId === holding.programId);
  if (measures.length > 0) uncertaintyCodes.push("qualification_measures_reported_separately");
  return {
    holdingRef: holding.holdingRef,
    programId: holding.programId,
    unitRef: holding.unitRef,
    consumable: summed.ok
      ? summed.quantity
      : { unitRef: holding.unitRef, value: { status: "conflict", reasonCode: summed.error.code } },
    byKind,
    excluded,
    qualificationMeasures: measures,
    uncertaintyCodes,
    error,
  };
}

/** Qualification measures of a holding, always outside its consumable quantity. */
export function qualificationMeasures(
  holding: RewardHolding,
  measures: readonly QualificationMeasure[],
): QualificationMeasure[] {
  const fromBuckets = holding.buckets
    .filter((bucket) => bucket.kind === "qualification")
    .map((bucket): QualificationMeasure => ({
      measureRef: bucket.bucketRef,
      programId: bucket.programId,
      metricRef: "reward.qualification-measure",
      quantity: bucket.quantity,
      period: bucket.observedAt,
      consumable: false,
      sourceFactRefs: bucket.sourceFactRefs,
    }));
  return [...fromBuckets, ...measures.filter((m) => m.programId === holding.programId)];
}

// ── expiry estimation ────────────────────────────────────────────────

function localDate(value: TemporalValue): CivilDate | null {
  if (value.kind === "local-date") return parseLocalDate(value.value);
  if (value.kind === "instant") return parseLocalDate(value.value.slice(0, 10));
  return null;
}

function asLocalDate(date: CivilDate, zone: string): LocalDateValue {
  return { kind: "local-date", value: formatLocalDate(date), zone, basis: "derived" };
}

function activityDate(activity: RewardActivity, basis: QualifyingActivityPolicy["dateBasis"]) {
  return basis === "member-used" ? (activity.usedDate ?? activity.postedDate) : activity.postedDate;
}

function push(codes: string[], code: string): void {
  if (!codes.includes(code)) codes.push(code);
}

/**
 * Whether a stated period (or single day) covers a calendar day. A value that
 * names no day — unknown, or an instant — covers nothing: an unreadable
 * period is never read as "always".
 */
function coversDay(value: TemporalValue, day: CivilDate): boolean {
  if (value.kind === "period") return periodContainsDate(value, day);
  if (value.kind === "local-date") {
    const date = parseLocalDate(value.value);
    return date !== null && daysFromCivil(date) === daysFromCivil(day);
  }
  return false;
}

/** A rule version is in force on a day when it is open-ended or its period covers the day. */
function versionInForce(rule: ExpiryRule, day: CivilDate | null): boolean {
  const period = rule.applicability.validPeriod;
  if (period === null) return true;
  return day !== null && coversDay(period, day);
}

function ruleBasis(rule: ExpiryRule): ExpiryRuleBasis {
  return {
    ruleRef: `${rule.ruleId}@${rule.version}`,
    ruleId: rule.ruleId,
    version: rule.version,
    family: rule.family,
    verification: rule.verification,
    validPeriod: rule.applicability.validPeriod,
    evidenceRefs: [...new Set(rule.evidenceRefs)],
    qualifyingActivityPolicyRef: rule.qualifyingActivity?.policyRef ?? null,
    deadlineCalendar: { ...rule.deadlineCalendar },
  };
}

/** Displayed against computed: only two calendar answers can agree or disagree. */
function agreementOf(displayed: DisplayedExpiry | null, computed: ComputedExpiry): ExpiryAgreement {
  if (displayed === null || displayed.value.kind === "unknown") return "not-comparable";
  if (computed.status === "no-expiry")
    // Verified terms say there is no deadline and the provider shows one.
    return "disagree";
  if (computed.value === null) return "not-comparable";
  const order = compareTemporal(displayed.value, computed.value);
  if (order.kind === "incomparable") return "not-comparable";
  return order.order === 0 ? "agree" : "disagree";
}

/**
 * The deadline of a holding under one rule version, with the provider's
 * display and the computed answer kept apart per bucket.
 *
 * The displayed side is the claim's own observation and is never changed
 * here. The computed side is a derivation from the rule version, the
 * activity history and the membership claims, and it says which of each it
 * used. It yields a date only when every input the rule needs is present:
 *
 *   * the rule is verified, of a family with a calculation, in force on the
 *     evaluation day and applicable to the bucket's kind;
 *   * for an inactivity rule, the anchor is the newest *qualifying* activity,
 *     never `max(activity date)`: a kind the rule excludes (a family transfer)
 *     is dropped even when it is the most recent row; an activity whose date
 *     cannot be read, a history of unknown completeness, or no qualifying
 *     activity at all leaves the date unavailable;
 *   * a tier-gated rule needs a claim of a required tier covering the anchor;
 *     a tier granted later is never applied backwards;
 *   * the anchor and the deadline both lie inside the version's own period.
 *     How a later version treats a deadline that crosses the boundary is not
 *     recorded, so it is not guessed.
 *
 * Otherwise the computed side is `unavailable` with one closed reason. An
 * unverified or unsupported rule is never reported as "no expiry"; a
 * disagreement between display and computation makes the estimate
 * `conflict` and both dates are returned.
 */
export function estimateExpiry(
  rule: ExpiryRule,
  holding: RewardHolding,
  activity: ActivityHistory,
  membership: readonly MembershipState[],
  clock: TemporalValue,
  contextId = "context:unbound",
): ExpiryEstimate {
  const uncertaintyCodes: string[] = [];
  // Codes about the inputs a computation consumed; copied onto the basis of
  // every bucket the rule computes for, less the bucket's own reason code.
  const derivationCodes: string[] = [];
  const sourceExpiryRefs: string[] = [];
  const zone = rule.deadlineCalendar.zone;
  const now = localDate(clock);
  const basisOfRule = ruleBasis(rule);
  if (rule.deadlineCalendar.zoneBasis === "assumed") {
    push(uncertaintyCodes, "deadline_zone_assumed");
    push(derivationCodes, "deadline_zone_assumed");
  }

  // 1. The rule version itself. A failure here applies to every bucket and
  //    makes the whole estimate needs-rule-verification.
  let ruleFailure: ComputedExpiryReason | null = null;
  if (rule.verification !== "verified") ruleFailure = "rule_not_verified";
  else if (rule.family === "unsupported") ruleFailure = "rule_family_unsupported";
  else if (!versionInForce(rule, now)) ruleFailure = "rule_out_of_force";
  else if (rule.family === "inactivity" && !rule.qualifyingActivity)
    ruleFailure = "qualifying_activity_policy_missing";
  if (ruleFailure !== null)
    push(
      uncertaintyCodes,
      ruleFailure === "qualifying_activity_policy_missing"
        ? "rule_family_unsupported"
        : ruleFailure,
    );

  // 2. Membership: only a tier-gated rule consumes it.
  const tiers = rule.applicability.tiers;
  const matching =
    tiers === null
      ? []
      : membership.filter(
          (state) =>
            state.programId === holding.programId &&
            state.holdingRef === holding.holdingRef &&
            tiers.includes(state.tier),
        );
  const membershipBasis: ExpiryMembershipBasis | null =
    tiers === null
      ? null
      : {
          requiredTiers: [...new Set(tiers)],
          claims: matching.map((state) => ({
            tier: state.tier,
            source: state.source,
            valid: state.valid,
            evidenceRefs: [...new Set(state.evidenceRefs)],
          })),
        };
  const outOfScope = ruleFailure === null && tiers !== null && matching.length === 0;
  if (outOfScope) {
    push(uncertaintyCodes, "membership_out_of_scope");
    push(derivationCodes, "membership_out_of_scope");
  }
  if (ruleFailure === null && tiers !== null && matching.length > 0) {
    push(uncertaintyCodes, "membership_required");
    push(derivationCodes, "membership_required");
  }

  // 3. Activity: only an inactivity rule consumes it.
  let anchor: CivilDate | null = null;
  let anchorRef: string | null = null;
  let activityFailure: ComputedExpiryReason | null = null;
  let activityBasis: ExpiryActivityBasis | null = null;
  let notRetroactive = false;
  if (ruleFailure === null && rule.family === "inactivity" && rule.qualifyingActivity) {
    const policy = rule.qualifyingActivity;
    let undated = false;
    for (const item of activity.activities) {
      if (policy.excludedKinds.includes(item.kind)) continue;
      if (!policy.kinds.includes(item.kind)) continue;
      const date = localDate(activityDate(item, policy.dateBasis));
      if (!date) {
        undated = true;
        push(uncertaintyCodes, "activity_date_unknown");
        push(derivationCodes, "activity_date_unknown");
        continue;
      }
      const later = anchor === null || daysFromCivil(date) > daysFromCivil(anchor);
      const tie =
        anchor !== null &&
        daysFromCivil(date) === daysFromCivil(anchor) &&
        anchorRef !== null &&
        item.activityRef < anchorRef;
      if (later || tie) {
        anchor = date;
        anchorRef = item.activityRef;
      }
    }
    if (!anchor) {
      push(uncertaintyCodes, "no_qualifying_activity_observed");
      push(derivationCodes, "no_qualifying_activity_observed");
    }
    if (activity.completeness === "partial") {
      // The window's older end is unobserved; the newest qualifying activity
      // inside it is still the newest one.
      push(uncertaintyCodes, "history_incomplete");
      push(derivationCodes, "history_incomplete");
    }
    if (activity.completeness === "unknown") {
      push(uncertaintyCodes, "history_completeness_unknown");
      push(derivationCodes, "history_completeness_unknown");
    }
    activityFailure = undated
      ? "activity_date_unknown"
      : !anchor
        ? "no_qualifying_activity_observed"
        : activity.completeness === "unknown"
          ? "history_completeness_unknown"
          : null;
    activityBasis = {
      windowRef: activity.windowRef,
      completeness: activity.completeness,
      earliestObserved: activity.earliestObserved,
      anchorActivityRef: anchorRef,
      anchorDate: anchor ? asLocalDate(anchor, zone) : null,
    };
    // A tier that only starts after the anchor cannot have shaped it.
    if (anchor && tiers !== null && matching.length > 0) {
      const day = anchor;
      const covering = matching.filter((state) => coversDay(state.valid, day));
      if (covering.length === 0) {
        notRetroactive = true;
        push(uncertaintyCodes, "membership_not_retroactive");
        push(derivationCodes, "membership_not_retroactive");
      } else if (!covering.some((state) => state.source === "provider")) {
        push(uncertaintyCodes, "membership_self_reported");
        push(derivationCodes, "membership_self_reported");
      }
    }
  }
  if (
    ruleFailure === null &&
    rule.family === "none" &&
    matching.length > 0 &&
    !matching.some((state) => state.source === "provider")
  ) {
    push(uncertaintyCodes, "membership_self_reported");
    push(derivationCodes, "membership_self_reported");
  }

  const computedFor = (bucket: RewardBucket): ComputedExpiry => {
    let reasonCode: ComputedExpiryReason | null = ruleFailure;
    let status: ComputedExpiryStatus = "unavailable";
    let value: LocalDateValue | null = null;
    if (reasonCode === null && !rule.applicability.bucketKinds.includes(bucket.kind))
      reasonCode = "rule_bucket_kind_not_covered";
    if (reasonCode === null) {
      if (rule.family === "fixed-lot" || rule.family === "fixed-account")
        // The provider's own per-lot date is the only evidence of the lot's
        // deadline; no acquisition date is invented from a bucket total.
        reasonCode = "fixed_deadline_not_derivable";
      else if (rule.family === "none") {
        // "No expiry" is a claim about the version's terms; a version with an
        // end cannot say what happens after it.
        if (outOfScope) reasonCode = "membership_out_of_scope";
        else if (rule.applicability.validPeriod !== null)
          reasonCode = "rule_transition_unconfirmed";
        else status = "no-expiry";
      } else if (outOfScope) reasonCode = "membership_out_of_scope";
      else if (activityFailure !== null) reasonCode = activityFailure;
      else if (notRetroactive) reasonCode = "membership_not_retroactive";
      else if (!anchor || !rule.qualifyingActivity) reasonCode = "no_qualifying_activity_observed";
      else {
        const deadline = addMonths(
          anchor,
          rule.qualifyingActivity.extensionMonths,
          rule.qualifyingActivity.endOfMonthPolicy,
        );
        if (!versionInForce(rule, anchor) || !versionInForce(rule, deadline))
          reasonCode = "rule_transition_unconfirmed";
        else {
          value = asLocalDate(deadline, zone);
          status = "date";
        }
      }
    }
    // Activity and membership are facts this bucket's answer consumed only
    // when the rule computes for it at all: a rule-level failure, a kind the
    // version does not cover and a fixed-lot rule consume neither.
    const consumed =
      ruleFailure === null &&
      reasonCode !== "rule_bucket_kind_not_covered" &&
      (rule.family === "inactivity" || rule.family === "none");
    return {
      status,
      value,
      reasonCode,
      rule: basisOfRule,
      activity: consumed && rule.family === "inactivity" ? activityBasis : null,
      membership: consumed ? membershipBasis : null,
      uncertaintyCodes: consumed ? derivationCodes.filter((code) => code !== reasonCode) : [],
      release: EXPIRY_DERIVATION_RELEASE,
    };
  };

  const expiringBuckets: ExpiringBucket[] = [];
  let conflict = false;
  let undetermined = false;
  for (const bucket of holding.buckets) {
    if (bucket.kind === "qualification") continue;
    const displayed: DisplayedExpiry | null = bucket.observedExpiry
      ? {
          value: bucket.observedExpiry,
          observedAt: bucket.observedAt,
          sourceFactRefs: [...new Set(bucket.sourceFactRefs)],
        }
      : null;
    if (displayed) sourceExpiryRefs.push(...bucket.sourceFactRefs);
    const computed = computedFor(bucket);
    const agreement = agreementOf(displayed, computed);
    const reasonCodes: string[] = [];
    if (computed.reasonCode !== null) push(reasonCodes, computed.reasonCode);
    if (computed.status === "no-expiry") push(reasonCodes, "no_expiry_under_verified_terms");
    if (computed.reasonCode === "rule_bucket_kind_not_covered")
      push(uncertaintyCodes, "rule_bucket_kind_not_covered");
    if (computed.reasonCode === "rule_transition_unconfirmed")
      push(uncertaintyCodes, "rule_transition_unconfirmed");
    if (computed.reasonCode === "fixed_deadline_not_derivable" && !displayed) {
      push(reasonCodes, "acquisition_date_unknown");
      push(uncertaintyCodes, "acquisition_date_unknown");
    }
    if (displayed && computed.status === "unavailable") push(reasonCodes, "provider_expiry_only");
    if (agreement === "disagree") {
      conflict = true;
      push(reasonCodes, "provider_and_policy_differ");
      push(uncertaintyCodes, "provider_and_policy_differ");
    }
    // The deadline a list is ordered by: a readable display first, then the
    // computed date. An unreadable display is not a date.
    const readable = displayed !== null && displayed.value.kind !== "unknown";
    const deadline: TemporalValue = readable
      ? displayed.value
      : (computed.value ??
        displayed?.value ?? {
          kind: "unknown",
          reasonCode:
            computed.status === "no-expiry"
              ? "no_expiry_under_verified_terms"
              : (computed.reasonCode ?? "expiry_not_determined"),
        });
    const basis: DeadlineBasis = readable
      ? "provider-observed"
      : computed.value
        ? "policy-estimated"
        : displayed
          ? "provider-observed"
          : "unknown";
    // A deadline is only ever "passed" on a day some basis established.
    if (now && deadline.kind === "local-date") {
      const parsed = parseLocalDate(deadline.value);
      if (parsed && daysFromCivil(parsed) < daysFromCivil(now)) {
        push(reasonCodes, "deadline_passed");
        push(uncertaintyCodes, "deadline_passed");
      }
    }
    if (
      ruleFailure === null &&
      computed.reasonCode !== "rule_bucket_kind_not_covered" &&
      computed.status !== "no-expiry" &&
      deadline.kind === "unknown"
    )
      undetermined = true;
    expiringBuckets.push({
      bucketRef: bucket.bucketRef,
      quantity: bucket.quantity,
      deadline,
      basis,
      providerObserved: bucket.observedExpiry,
      policyEstimated: computed.value,
      reasonCodes,
      expiryBasis: { displayed, computed, agreement },
    });
  }
  if (ruleFailure === null && rule.family === "none" && !outOfScope)
    push(uncertaintyCodes, "no_expiry_under_verified_terms");

  const partial =
    undetermined ||
    outOfScope ||
    notRetroactive ||
    uncertaintyCodes.includes("history_incomplete") ||
    uncertaintyCodes.includes("history_completeness_unknown") ||
    uncertaintyCodes.includes("no_qualifying_activity_observed") ||
    uncertaintyCodes.includes("acquisition_date_unknown") ||
    uncertaintyCodes.includes("activity_date_unknown") ||
    uncertaintyCodes.includes("rule_transition_unconfirmed");
  const state: ExpiryEstimateState =
    ruleFailure !== null
      ? "needs-rule-verification"
      : conflict
        ? "conflict"
        : partial
          ? "partial"
          : "computed";
  return {
    holdingRef: holding.holdingRef,
    ruleRef: `${rule.ruleId}@${rule.version}`,
    contextId,
    state,
    expiringBuckets,
    uncertaintyCodes,
    sourceExpiryRefs: [...new Set(sourceExpiryRefs)],
    release: REWARD_POLICY_RELEASE,
  };
}

// ── offer eligibility ────────────────────────────────────────────────

/**
 * Which buckets one offer accepts. A restricted bucket is excluded because its
 * restriction is not in the offer's eligibility policy, not because it is
 * small; the excluded quantity is reported, never silently added.
 */
export function availableForOffer(
  buckets: readonly RewardBucket[],
  offer: ConversionOffer,
  membership: readonly MembershipState[] = [],
  clock?: TemporalValue,
): OfferEligibility {
  const uncertaintyCodes: string[] = [];
  const excluded: OfferEligibility["excluded"] = [];
  const eligible: RewardBucket[] = [];
  for (const bucket of buckets) {
    if (bucket.quantity.unitRef !== offer.fromUnitRef) {
      excluded.push({ bucketRef: bucket.bucketRef, reasonCode: "unit_mismatch" });
      continue;
    }
    if (bucket.kind === "qualification" || bucket.kind === "pending-award") {
      excluded.push({ bucketRef: bucket.bucketRef, reasonCode: "not_consumable" });
      continue;
    }
    if (!offer.eligibleBucketKinds.includes(bucket.kind)) {
      excluded.push({ bucketRef: bucket.bucketRef, reasonCode: "bucket_kind_not_eligible" });
      continue;
    }
    const unmet = bucket.restrictionRefs.filter(
      (ref) => !offer.eligibleRestrictionRefs.includes(ref),
    );
    if (unmet.length > 0) {
      excluded.push({ bucketRef: bucket.bucketRef, reasonCode: "restriction_not_eligible" });
      continue;
    }
    eligible.push(bucket);
  }
  if (offer.eligibleTiers !== null) {
    const tiers = offer.eligibleTiers;
    const matching = membership.filter((state) => tiers.includes(state.tier));
    if (matching.length === 0) push(uncertaintyCodes, "membership_out_of_scope");
    else if (matching.some((state) => state.source === "self-reported"))
      push(uncertaintyCodes, "membership_self_reported");
  }
  if (clock) {
    const validity = compareTemporal(clock, offer.validTime);
    if (validity.kind === "ordered" && validity.order !== 0)
      push(uncertaintyCodes, "offer_not_valid_at_clock");
    const deadline = compareTemporal(clock, offer.applicationDeadline);
    if (deadline.kind === "ordered" && deadline.order > 0)
      push(uncertaintyCodes, "application_deadline_passed");
  }
  const summed = sumQuantities(
    offer.fromUnitRef,
    eligible.map((bucket) => bucket.quantity),
  );
  const state: OfferEligibilityState =
    offer.verification !== "verified" ||
    uncertaintyCodes.includes("membership_out_of_scope") ||
    uncertaintyCodes.includes("membership_self_reported")
      ? "needs-rule-verification"
      : uncertaintyCodes.includes("offer_not_valid_at_clock") ||
          uncertaintyCodes.includes("application_deadline_passed") ||
          eligible.length === 0
        ? "not-eligible"
        : "available";
  if (offer.verification !== "verified") push(uncertaintyCodes, "rule_not_verified");
  return {
    offerRef: `${offer.offerId}@${offer.version}`,
    state,
    eligible: summed.ok
      ? summed.quantity
      : {
          unitRef: offer.fromUnitRef,
          value: { status: "conflict", reasonCode: summed.error.code },
        },
    eligibleBucketRefs: eligible.map((bucket) => bucket.bucketRef),
    excluded,
    uncertaintyCodes,
  };
}

// ── conversion simulation ────────────────────────────────────────────

function infeasible(
  offer: ConversionOffer,
  eligible: Quantity,
  fees: readonly Quantity[],
  reasonCodes: string[],
): ConversionPlan {
  const zero = exactQuantity(offer.fromUnitRef, integerDecimal(0));
  return {
    offerRef: `${offer.offerId}@${offer.version}`,
    offerVersion: offer.version,
    use: zero,
    receive: exactQuantity(offer.toUnitRef, integerDecimal(0)),
    remainder: eligible.value.status === "exact" ? eligible : zero,
    fees: [...fees],
    feasible: false,
    reasonCodes,
    basis: "policy-estimated",
    conditionRefs: conditionRefs(offer),
    release: REWARD_POLICY_RELEASE,
  };
}

function conditionRefs(offer: ConversionOffer): string[] {
  return [
    offer.eligibilityPolicyRef,
    offer.processingPolicyRef,
    offer.roundingPolicyRef,
    ...(offer.cancellationPolicyRef ? [offer.cancellationPolicyRef] : []),
    ...(offer.variableFeePolicyRef ? [offer.variableFeePolicyRef] : []),
  ];
}

/**
 * One offer applied to an eligible quantity: cap first, then whole increments,
 * then the minimum. The received amount is `use × ratio` under the offer's own
 * rounding, never `eligible × ratio`: SC14's 2,500 at 1:2 yields 1,000 from
 * 2,000 used, not 1,250. The plan is an estimate; the fees and the conditions
 * that still need checking travel with it.
 */
export function simulateConversion(
  offer: ConversionOffer,
  eligibleQuantity: Quantity,
  fees: readonly Quantity[] = offer.fixedFees,
): ConversionPlan {
  if (eligibleQuantity.unitRef !== offer.fromUnitRef)
    return infeasible(offer, eligibleQuantity, fees, ["unit_mismatch"]);
  if (eligibleQuantity.value.status !== "exact")
    return infeasible(offer, eligibleQuantity, fees, ["quantity_not_exact"]);
  const reasonCodes: string[] = [];
  if (offer.verification !== "verified") reasonCodes.push("offer_not_verified");
  const balance = eligibleQuantity.value.value;
  let capped = balance;
  if (offer.maximumPerRequest && compareDecimals(capped, offer.maximumPerRequest) > 0) {
    capped = offer.maximumPerRequest;
    reasonCodes.push("capped_by_maximum");
  }
  // Whole increments only: `down` truncates towards zero, so a partial step is
  // never rounded up into a quantity the member does not hold.
  const steps = divideDecimals(capped, offer.increment, { scale: 0, mode: "down" });
  if (!steps.ok)
    return infeasible(offer, eligibleQuantity, fees, [...reasonCodes, steps.error.code]);
  const use = multiplyDecimals(steps.value, offer.increment);
  if (compareDecimals(use, capped) < 0) reasonCodes.push("rounded_down_to_increment");
  if (compareDecimals(use, offer.minimum) < 0)
    return infeasible(offer, eligibleQuantity, fees, [...reasonCodes, "below_minimum"]);
  const received = multiplyByRatio(use, offer.ratio, offer.rounding);
  if (!received.ok)
    return infeasible(offer, eligibleQuantity, fees, [...reasonCodes, "invalid_ratio"]);
  // An application is not a credit: the destination quantity is what the plan
  // predicts, and only a later observation makes it a holding.
  reasonCodes.push("credit_is_not_the_application");
  return {
    offerRef: `${offer.offerId}@${offer.version}`,
    offerVersion: offer.version,
    use: exactQuantity(offer.fromUnitRef, use),
    receive: exactQuantity(offer.toUnitRef, received.value),
    remainder: exactQuantity(offer.fromUnitRef, subtractDecimals(balance, use)),
    fees: [...fees],
    feasible: offer.verification === "verified",
    reasonCodes,
    basis: "policy-estimated",
    conditionRefs: conditionRefs(offer),
    release: REWARD_POLICY_RELEASE,
  };
}

/**
 * A cash-like redemption estimate exists only for a named offer, and carries
 * that offer's conditions. There is no unconditional yen value of a point.
 */
export function cashLikeRedemptionEstimate(
  offer: ConversionOffer,
  plan: ConversionPlan,
): RewardValueClaim | null {
  if (!plan.feasible || plan.offerRef !== `${offer.offerId}@${offer.version}`) return null;
  return {
    kind: "cash-like-redemption-estimate",
    quantity: plan.receive,
    offerRef: plan.offerRef,
    conditionRefs: plan.conditionRefs,
    netAssetEligible: false,
    sourceAuthority: "policy-estimated",
  };
}

/** A provider's own displayed value stays a source claim; it is not our price. */
export function providerDisplayedValue(quantity: Quantity, evidenceRef: string): RewardValueClaim {
  return {
    kind: "provider-displayed",
    quantity,
    offerRef: null,
    conditionRefs: [evidenceRef],
    netAssetEligible: false,
    sourceAuthority: "provider-reported",
  };
}

// ── redemption lifecycle ─────────────────────────────────────────────

/**
 * Walk a redemption's observed events. A request alone moves nothing; a debit
 * creates an in-transit amount; only an observed credit increases the
 * destination. A cancellation waits for an observed return, and the return is
 * a new bucket claim — the debited lot is never resurrected.
 */
export function redemptionPositions(
  initialHeld: Quantity,
  events: readonly RedemptionEvent[],
  destinationUnitRef: string,
): RedemptionTrace {
  const violations: string[] = [];
  const returnedBuckets: RedemptionTrace["returnedBuckets"] = [];
  const positions: RedemptionPosition[] = [];
  const unit = initialHeld.unitRef;
  let held = initialHeld;
  let inTransit = exactQuantity(unit, integerDecimal(0));
  let credited = exactQuantity(destinationUnitRef, integerDecimal(0));
  let debited = false;
  const move = (from: Quantity, to: Quantity, amount: Quantity): [Quantity, Quantity] => {
    const a = sumQuantities(from.unitRef, [from, { unitRef: from.unitRef, value: negate(amount) }]);
    const b = sumQuantities(to.unitRef, [to, amount]);
    return [a.ok ? a.quantity : from, b.ok ? b.quantity : to];
  };
  for (const event of events) {
    const codes: string[] = [];
    switch (event.stage) {
      case "requested":
        // Deliberately no state change: an application is not a movement.
        codes.push("application_is_not_a_credit");
        break;
      case "debited":
        if (event.quantity.unitRef !== unit) violations.push("debit_unit_mismatch");
        else [held, inTransit] = move(held, inTransit, event.quantity);
        debited = true;
        break;
      case "credited":
        if (event.quantity.unitRef !== destinationUnitRef) violations.push("credit_unit_mismatch");
        else if (!debited) violations.push("credit_before_debit");
        else {
          const sum = sumQuantities(destinationUnitRef, [credited, event.quantity]);
          if (sum.ok) credited = sum.quantity;
          inTransit = exactQuantity(unit, integerDecimal(0));
        }
        break;
      case "cancelled":
        codes.push("return_awaits_observation");
        break;
      case "returned":
        if (event.quantity.unitRef !== unit) violations.push("return_unit_mismatch");
        else {
          const sum = sumQuantities(unit, [held, event.quantity]);
          if (sum.ok) held = sum.quantity;
          inTransit = exactQuantity(unit, integerDecimal(0));
          returnedBuckets.push({
            bucketRef: event.returnedToBucketRef ?? `bucket:returned:${event.eventRef}`,
            quantity: event.quantity,
            eventRef: event.eventRef,
          });
          if (event.returnedToBucketRef === null) codes.push("return_bucket_unknown");
        }
        break;
    }
    positions.push({
      stage: event.stage,
      sourceHeld: held,
      inTransit,
      destinationCredited: credited,
      uncertaintyCodes: codes,
    });
  }
  return { positions, violations, returnedBuckets };
}

function negate(quantity: Quantity): Quantity["value"] {
  if (quantity.value.status !== "exact") return quantity.value;
  const { coefficient, scale } = quantity.value.value;
  return {
    status: "exact",
    value:
      coefficient === "0"
        ? { coefficient: "0", scale: 0 }
        : {
            coefficient: coefficient.startsWith("-") ? coefficient.slice(1) : `-${coefficient}`,
            scale,
          },
    normalizationVersion: quantity.value.normalizationVersion,
  };
}

// ── bounded route search ─────────────────────────────────────────────

export interface SearchBudget {
  /** At most this many hops in one plan; the first implementation compares 1-2. */
  maxDepth: number;
  /** At most this many candidate plans are kept; the search stops when exceeded. */
  maxCandidates: number;
  /** Offers examined; the search stops when this is exhausted. */
  maxExpansions: number;
  /** Deadline every hop must have completed by, if the caller has one. */
  requiredCompletionBy: TemporalValue | null;
}

export interface ConversionHop {
  offerRef: string;
  plan: ConversionPlan;
  /** Calendar day the application is made and the day the credit is expected. */
  appliedOn: string;
  creditExpectedOn: string;
}

export interface ConversionPath {
  hops: ConversionHop[];
  received: Quantity;
  fees: Quantity[];
  /** Deliberately not called "best": the search is bounded, not exhaustive. */
  optimality: "not-determined";
  reasonCodes: string[];
}

export interface ConversionSearchResult {
  paths: ConversionPath[];
  /** Always `bounded` while depth and candidate caps apply. */
  searchCoverage: "bounded" | "complete";
  rejected: { offerRef: string; reasonCode: string }[];
  expansions: number;
  budget: SearchBudget;
  release: string;
}

interface SearchState {
  unitRef: string;
  quantity: Quantity;
  day: number;
  hops: ConversionHop[];
  usedOfferIds: string[];
  usedQuotaRefs: string[];
  fees: Quantity[];
}

function dayNumber(value: TemporalValue): number | null {
  const date = localDate(value);
  return date ? daysFromCivil(date) : null;
}

function dayText(day: number): string {
  return formatLocalDate(civilFromDays(day));
}

/**
 * Bounded search for 1..maxDepth chains of offers from a start quantity to a
 * goal unit. Remaining balance and time are part of the state, so this is not
 * a shortest-path over rates: a hop is only taken if its minimum, increment,
 * cap, rounding, eligibility and deadline all hold at the day it would be
 * applied, and the next hop cannot be applied before the previous credit is
 * expected. Re-using one offer or two offers behind the same quota inside one
 * plan is rejected, as is returning to a unit already visited, so a positive
 * cycle cannot manufacture value. The result is always `bounded`; no path is
 * called optimal.
 */
export function findConversionPaths(
  offers: readonly ConversionOffer[],
  start: { quantity: Quantity; clock: TemporalValue; membership?: readonly MembershipState[] },
  goalUnitRef: string,
  budget: SearchBudget,
): ConversionSearchResult {
  const rejected: ConversionSearchResult["rejected"] = [];
  const paths: ConversionPath[] = [];
  let expansions = 0;
  const startDay = dayNumber(start.clock);
  const requiredBy = budget.requiredCompletionBy ? dayNumber(budget.requiredCompletionBy) : null;
  if (startDay === null)
    return {
      paths,
      searchCoverage: "bounded",
      rejected: [{ offerRef: "-", reasonCode: "clock_not_a_date" }],
      expansions,
      budget,
      release: CONVERSION_SEARCH_RELEASE,
    };

  const visit = (state: SearchState, visitedUnits: string[]): void => {
    if (state.hops.length >= budget.maxDepth) return;
    if (paths.length >= budget.maxCandidates) return;
    for (const offer of offers) {
      if (expansions >= budget.maxExpansions) return;
      expansions += 1;
      const offerRef = `${offer.offerId}@${offer.version}`;
      if (offer.fromUnitRef !== state.unitRef) continue;
      if (state.usedOfferIds.includes(offer.offerId)) {
        rejected.push({ offerRef, reasonCode: "same_offer_reuse" });
        continue;
      }
      if (offer.sharedQuotaRef && state.usedQuotaRefs.includes(offer.sharedQuotaRef)) {
        rejected.push({ offerRef, reasonCode: "shared_quota_reuse" });
        continue;
      }
      if (visitedUnits.includes(offer.toUnitRef)) {
        rejected.push({ offerRef, reasonCode: "cycle_rejected" });
        continue;
      }
      if (offer.verification !== "verified") {
        // Unknown conditions are a separate candidate, never a proven refusal.
        rejected.push({ offerRef, reasonCode: "needs_rule_verification" });
        continue;
      }
      const appliedOn = state.day;
      const deadlineDay = dayNumber(offer.applicationDeadline);
      if (deadlineDay !== null && appliedOn > deadlineDay) {
        rejected.push({
          offerRef,
          reasonCode:
            state.hops.length === 0 ? "application_deadline_passed" : "reuse_before_credit",
        });
        continue;
      }
      const creditOn = appliedOn + offer.processingDays;
      if (requiredBy !== null && creditOn > requiredBy) {
        rejected.push({ offerRef, reasonCode: "completion_after_required_by" });
        continue;
      }
      const plan = simulateConversion(offer, state.quantity, offer.fixedFees);
      if (!plan.feasible) {
        rejected.push({ offerRef, reasonCode: plan.reasonCodes[0] ?? "not_feasible" });
        continue;
      }
      const hop: ConversionHop = {
        offerRef,
        plan,
        appliedOn: dayText(appliedOn),
        creditExpectedOn: dayText(creditOn),
      };
      const next: SearchState = {
        unitRef: offer.toUnitRef,
        quantity: plan.receive,
        day: creditOn,
        hops: [...state.hops, hop],
        usedOfferIds: [...state.usedOfferIds, offer.offerId],
        usedQuotaRefs: offer.sharedQuotaRef
          ? [...state.usedQuotaRefs, offer.sharedQuotaRef]
          : state.usedQuotaRefs,
        fees: [...state.fees, ...plan.fees],
      };
      if (offer.toUnitRef === goalUnitRef && paths.length < budget.maxCandidates)
        paths.push({
          hops: next.hops,
          received: next.quantity,
          fees: next.fees,
          optimality: "not-determined",
          reasonCodes: next.hops.flatMap((h) => h.plan.reasonCodes),
        });
      visit(next, [...visitedUnits, offer.toUnitRef]);
    }
  };

  visit(
    {
      unitRef: start.quantity.unitRef,
      quantity: start.quantity,
      day: startDay,
      hops: [],
      usedOfferIds: [],
      usedQuotaRefs: [],
      fees: [],
    },
    [start.quantity.unitRef],
  );
  return {
    paths,
    searchCoverage: "bounded",
    rejected,
    expansions,
    budget,
    release: CONVERSION_SEARCH_RELEASE,
  };
}
