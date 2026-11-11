// Wire contract shared by runtime validation and the rewards screen.
import type { RewardProviderExpirySection } from "../../domain/src/reward-expiry-observations.ts";
import type { Quantity } from "../../domain/src/values.ts";
import type { TemporalValue } from "../../domain/src/time.ts";
import {
  BUCKET_KINDS,
  validBucketExpiryBasis,
  type BucketKind,
  type BucketExpiryBasis,
} from "../../domain/src/rewards.ts";
/** Provider enum values are never guessed into a supported kind. */
export function validRewardBucketKind(value: unknown): value is BucketKind {
  return typeof value === "string" && (BUCKET_KINDS as readonly string[]).includes(value);
}

export type RewardQuantity = Quantity;
export type RewardTime = TemporalValue;

export interface RewardBucketRow {
  bucketRef: string;
  kind: string;
  restrictionRefs: string[];
  unitRef: string;
  quantity: RewardQuantity;
  observedExpiry: RewardTime | null;
  observedAt: RewardTime;
  sourceFactRefs: string[];
}
export interface RewardHoldingRow {
  /** Dated coverage of the acquisition-month breakdown, separate from the total. */
  pointHistoryCoverage?: {
    state: "current" | "stale" | "unavailable";
    reasonCode: "history_not_current" | null;
    observedAt: string | null;
    sourceFactRefs: string[];
  };
  programId: string;
  programRef: string;
  institutionRef: string;
  sourceId: string;
  holdingRef: string;
  holdingKind: "reward-points" | "prepaid-balance";
  unitRef: string;
  termsEvidenceRefs: string[];
  consumable: RewardQuantity;
  byKind: { kind: string; quantity: RewardQuantity; bucketRefs: string[] }[];
  excluded: { bucketRef: string; kind: string; reasonCode: string }[];
  buckets: RewardBucketRow[];
  qualificationMeasures: {
    measureRef: string;
    metricRef: string;
    quantity: RewardQuantity;
    period: RewardTime;
    consumable: false;
  }[];
  membership: { tier: string; valid: RewardTime; source: string; evidenceRefs: string[] }[];
  valueModel: { netAssetEligible: false; cashLikeRedemptionEstimate: null; reasonCode: string };
}
export interface RewardExpiryRow {
  holdingRef: string;
  programId: string;
  ruleRef: string;
  family: string;
  verification: string;
  state: "computed" | "partial" | "conflict" | "needs-rule-verification";
  uncertaintyCodes: string[];
  deadlineZone: string;
  deadlineZoneBasis: string;
  rows: {
    bucketRef: string;
    quantity: RewardQuantity;
    deadline: RewardTime;
    basis: "provider-observed" | "policy-estimated" | "unknown";
    providerObserved: RewardTime | null;
    policyEstimated: RewardTime | null;
    reasonCodes: string[];
  }[];
  sourceExpiryRefs: string[];
}
export interface RewardPage<T> {
  rows: T[];
  coverage: { limit: number; truncated: boolean; nextOffset: number | null };
}

export interface RewardReadExpiryRow {
  holdingRef: string;
  programId: string;
  bucketRef: string;
  bucketKind: string;
  ruleRef: string;
  state: RewardExpiryRow["state"];
  basis: "provider-observed" | "policy-estimated" | "unknown";
  expiresOn: string | null;
  quantity: RewardQuantity;
  providerObserved: RewardTime | null;
  policyEstimated: RewardTime | null;
  reasonCodes: string[];
  uncertaintyCodes: string[];
  basisRefs: string[];
  /**
   * The provider's display and the computed expiry apart (ADR 0049). `null`
   * means the snapshot's build recorded no basis (before
   * `reward-projection-v2`) or the stored value no longer validates — never
   * "no computed expiry". Absent only in a response from an App build that
   * predates the field.
   */
  expiryBasis?: RewardExpiryBasis | null;
}
/**
 * One bucket's deadline from both sides (ADR 0049): what the provider
 * displayed — an observation — and what the stored rule version computed — a
 * derivation, with the rule, activity and membership facts it used, or one
 * closed reason it is unavailable. The wire shape is the domain's.
 */
export type RewardExpiryBasis = BucketExpiryBasis;

/** Exact-key check of one basis: the shared response check and the screen both use it. */
export function validRewardExpiryBasis(value: unknown): value is RewardExpiryBasis {
  return validBucketExpiryBasis(value);
}

export interface RewardReadExpiryPage {
  providerDisplaySections?: RewardProviderExpirySection[];
  rows: RewardReadExpiryRow[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
  snapshot: {
    snapshotId: string;
    evaluatedAt: string;
    evaluationCalendar: string;
    ruleSetDigest: string;
    ruleCount: number;
    claimsRelease: string;
    claimsHighWater: number;
    release: string;
  };
}
export type RewardExpiryPage = RewardPage<RewardExpiryRow> | RewardReadExpiryPage;
