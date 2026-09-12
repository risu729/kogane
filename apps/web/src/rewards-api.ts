// Reward reads (A11). Every hook is disabled until the API advertises the
// `rewardsV2` capability, so a deployment without it sends no request at all.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";

import type {
  RewardPage,
  RewardHoldingRow,
  RewardExpiryPage,
} from "../../../packages/observation-shared/src/reward-contract.ts";
export type * from "../../../packages/observation-shared/src/reward-contract.ts";

export function useRewardHoldings(): UseQueryResult<RewardPage<RewardHoldingRow>, Error> {
  const { rewards } = useFeatures();
  return useQuery({
    queryKey: ["reward-holdings"],
    enabled: rewards,
    queryFn: ({ signal }) =>
      getJson<RewardPage<RewardHoldingRow>>("/api/v2/rewards/holdings?offset=0", signal),
  });
}

export function useRewardExpiry(): UseQueryResult<RewardExpiryPage, Error> {
  const { rewards } = useFeatures();
  return useQuery({
    queryKey: ["reward-expiry"],
    enabled: rewards,
    queryFn: ({ signal }) => getJson<RewardExpiryPage>("/api/v2/rewards/expiry?offset=0", signal),
  });
}
