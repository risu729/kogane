// Reward reads (A11). Every hook is disabled until the API advertises the
// `rewardsV2` capability, so a deployment without it sends no request at all.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";

/** decimal-v1 value states, as the API returns them. */
export type RewardValue =
  | { status: "exact"; value: { coefficient: string; scale: number }; normalizationVersion: string }
  | { status: "missing" | "unparsed" | "conflict"; reasonCode: string };
export interface RewardQuantity {
  unitRef: string;
  value: RewardValue;
}
export type RewardTime =
  | { kind: "instant"; value: string; zone: string; basis: string }
  | { kind: "local-date"; value: string; zone: string | null; basis: string }
  | { kind: "period"; start: string; end: string; endExclusive: boolean; zone: string | null }
  | { kind: "unknown"; reasonCode: string };

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

export function useRewardHoldings(): UseQueryResult<RewardPage<RewardHoldingRow>, Error> {
  const { rewards } = useFeatures();
  return useQuery({
    queryKey: ["reward-holdings"],
    enabled: rewards,
    queryFn: ({ signal }) =>
      getJson<RewardPage<RewardHoldingRow>>("/api/v2/rewards/holdings?offset=0", signal),
  });
}

export function useRewardExpiry(): UseQueryResult<RewardPage<RewardExpiryRow>, Error> {
  const { rewards } = useFeatures();
  return useQuery({
    queryKey: ["reward-expiry"],
    enabled: rewards,
    queryFn: ({ signal }) =>
      getJson<RewardPage<RewardExpiryRow>>("/api/v2/rewards/expiry?offset=0", signal),
  });
}
