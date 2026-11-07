import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type {
  CardSettlementReview,
  CardSettlementReviewPage,
} from "../../../packages/domain/src/card-settlement-review.ts";

export type { CardSettlementReview, CardSettlementReviewPage };
export const CARD_SETTLEMENT_PATH = "/api/v2/reconciliation/card-settlements";

export function useCardSettlements(offset: number) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-settlements", "list", offset],
    enabled: features.known && features.cardSettlementReconciliation,
    queryFn: ({ signal }) =>
      getJson<CardSettlementReviewPage>(`${CARD_SETTLEMENT_PATH}?offset=${offset}`, signal),
    retry: false,
  });
}

export function useCardSettlement(proposalId: string | null) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-settlements", "detail", proposalId],
    enabled: proposalId !== null && features.known && features.cardSettlementReconciliation,
    queryFn: ({ signal }) =>
      getJson<CardSettlementReviewPage>(
        `${CARD_SETTLEMENT_PATH}?proposalId=${encodeURIComponent(proposalId ?? "")}`,
        signal,
      ).then((page) => page.items[0] ?? null),
    retry: false,
  });
}

/**
 * The candidates `proposalId` competes with: those sharing its statement, its
 * bank debit or its statement month, every status, newest first.
 */
export function useRelatedCardSettlements(proposalId: string, offset: number) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-settlements", "related", proposalId, offset],
    enabled: features.known && features.cardSettlementReconciliation,
    queryFn: ({ signal }) =>
      getJson<CardSettlementReviewPage>(
        `${CARD_SETTLEMENT_PATH}?relatedTo=${encodeURIComponent(proposalId)}${
          offset === 0 ? "" : `&offset=${offset}`
        }`,
        signal,
      ),
    retry: false,
  });
}
