import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type {
  CardSettlementReview,
  CardSettlementReviewPage,
  CardSettlementStatementGroup,
  CardSettlementStatementPage,
} from "../../../packages/domain/src/card-settlement-review.ts";

export type {
  CardSettlementReview,
  CardSettlementReviewPage,
  CardSettlementStatementGroup,
  CardSettlementStatementPage,
};
export const CARD_SETTLEMENT_PATH = "/api/v2/reconciliation/card-settlements";
export const CARD_SETTLEMENT_STATEMENTS_PATH = `${CARD_SETTLEMENT_PATH}/statements`;

/** The review list grouped by statement, lead candidate first. */
export function useCardSettlementStatements(offset: number) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-settlements", "statements", offset],
    enabled: features.known && features.cardSettlementReconciliation,
    queryFn: ({ signal }) =>
      getJson<CardSettlementStatementPage>(
        `${CARD_SETTLEMENT_STATEMENTS_PATH}?offset=${offset}`,
        signal,
      ),
    retry: false,
  });
}

/** Every candidate of one statement, newest first; read only when asked for. */
export function useStatementCandidates(statementKey: string, offset: number, enabled: boolean) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-settlements", "statement", statementKey, offset],
    enabled: enabled && features.known && features.cardSettlementReconciliation,
    queryFn: ({ signal }) =>
      getJson<CardSettlementReviewPage>(
        `${CARD_SETTLEMENT_PATH}?statementKey=${encodeURIComponent(statementKey)}&offset=${offset}`,
        signal,
      ),
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
