// The fixed report artifact routes (docs/calculation-and-reports.md §4). Read
// only: re-displaying a stored report never recomputes it, and recomputing or
// sharing a corrected version are commands this client does not offer.
// `getJson` validates every answer against
// `packages/observation-shared/src/report-artifact-contract.ts`, so a
// malformed answer is an error, never a different report or a zero.
import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import {
  REPORTS_PATH,
  type ReportDetail,
  type ReportExplanation,
  type ReportListPage,
} from "../../../packages/observation-shared/src/report-artifact-contract.ts";

export type {
  ReportDetail,
  ReportEventRow,
  ReportExplanation,
  ReportListItem,
  ReportListPage,
  ReportSummary,
} from "../../../packages/observation-shared/src/report-artifact-contract.ts";
export type { ReportBody } from "../../../packages/domain/src/reports.ts";

/** Rows per list page, as the server pages them (`REPORTS_PAGE_SIZE`). */
export const REPORTS_PAGE_SIZE = 50;

function reportPath(reportId: string): string {
  return `${REPORTS_PATH}/${encodeURIComponent(reportId)}`;
}

/** One page of stored reports, newest first, once the server advertises them. */
export function useReports(offset: number) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["reports", "list", offset],
    enabled: features.known && features.reportArtifacts,
    queryFn: ({ signal }) =>
      getJson<ReportListPage>(
        `${REPORTS_PATH}?${new URLSearchParams({ offset: String(offset) })}`,
        signal,
      ),
    retry: false,
  });
}

/** One stored report, re-displayed exactly as it was fixed. */
export function useReport(reportId: string) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["reports", "detail", reportId],
    enabled: features.known && features.reportArtifacts,
    queryFn: ({ signal }) => getJson<ReportDetail>(reportPath(reportId), signal),
    retry: false,
  });
}

/**
 * The cached explanation node of a report. Asked only when the report says it
 * may be explained: a restricted or unavailable report is refused by the
 * server, and the client does not ask for a refusal.
 */
export function useReportExplanation(reportId: string, explainable: boolean) {
  const features = useFeatures();
  return useQuery({
    queryKey: ["reports", "explanation", reportId],
    enabled: features.known && features.reportArtifacts && explainable,
    queryFn: ({ signal }) =>
      getJson<ReportExplanation>(`${reportPath(reportId)}/explanation`, signal),
    retry: false,
  });
}
