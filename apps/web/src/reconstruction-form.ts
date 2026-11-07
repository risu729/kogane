import { validInstantText, validLocalDateText } from "../../../packages/domain/src/time.ts";
import type { ReconstructedStateQuery } from "./reconstructed-state-api.ts";

const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/u;
const EPOCH = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/u;
const SEQ = /^[1-9][0-9]{0,15}$/u;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
/** The route's bound (`RECONSTRUCTION_RANGE_MAX_DAYS`); the server checks it again. */
const MAX_DAYS = 366;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A form problem, in words, or null when the request may be sent. */
export function formProblem(draft: ReconstructedStateQuery, today: string): string | null {
  if (!ACCOUNT.test(draft.account)) return "口座 ID を選ぶか入力してください。";
  // A calendar day by the route's own rule: 2026-02-30 fits the pattern but
  // is no day, and the route would refuse it as invalid_date. (Date.parse
  // rolls it over to March rather than failing, so the checks below would
  // not catch it.)
  if (!validLocalDateText(draft.from) || !validLocalDateText(draft.to))
    return "日付を 2026-03-31 のように指定してください。";
  if (draft.from >= draft.to) return "開始日は終了日より前にしてください。";
  if (draft.to > today) return "終了日は今日（日本時間）以前にしてください。";
  if (daysBetween(draft.from, draft.to) > MAX_DAYS) return "期間は366日以内にしてください。";
  if (draft.cut.kind !== "latest" && !EPOCH.test(draft.cut.coreEpoch))
    return "コミット記録の世代を入力してください。";
  if (
    draft.cut.kind === "sequence" &&
    (!SEQ.test(draft.cut.commitSeq) || !Number.isSafeInteger(Number(draft.cut.commitSeq)))
  )
    return "コミット番号は1以上の整数で入力してください。";
  if (
    draft.cut.kind === "instant" &&
    (!INSTANT.test(draft.cut.instant) || !validInstantText(draft.cut.instant))
  )
    return "時刻を 2026-04-01T00:00:00Z のように UTC で入力してください。";
  return null;
}
