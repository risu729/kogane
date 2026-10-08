// GLOBAL PASS months whose current capture is empty while an older capture of
// the same month had rows (ADR 0026's amendment of 2026-10-08). The lists
// follow the current capture; this notice names the months so a person can
// check the provider's display. It is not a freshness or completeness claim.
import type { ApiMetadata } from "../../../packages/observation-shared/src/api-contract.ts";

/** Months named in the message before the rest is counted. */
const LISTED_MONTHS = 3;

export function globalPassEmptyMonthsMessage(
  notice: ApiMetadata["globalPassEmptyMonths"],
): string | null {
  if (!notice || notice.months.length === 0) return null;
  const listed = notice.months
    .slice(0, LISTED_MONTHS)
    .map(
      (month) =>
        `${month.month}（現在の取得 run ${month.currentFetchRunId}、以前の取得 run ${month.supersededFetchRunId}${
          month.supersededRuns > 1 ? ` ほか${month.supersededRuns - 1}回` : ""
        }）`,
    )
    .join("、");
  const rest = notice.months.length - Math.min(notice.months.length, LISTED_MONTHS);
  const more = notice.truncated
    ? " ほか（上限を超えるため一部のみ）"
    : rest > 0
      ? ` ほか${rest}か月`
      : "";
  return `GLOBAL PASS の ${notice.months.length}${notice.truncated ? "+" : ""}か月は、現在の取得では明細がありませんが、以前の取得には明細がありました: ${listed}${more}。表示は現在の取得に従い、以前の明細は自動では戻しません。提供元の表示と取得履歴の確認が必要です。これは収集の成否やデータの新しさを示しません。`;
}

export function GlobalPassEmptyMonthsNotice({
  notice,
}: {
  notice: ApiMetadata["globalPassEmptyMonths"];
}) {
  const message = globalPassEmptyMonthsMessage(notice);
  return message ? (
    <div className="query-notice query-warning" role="status">
      {message}
    </div>
  ) : null;
}
