import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type { CardOwnershipReview } from "../../../packages/domain/src/card-ownership-review.ts";
export function useCardOwnership(proposalId: string | null) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-ownership", proposalId],
    enabled: proposalId !== null && features.known && features.cardOwnershipReview,
    queryFn: ({ signal }) =>
      getJson<CardOwnershipReview>(
        `/api/v2/reconciliation/card-settlements/ownership?proposalId=${encodeURIComponent(proposalId ?? "")}`,
        signal,
      ),
    retry: false,
  });
}
