import { auditAssetHistoryJson } from "./sbi-asset-history-json.ts";
import { exactKeys, exactMoney, normalizedDate, strictObject, strictString } from "./sbi-strict.ts";
import {
  decimalFromString,
  decimalToString,
  normalizeDecimal,
  DECIMAL_DIGIT_LIMIT,
} from "../../../domain/src/values.ts";

export type IncomeHistoryKind = "income" | "gains";
export const INCOME_HISTORY_SCHEMA = "sbi-provider-income-history-v1";
export const INCOME_HISTORY_START = "2021-08-01";
export const INCOME_HISTORY_PAGE_SIZE = 30;
export type IncomeHistoryCode =
  | "sbi_income_history_schema"
  | "sbi_income_history_money"
  | "sbi_income_history_range"
  | "sbi_income_history_count"
  | "sbi_income_history_unknown_code"
  | "sbi_income_history_pagination_unobserved"
  | "sbi_income_history_fetch_failed"
  | "sbi_income_history_source_inventory";
export class IncomeHistoryError extends Error {
  readonly code: IncomeHistoryCode;
  constructor(code: IncomeHistoryCode) {
    super(code);
    this.code = code;
  }
}

export interface IncomeJson {
  /** Numbers here are exact original token strings, never binary floats. */
  exact: unknown;
  /** Type-only view: the shared reader replaces unsupported numeric tokens. */
  shape: unknown;
}

/** Reuse the bounded grammar/decoded-key walk before preserving every numeric token. */
export function readIncomeJson(text: string): IncomeJson {
  try {
    // This preflight never uses an inexact amount: nonintegral financial tokens
    // become stand-ins. Its result is used ONLY for the original JSON types.
    const shape = auditAssetHistoryJson(text);
    const exactText = text.replace(
      /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu,
      (token) => (token.startsWith('"') ? token : JSON.stringify(token)),
    );
    return { shape, exact: JSON.parse(exactText) as unknown };
  } catch {
    throw new IncomeHistoryError("sbi_income_history_schema");
  }
}

const INCOME_FIELDS = [
  "category",
  "dispositionDate",
  "accountType",
  "productCode",
  "productName",
  "quantity",
  "interestAmount",
  "dividendUnitCost",
  "dividendTotal",
  "specialDividend",
  "taxTotal",
  "incomeTax",
  "residentTax",
  "receivedAmount",
  "interestAmountLc",
  "dividendUnitCostLc",
  "dividendTotalLc",
  "specialDividendLc",
  "taxTotalLc",
  "incomeTaxLc",
  "residentTaxLc",
  "receivedAmountLc",
  "currencyCode",
] as const;
const GAIN_FIELDS = [
  "category",
  "contractDate",
  "dispositionDate",
  "accountType",
  "productCode",
  "productName",
  "transactionType",
  "quantity",
  "amount",
  "price",
  "acquisitionCost",
  "profitLoss",
] as const;
const INCOME_SUMMARY_FIELDS = [
  "receivedTotal",
  "dividendTotal",
  "taxTotal",
  "receivedTotalLc",
  "dividendTotalLc",
  "taxTotalLc",
  "count",
  "currencyCode",
  "category",
] as const;
const GAIN_SUMMARY_FIELDS = [
  "assetsErrorType",
  "total",
  "profitLoss",
  "profit",
  "loss",
  "profitLossLc",
  "profitLc",
  "lossLc",
] as const;
const GAIN_DETAIL_FIELDS = [
  "assetsErrorType",
  "assetsBalanceCategory",
  "total",
  "profitLoss",
  "profit",
  "loss",
  "profitLossLc",
  "profitLc",
  "lossLc",
  "currencyCode",
] as const;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = strictObject(value, "income history");
  exactKeys(result, keys, "income history");
  return result;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 30)
    throw new IncomeHistoryError("sbi_income_history_schema");
  return value as Record<string, unknown>[];
}
function shapeFields(
  value: unknown,
  keys: readonly string[],
  strings: readonly string[],
  nulls: readonly string[] = [],
): void {
  const row = object(value, keys);
  for (const key of keys) {
    const entry = row[key];
    if (nulls.includes(key) && entry === null) continue;
    if (strings.includes(key)) strictString(entry, "income history field", { max: 512 });
    else if (typeof entry !== "number" || !Number.isFinite(entry))
      throw new IncomeHistoryError("sbi_income_history_schema");
  }
}

/** Unknown secret-bearing keys/types are rejected before retaining ORIGINAL bytes. */
export function auditIncomeJson(
  parsed: IncomeJson,
  kind: IncomeHistoryKind,
  role: "rows" | "summary",
): void {
  try {
    if (role === "rows") {
      const key = kind === "income" ? "dividends" : "profitLosses";
      const body = object(parsed.shape, [key]);
      const keys = kind === "income" ? INCOME_FIELDS : GAIN_FIELDS;
      const strings =
        kind === "income"
          ? [
              "category",
              "dispositionDate",
              "accountType",
              "productCode",
              "productName",
              "currencyCode",
            ]
          : [
              "category",
              "contractDate",
              "dispositionDate",
              "accountType",
              "productCode",
              "productName",
              "transactionType",
            ];
      const nullable =
        kind === "income"
          ? INCOME_FIELDS.filter(
              (k) => !strings.includes(k) && k !== "quantity" && k !== "receivedAmount",
            ).concat("currencyCode")
          : [];
      for (const row of rows(body[key])) shapeFields(row, keys, strings, nullable);
    } else if (kind === "income") {
      const body = object(parsed.shape, ["dividendsSummaries", "receivedTotal", "countTotal"]);
      shapeFields(
        { receivedTotal: body["receivedTotal"], countTotal: body["countTotal"] },
        ["receivedTotal", "countTotal"],
        [],
      );
      for (const row of rows(body["dividendsSummaries"]))
        shapeFields(
          row,
          INCOME_SUMMARY_FIELDS,
          ["currencyCode", "category"],
          ["receivedTotalLc", "dividendTotalLc", "taxTotalLc", "currencyCode"],
        );
    } else {
      const body = object(parsed.shape, ["profitLossSummary", "profitLossSummaryDetails"]);
      shapeFields(body["profitLossSummary"], GAIN_SUMMARY_FIELDS, [], ["assetsErrorType"]);
      for (const row of rows(body["profitLossSummaryDetails"]))
        shapeFields(
          row,
          GAIN_DETAIL_FIELDS,
          ["assetsBalanceCategory", "currencyCode"],
          ["assetsErrorType", "profitLossLc", "profitLc", "lossLc", "currencyCode"],
        );
    }
  } catch {
    throw new IncomeHistoryError("sbi_income_history_schema");
  }
}

/** Exact source notation, including scientific spelling, before any Number conversion. */
export function incomeDecimal(value: unknown): string {
  try {
    const token = strictString(value, "income decimal", { max: DECIMAL_DIGIT_LIMIT });
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) throw new Error();
    const [mantissa, power] = token.split(/[eE]/u);
    const parsed = decimalFromString(mantissa!);
    const exponent = Number(power ?? 0);
    if (!parsed.ok || !Number.isSafeInteger(exponent) || Math.abs(exponent) > DECIMAL_DIGIT_LIMIT)
      throw new Error();
    const decimal = normalizeDecimal(
      BigInt(parsed.value.coefficient),
      parsed.value.scale - exponent,
    );
    const text = decimalToString(decimal);
    if (text.length > DECIMAL_DIGIT_LIMIT) throw new Error();
    return text;
  } catch {
    throw new IncomeHistoryError("sbi_income_history_money");
  }
}
function count(value: unknown): number {
  const text = incomeDecimal(value);
  if (!/^(?:0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(Number(text)))
    throw new IncomeHistoryError("sbi_income_history_count");
  return Number(text);
}
export function incomeMoney(value: unknown, currency: string) {
  try {
    return exactMoney(incomeDecimal(value), currency, "income history money");
  } catch {
    throw new IncomeHistoryError("sbi_income_history_money");
  }
}
function date(value: unknown): string {
  const text = strictString(value, "income date", { pattern: /^\d{8}$/u });
  return normalizedDate(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`, "income date");
}
function code(value: unknown, allowed: readonly unknown[]): void {
  if (!allowed.includes(value)) throw new IncomeHistoryError("sbi_income_history_unknown_code");
}

export interface IncomeHistoryBundle {
  schemaVersion: typeof INCOME_HISTORY_SCHEMA;
  kind: IncomeHistoryKind;
  requestedRange: { from: string; to: string };
  /** Exact source texts ensure the parser rechecks ORIGINAL numeric tokens. */
  summaryText: string;
  rowsText: string;
  allSummaryText: string | null;
}
export interface IncomeHistoryData {
  bundle: IncomeHistoryBundle;
  records: Record<string, unknown>[];
  totalCount: number;
}

function checkedSummary(text: string, kind: IncomeHistoryKind) {
  const parsed = readIncomeJson(text);
  auditIncomeJson(parsed, kind, "summary");
  const body = parsed.exact as Record<string, unknown>;
  let total: number;
  let categories: Record<string, unknown>[];
  if (kind === "income") {
    total = count(body["countTotal"]);
    incomeMoney(body["receivedTotal"], "JPY");
    categories = body["dividendsSummaries"] as Record<string, unknown>[];
    for (const row of categories) {
      code(row["category"], ["DOMESTIC_STOCK_SPOT", "FOREIGN_STOCK_US"]);
      code(row["currencyCode"], row["category"] === "FOREIGN_STOCK_US" ? ["USD"] : [null]);
      for (const key of ["receivedTotal", "dividendTotal", "taxTotal"])
        incomeMoney(row[key], "JPY");
      for (const key of ["receivedTotalLc", "dividendTotalLc", "taxTotalLc"])
        if (row[key] !== null) incomeMoney(row[key], "USD");
    }
  } else {
    const summary = body["profitLossSummary"] as Record<string, unknown>;
    code(summary["assetsErrorType"], [null]);
    total = count(summary["total"]);
    for (const key of ["profitLoss", "profit", "loss"]) incomeMoney(summary[key], "JPY");
    for (const key of ["profitLossLc", "profitLc", "lossLc"]) incomeDecimal(summary[key]);
    categories = body["profitLossSummaryDetails"] as Record<string, unknown>[];
    for (const row of categories) {
      code(row["assetsErrorType"], [null]);
      code(row["assetsBalanceCategory"], ["DOMESTIC_STOCK_SPOT"]);
      code(row["currencyCode"], [null]);
      for (const key of ["profitLossLc", "profitLc", "lossLc"]) code(row[key], [null]);
      for (const key of ["profitLoss", "profit", "loss"]) incomeMoney(row[key], "JPY");
    }
  }
  const categoryKey = kind === "income" ? "category" : "assetsBalanceCategory";
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const row of categories) {
    const key = String(row[categoryKey]);
    if (seen.has(key)) throw new IncomeHistoryError("sbi_income_history_count");
    seen.add(key);
    counts.set(key, count(row[kind === "income" ? "count" : "total"]));
  }
  if ([...counts.values()].reduce((sum, n) => sum + n, 0) !== total)
    throw new IncomeHistoryError("sbi_income_history_count");
  if (total > INCOME_HISTORY_PAGE_SIZE)
    throw new IncomeHistoryError("sbi_income_history_pagination_unobserved");
  return { total, counts };
}

/** Coverage and semantic checks are identical in collection and parsing. */
export function validateIncomeHistory(input: unknown, kind: IncomeHistoryKind): IncomeHistoryData {
  try {
    const body = object(input, [
      "schemaVersion",
      "kind",
      "requestedRange",
      "summaryText",
      "rowsText",
      "allSummaryText",
    ]);
    if (body["schemaVersion"] !== INCOME_HISTORY_SCHEMA || body["kind"] !== kind)
      throw new IncomeHistoryError("sbi_income_history_schema");
    const range = object(body["requestedRange"], ["from", "to"]);
    const to = normalizedDate(range["to"], "income range");
    if (range["from"] !== INCOME_HISTORY_START || range["to"] !== to || to < INCOME_HISTORY_START)
      throw new IncomeHistoryError("sbi_income_history_range");
    const summary = checkedSummary(
      strictString(body["summaryText"], "income summary", { max: 16 * 1024 * 1024 }),
      kind,
    );
    if (kind === "gains") {
      const all = checkedSummary(
        strictString(body["allSummaryText"], "income summary", { max: 16 * 1024 * 1024 }),
        kind,
      );
      if (all.total !== summary.total) throw new IncomeHistoryError("sbi_income_history_count");
    } else if (body["allSummaryText"] !== null)
      throw new IncomeHistoryError("sbi_income_history_schema");
    const parsed = readIncomeJson(
      strictString(body["rowsText"], "income rows", { max: 16 * 1024 * 1024 }),
    );
    auditIncomeJson(parsed, kind, "rows");
    const records = (parsed.exact as Record<string, unknown>)[
      kind === "income" ? "dividends" : "profitLosses"
    ] as Record<string, unknown>[];
    if (records.length !== summary.total) throw new IncomeHistoryError("sbi_income_history_count");
    const counts = new Map<string, number>();
    for (const row of records) {
      const category = String(row["category"]);
      code(
        category,
        kind === "income" ? ["DOMESTIC_STOCK_SPOT", "FOREIGN_STOCK_US"] : ["DOMESTIC_STOCK_SPOT"],
      );
      code(row["accountType"], ["SPECIFIC_NORMAL", "NISA_GROWTH"]);
      for (const key of ["productCode", "productName"])
        strictString(row[key], "income product", { max: 512 });
      const asOf = date(row[kind === "income" ? "dispositionDate" : "contractDate"]);
      if (asOf < INCOME_HISTORY_START || asOf > to || date(row["dispositionDate"]) < asOf)
        throw new IncomeHistoryError("sbi_income_history_range");
      if (incomeDecimal(row["quantity"]).startsWith("-"))
        throw new IncomeHistoryError("sbi_income_history_money");
      counts.set(category, (counts.get(category) ?? 0) + 1);
      if (kind === "income") {
        code(row["currencyCode"], category === "FOREIGN_STOCK_US" ? ["USD"] : [null]);
        for (const key of [
          "interestAmount",
          "specialDividend",
          "interestAmountLc",
          "specialDividendLc",
        ])
          code(row[key], [null]);
        for (const suffix of ["", "Lc"]) {
          if (category === "DOMESTIC_STOCK_SPOT" && suffix === "Lc") {
            for (const key of [
              "dividendUnitCost",
              "dividendTotal",
              "taxTotal",
              "incomeTax",
              "residentTax",
              "receivedAmount",
            ])
              code(row[`${key}${suffix}`], [null]);
            continue;
          }
          if (row[`dividendUnitCost${suffix}`] !== null)
            incomeDecimal(row[`dividendUnitCost${suffix}`]);
          for (const key of [
            "dividendTotal",
            "taxTotal",
            "incomeTax",
            "residentTax",
            "receivedAmount",
          ])
            if (row[`${key}${suffix}`] !== null)
              incomeMoney(row[`${key}${suffix}`], suffix ? "USD" : "JPY");
        }
        if (row[category === "FOREIGN_STOCK_US" ? "receivedAmountLc" : "receivedAmount"] === null)
          throw new IncomeHistoryError("sbi_income_history_money");
      } else {
        code(row["transactionType"], ["SELL"]);
        for (const key of ["amount", "profitLoss"]) incomeMoney(row[key], "JPY");
        for (const key of ["price", "acquisitionCost"]) incomeDecimal(row[key]);
      }
    }
    if (
      [...summary.counts].some(([category, n]) => (counts.get(category) ?? 0) !== n) ||
      [...counts].some(([category]) => !summary.counts.has(category))
    )
      throw new IncomeHistoryError("sbi_income_history_count");
    return { bundle: body as unknown as IncomeHistoryBundle, records, totalCount: summary.total };
  } catch (cause) {
    if (cause instanceof IncomeHistoryError) throw cause;
    throw new IncomeHistoryError("sbi_income_history_schema");
  }
}
