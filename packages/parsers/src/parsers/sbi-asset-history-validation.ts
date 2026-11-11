// One semantic contract for the whole source and each derived year.
import { decimalEquals, integerDecimal, sumDecimals } from "../../../domain/src/values";
import {
  assetHistoryError,
  assetHistoryViews,
  type AssetHistoryView,
} from "./sbi-asset-history-schema";
const WEEK = 7 * 86400000;

function money(value: number): number {
  if (!Number.isSafeInteger(value)) throw assetHistoryError("sbi_asset_history_money");
  return value;
}
export function assetHistoryPointDate(time: string): string {
  const local = new Date(Number(time) + 9 * 3600000);
  if (
    local.getUTCDay() !== 6 ||
    local.getUTCHours() !== 0 ||
    local.getUTCMinutes() !== 0 ||
    local.getUTCSeconds() !== 0 ||
    local.getUTCMilliseconds() !== 0
  )
    throw assetHistoryError("sbi_asset_history_timestamp");
  return local.toISOString().slice(0, 10);
}
function nativePoints(values: readonly [number, number][]): Map<string, number> {
  const result = new Map<string, number>();
  for (const [time, value] of values) {
    const key = String(time);
    if (result.has(key)) throw assetHistoryError("sbi_asset_history_native_mismatch");
    result.set(key, money(value));
  }
  return result;
}
function validateView(view: AssetHistoryView): string[] {
  if (view.transitions === null) return [];
  const times = Object.keys(view.transitions).sort();
  const balances = nativePoints(view.balances);
  const acquisition = nativePoints(view.acquisitionCosts);
  if (balances.size !== times.length || acquisition.size !== times.length)
    throw assetHistoryError("sbi_asset_history_native_mismatch");
  for (const [index, time] of times.entries()) {
    assetHistoryPointDate(time);
    if (index > 0 && Number(time) - Number(times[index - 1]!) !== WEEK)
      throw assetHistoryError("sbi_asset_history_weekly_gap");
    const rows = view.transitions[time]!;
    for (const point of Object.values(rows)) {
      money(point.valuation);
      money(point.acquisitionCost);
      if (point.profitLoss !== null) money(point.profitLoss);
    }
    const aggregate = rows.ALL!;
    if (
      balances.get(time) !== aggregate.valuation ||
      acquisition.get(time) !== aggregate.acquisitionCost
    )
      throw assetHistoryError("sbi_asset_history_native_mismatch");
    for (const field of ["valuation", "acquisitionCost"] as const) {
      // Only holdCategories participates. WithoutDeposit still returns
      // nonzero deposit rows, and ALL must never be added to its own parts.
      const total = sumDecimals(
        view.holdCategories.map((category) => integerDecimal(rows[category]![field])),
      );
      if (!decimalEquals(total, integerDecimal(aggregate[field])))
        throw assetHistoryError("sbi_asset_history_total_mismatch");
    }
  }
  return times;
}

export function validateAssetHistory(value: unknown): AssetHistoryView[] {
  const views = assetHistoryViews(value);
  let calendar: string[] | undefined;
  for (const view of views) {
    if (view.transitions === null) continue;
    const times = validateView(view);
    if (calendar !== undefined && JSON.stringify(times) !== JSON.stringify(calendar))
      throw assetHistoryError("sbi_asset_history_weekly_gap");
    calendar = times;
  }
  return views;
}
