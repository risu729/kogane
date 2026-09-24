import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type {
  CardPurchasePage,
  CardPurchaseView,
} from "../../../packages/domain/src/card-purchase-view.ts";

export type { CardPurchaseView };
const CARD_PURCHASES_PATH = "/api/v2/card-purchases";

/** One page of recognised purchases; `period` is a statement month (`YYYY-MM`) or none. */
export function useCardPurchases(offset: number, period: string | null) {
  const features = useFeatures();
  const params = new URLSearchParams({ offset: String(offset) });
  if (period !== null) params.set("period", period);
  return useQuery({
    queryKey: ["card-purchases", "list", period, offset],
    enabled: features.known && features.cardPurchaseRecognition,
    queryFn: ({ signal }) => getJson<CardPurchasePage>(`${CARD_PURCHASES_PATH}?${params}`, signal),
    retry: false,
  });
}

/** One purchase by its event id, with the page it was read in (for its summary). */
export function useCardPurchase(eventId: string) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["card-purchases", "detail", eventId],
    enabled: features.known && features.cardPurchaseRecognition,
    queryFn: ({ signal }) =>
      getJson<CardPurchasePage>(
        `${CARD_PURCHASES_PATH}?eventId=${encodeURIComponent(eventId)}`,
        signal,
      ),
    retry: false,
  });
}
