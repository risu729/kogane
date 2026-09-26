import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type { ReportedState } from "../../../packages/domain/src/reported-state.ts";

export type {
  ReportedAccount,
  ReportedBalance,
  ReportedPayable,
  ReportedPosition,
  ReportedSnapshot,
  ReportedState,
} from "../../../packages/domain/src/reported-state.ts";

const REPORTED_STATE_PATH = "/api/v2/reported-state";

/** Today's date in Asia/Tokyo, the zone every reported date is asked in. */
export function tokyoToday(now: number = Date.now()): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** The reported state on `date` (`YYYY-MM-DD`), once the server advertises it. */
export function useReportedState(date: string) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["reported-state", date],
    enabled: features.known && features.reportedStateOnDate,
    queryFn: ({ signal }) =>
      getJson<ReportedState & { apiVersion: 2 }>(
        `${REPORTED_STATE_PATH}?${new URLSearchParams({ date })}`,
        signal,
      ),
    retry: false,
  });
}
