import { hasExactKeys, isRecord } from "./guards.ts";
import { monthPeriod, parseLocalDate, type TemporalValue } from "./time.ts";
import { exactQuantity, integerDecimal, sumQuantities } from "./values.ts";

export const JPOINT_HISTORY_SCHEMA = "myjcb-jpoint-history-v1";
export const JPOINT_HISTORY_MAX_ROWS = 500;
export interface JPointAcquisitionRow {
  acquiredOn: string;
  paymentText: string;
  earned: string;
  used: string;
  expired: string;
  remaining: string;
  normal: string;
  preferential: string;
  bonus: string;
  expiryMonth: string | null;
  status: "-" | "有効";
}
export interface JPointHistory {
  schemaVersion: typeof JPOINT_HISTORY_SCHEMA;
  reportedTotal: string;
  rows: JPointAcquisitionRow[];
}
export function jpointHistoryFailure(code: string): never {
  throw new Error(`myjcb_jpoint_history_${code}`);
}
const integer = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && /^(?:0|-?[1-9]\d*)$/u.test(value);
const positive = (value: unknown): value is string => integer(value) && !value.startsWith("-");
export function jpointExpiry(row: Pick<JPointAcquisitionRow, "expiryMonth">): TemporalValue {
  if (row.expiryMonth === null)
    return { kind: "unknown", reasonCode: "zero_bucket_expiry_not_displayed" };
  return monthPeriod(
    Number(row.expiryMonth.slice(0, 4)),
    Number(row.expiryMonth.slice(5)),
    "Asia/Tokyo",
  );
}
export function readJPointHistory(value: unknown): JPointHistory {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "reportedTotal", "rows"]) ||
    value.schemaVersion !== JPOINT_HISTORY_SCHEMA ||
    !positive(value.reportedTotal) ||
    !Array.isArray(value.rows) ||
    value.rows.length < 1 ||
    value.rows.length > JPOINT_HISTORY_MAX_ROWS
  )
    return jpointHistoryFailure("schema_unsupported");
  const dates = new Set<string>();
  const rows = value.rows.map((value): JPointAcquisitionRow => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "acquiredOn",
        "paymentText",
        "earned",
        "used",
        "expired",
        "remaining",
        "normal",
        "preferential",
        "bonus",
        "expiryMonth",
        "status",
      ]) ||
      typeof value.acquiredOn !== "string" ||
      !parseLocalDate(value.acquiredOn) ||
      typeof value.paymentText !== "string" ||
      value.paymentText.length > 32 ||
      !integer(value.earned) ||
      !integer(value.used) ||
      !integer(value.expired) ||
      !positive(value.remaining) ||
      !integer(value.normal) ||
      !integer(value.preferential) ||
      !integer(value.bonus) ||
      (value.status !== "-" && value.status !== "有効") ||
      (value.expiryMonth !== null &&
        (typeof value.expiryMonth !== "string" ||
          !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value.expiryMonth)))
    )
      return jpointHistoryFailure("row_unsupported");
    if (dates.has(value.acquiredOn)) return jpointHistoryFailure("acquisition_duplicate");
    dates.add(value.acquiredOn);
    if (value.expiryMonth === null && value.remaining !== "0")
      return jpointHistoryFailure("positive_expiry_missing");
    if (value.remaining !== "0" && value.status !== "有効")
      return jpointHistoryFailure("positive_status_unobserved");
    const earned = sumQuantities(
      "points:j-point",
      [value.normal, value.preferential, value.bonus].map((part) =>
        exactQuantity("points:j-point", integerDecimal(BigInt(part))),
      ),
    );
    if (
      !earned.ok ||
      earned.quantity.value.status !== "exact" ||
      earned.quantity.value.value.coefficient !== value.earned ||
      earned.quantity.value.value.scale !== 0
    )
      return jpointHistoryFailure("earned_components_mismatch");
    return value as unknown as JPointAcquisitionRow;
  });
  const total = sumQuantities(
    "points:j-point",
    rows.map((row) => exactQuantity("points:j-point", integerDecimal(BigInt(row.remaining)))),
  );
  if (
    !total.ok ||
    total.quantity.value.status !== "exact" ||
    total.quantity.value.value.coefficient !== value.reportedTotal ||
    total.quantity.value.value.scale !== 0
  )
    return jpointHistoryFailure("overview_total_mismatch");
  return { schemaVersion: JPOINT_HISTORY_SCHEMA, reportedTotal: value.reportedTotal, rows };
}
