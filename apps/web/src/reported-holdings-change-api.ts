import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type { HoldingsChange } from "../../../packages/domain/src/holdings-change.ts";

export type {
  HoldingChange,
  HoldingChangeReason,
  HoldingChangeStatus,
  HoldingSide,
  HoldingsChange,
} from "../../../packages/domain/src/holdings-change.ts";

const REPORTED_HOLDINGS_CHANGE_PATH = "/api/v2/reported-holdings-change";

/** What the panel asks: the route's own parameters, nothing computed here. */
export interface HoldingsChangeQuery {
  from: string;
  to: string;
}

/**
 * The reported holdings change from `from` to `to` (`YYYY-MM-DD`, Asia/Tokyo).
 * Served wherever the reported state is, so it follows `reportedStateOnDate`;
 * nothing is asked until a start date is chosen.
 */
export function useReportedHoldingsChange(query: HoldingsChangeQuery | null) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["reported-holdings-change", query?.from ?? null, query?.to ?? null],
    enabled: features.known && features.reportedStateOnDate && query !== null,
    queryFn: ({ signal }) =>
      getJson<HoldingsChange & { apiVersion: 2 }>(
        `${REPORTED_HOLDINGS_CHANGE_PATH}?${new URLSearchParams({ from: query!.from, to: query!.to })}`,
        signal,
      ),
    retry: false,
  });
}
