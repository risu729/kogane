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

/**
 * The expiry window of `GET /api/v2/rewards/expiry` (`from`, `before`) as the
 * answer states it (ADR 0049, amendment of 2026-11-19). Dates are calendar
 * dates compared with each row's `expiresOn`: `from` is inclusive, `before`
 * exclusive. `from` is today's Asia/Tokyo date when the request names none
 * (`fromBasis: "today"`); `before` null is no upper bound.
 */
export interface RewardExpiryWindow {
  from: string;
  before: string | null;
  fromBasis: "request" | "today";
  today: string;
  calendar: "Asia/Tokyo";
}

/** Closed reasons a bucket, a row or a provider display is left out of a window. */
export const REWARD_EXPIRY_LEFT_OUT_REASONS = [
  // No row carries a date: neither a readable provider display nor a
  // computed deadline (ADR 0049).
  "deadline_unknown",
  // A bucket's rows under its programme's rules carry different deadlines, or
  // a date beside none; no one of them is chosen.
  "deadline_differs_by_rule",
  // A provider display whose date was not readable (ADR 0068).
  "display_date_unknown",
  // A provider section that displayed no portion (ADR 0068).
  "provider_expiry_not_displayed",
  "provider_expiry_unavailable",
] as const;
export type RewardExpiryLeftOutReason = (typeof REWARD_EXPIRY_LEFT_OUT_REASONS)[number];

/** How many entries fell inside, before and after the window, and why the rest were left out. */
export interface RewardExpiryWindowCounts {
  inWindow: number;
  beforeWindow: number;
  afterWindow: number;
  leftOut: { reasonCode: RewardExpiryLeftOutReason; count: number }[];
}

/** A windowed full page: its rows are those inside the window; `window.rows` counts them all. */
export interface RewardReadExpiryWindowedPage extends RewardReadExpiryPage {
  window: RewardExpiryWindow & { rows: RewardExpiryWindowCounts };
}

/** One amount of a summary: exact decimal text, or its status and reason with no value (INV05). */
export type RewardExpirySummaryAmount =
  | { status: "exact"; value: string }
  | { status: "missing" | "unparsed" | "conflict"; value: null; reasonCode: string };

/**
 * A programme's total over the buckets inside the window: exact only when
 * every one of their amounts is exact (summed with `sumQuantities`);
 * otherwise no value and the statuses that prevented it, never a partial sum
 * or a zero.
 */
export type RewardExpirySummaryTotal =
  | { status: "exact"; value: string }
  | { status: "not-exact"; value: null; reasonCodes: string[] };

export interface RewardExpirySummaryLine {
  holdingRef: string;
  bucketRef: string;
  kind: string;
  expiresOn: string;
  basis: "provider-observed" | "policy-estimated";
  amount: RewardExpirySummaryAmount;
}

export interface RewardExpirySummaryProgram {
  programId: string;
  unitRef: string;
  /** Buckets of this programme and unit inside the window. */
  buckets: number;
  total: RewardExpirySummaryTotal;
  /** The earliest of them; the summary's line limit counts across programmes. */
  lines: RewardExpirySummaryLine[];
}

/** A provider-displayed portion of a holding (ADR 0068): listed, never added to a total. */
export interface RewardExpirySummaryDisplay {
  programId: string;
  holdingRef: string;
  parentBucketRef: string;
  displayRef: string;
  unitRef: string;
  expiresOn: string;
  amount: RewardExpirySummaryAmount;
}

/** `GET /api/v2/rewards/expiry?detail=summary`. */
export interface RewardExpirySummary {
  detail: "summary";
  window: RewardExpiryWindow | null;
  programs: RewardExpirySummaryProgram[];
  providerDisplays: RewardExpirySummaryDisplay[];
  counts: { buckets: RewardExpiryWindowCounts; providerDisplays: RewardExpiryWindowCounts };
  /** The most lines a summary lists: bucket lines across programmes, and provider displays. */
  lineLimit: { buckets: number; providerDisplays: number };
  snapshot: RewardReadExpiryPage["snapshot"];
}
