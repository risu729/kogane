import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type { HoldingsChange } from "../../../packages/domain/src/holdings-change.ts";
import {
  holdingsChangeQueryRefusal,
  holdingsChangeSearch,
  REPORTED_HOLDINGS_CHANGE_PATH,
  type HoldingsChangeRequest,
} from "../../../packages/observation-shared/src/reported-holdings-change-contract.ts";

export type {
  HoldingChange,
  HoldingChangeReason,
  HoldingChangeStatus,
  HoldingSide,
  HoldingsChange,
} from "../../../packages/domain/src/holdings-change.ts";

/** What the panel asks: the route's own parameters, nothing computed here. */
export type HoldingsChangeQuery = HoldingsChangeRequest;

/**
 * The reported holdings change from `from` to `to` (`YYYY-MM-DD`, Asia/Tokyo),
 * optionally narrowed to one source and one account. Served wherever the
 * reported state is, so it follows `reportedStateOnDate`; nothing is asked
 * until a start date is chosen, nor for a request whose shape the route
 * refuses (the wire contract's own rule).
 */
export function useReportedHoldingsChange(query: HoldingsChangeQuery | null) {
  const features = useFeatures();
  const params = query === null ? null : holdingsChangeSearch(query);
  const search =
    params === null || holdingsChangeQueryRefusal(params) !== null ? null : params.toString();
  return useQuery({
    queryKey: ["reported-holdings-change", search],
    enabled: features.known && features.reportedStateOnDate && search !== null,
    queryFn: ({ signal }) =>
      getJson<HoldingsChange & { apiVersion: 2 }>(
        `${REPORTED_HOLDINGS_CHANGE_PATH}?${search}`,
        signal,
      ),
    retry: false,
  });
}
