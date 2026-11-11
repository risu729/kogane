import {
  exactKeys,
  exactMoney,
  normalizedDate,
  strictObject,
  strictSafeInteger,
  strictString,
} from "./sbi-strict.ts";
import {
  decimalEquals,
  integerDecimal,
  sumDecimals,
  type ExactDecimal,
} from "../../../domain/src/values.ts";

export type CashHistoryKind = "yen" | "foreign";
export const CASH_HISTORY_SCHEMA = "sbi-retained-cash-history-v1";
export const CASH_HISTORY_PAGE_SIZE = 10;
export const CASH_HISTORY_MAX_PAGES = 2000;
export type CashHistoryCode =
  | "sbi_cash_history_schema"
  | "sbi_cash_history_pagination"
  | "sbi_cash_history_total"
  | "sbi_cash_history_range"
  | "sbi_cash_history_unknown_code"
  | "sbi_cash_history_fetch_failed"
  | "sbi_cash_history_source_inventory"
  | "sbi_foreign_cash_pagination_unobserved";
export class CashHistoryError extends Error {
  readonly code: CashHistoryCode;

  constructor(code: CashHistoryCode) {
    // Native decoder causes may contain a provider response fragment.
    super(code);
    this.code = code;
  }
}
export interface CashHistoryBundle {
  schemaVersion: typeof CASH_HISTORY_SCHEMA;
  kind: CashHistoryKind;
  requestedRange: { from: string; to: string };
  pageSize: number;
  totalCount: number;
  pages: Record<string, unknown>[];
}
const YEN_KEYS = [
  "depositRecordList",
  "detailsConditions",
  "exceededMaxCount",
  "isExceededMaxCount",
  "pageCount",
  "pageNumber",
  "pageSize",
  "totalCount",
  "totalDepositAmount",
  "totalDepositCount",
  "totalPaymentAmount",
  "totalPaymentCount",
  "totalTransDepositAmount",
  "totalTransDepositCount",
  "totalTransPaymentAmount",
  "totalTransPaymentCount",
];
const YEN_ROW_KEYS = ["detailKbn", "did", "dispAbstract", "payAmount", "payDepDate", "payDepKbn"];
const FOREIGN_KEYS = ["pageCount", "totalCount", "items", "businessErrorMessage"];
const FOREIGN_ROW_KEYS = [
  "valueDate",
  "tradeType",
  "cashType",
  "cometCurrencyCode",
  "cometCurrencyName",
  "description",
  "amount",
];

/** Cash responses contain numeric metadata/ids only; monetary values are strings. */
export function parseCashHistoryJson(text: string): unknown {
  try {
    // Validate the ORIGINAL grammar before inspecting tokens. Inspection never
    // rewrites the input, and duplicate keys cannot hide an earlier field.
    const parsed: unknown = JSON.parse(text);
    const stack: (
      | { kind: "object"; keys: Set<string>; keyExpected: boolean }
      | { kind: "array" }
    )[] = [];
    for (const token of text.matchAll(
      /"(?:\\.|[^"\\])*"|[{}[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu,
    )) {
      const literal = token[0];
      const top = stack.at(-1);
      if (literal === "{") stack.push({ kind: "object", keys: new Set(), keyExpected: true });
      else if (literal === "[") stack.push({ kind: "array" });
      else if (literal === "}" || literal === "]") stack.pop();
      else if (literal === "," && top?.kind === "object") top.keyExpected = true;
      else if (literal.startsWith('"') && top?.kind === "object" && top.keyExpected) {
        const key = JSON.parse(literal) as string;
        if (top.keys.has(key)) throw new CashHistoryError("sbi_cash_history_schema");
        top.keys.add(key);
        top.keyExpected = false;
      } else if (
        /^-?\d/u.test(literal) &&
        (!/^(?:0|[1-9]\d*)$/u.test(literal) || !Number.isSafeInteger(Number(literal)))
      )
        throw new CashHistoryError("sbi_cash_history_schema");
    }
    return parsed;
  } catch {
    throw new CashHistoryError("sbi_cash_history_schema");
  }
}

export function cashRetentionRange(
  today: string,
  kind: CashHistoryKind,
): { from: string; to: string } {
  const to = normalizedDate(today, "cash history date");
  const [year, month, day] = to.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year - (kind === "yen" ? 2 : 5), month - 1, day));
  // The UI's 2/5-year presets begin the day after the anniversary. Feb 29
  // rolls to March 1 in a non-leap year, already the following calendar day.
  if (date.getUTCMonth() === month - 1) date.setUTCDate(date.getUTCDate() + 1);
  return { from: date.toISOString().slice(0, 10), to };
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    const result = strictObject(value, "cash history");
    exactKeys(result, keys, "cash history");
    return result;
  } catch {
    throw new CashHistoryError("sbi_cash_history_schema");
  }
}
function integer(value: unknown, minimum = 0, maximum = 20_000): number {
  return strictSafeInteger(value, "cash history count", { minimum, maximum });
}
function money(value: unknown, currency: "JPY" | "USD") {
  strictString(value, "cash history amount", { pattern: /^(?:0|[1-9]\d*)(?:\.\d+)?$/u });
  return exactMoney(value, currency, "cash history amount");
}

/** Only the observed closed response fields may enter raw financial storage. */
export function auditCashHistoryPage(value: unknown, kind: CashHistoryKind): void {
  const page = object(value, kind === "yen" ? YEN_KEYS : FOREIGN_KEYS);
  const rows = page[kind === "yen" ? "depositRecordList" : "items"];
  if (!Array.isArray(rows)) throw new CashHistoryError("sbi_cash_history_schema");
  for (const raw of rows) {
    const row = object(raw, kind === "yen" ? YEN_ROW_KEYS : FOREIGN_ROW_KEYS);
    for (const [key, entry] of Object.entries(row)) {
      if (
        key === "did"
          ? !Number.isSafeInteger(entry)
          : key === "cashType" && entry === null
            ? false
            : typeof entry !== "string"
      )
        throw new CashHistoryError("sbi_cash_history_schema");
    }
  }
  for (const [key, entry] of Object.entries(page)) {
    if (["depositRecordList", "items"].includes(key)) continue;
    if (key === "businessErrorMessage") {
      if (entry !== null) throw new CashHistoryError("sbi_cash_history_schema");
    } else if (key === "detailsConditions") {
      if (!Array.isArray(entry) || entry.some((v) => typeof v !== "string"))
        throw new CashHistoryError("sbi_cash_history_schema");
    } else if (["exceededMaxCount", "isExceededMaxCount"].includes(key)) {
      if (typeof entry !== "boolean") throw new CashHistoryError("sbi_cash_history_schema");
    } else if (["pageCount", "pageNumber", "pageSize", "totalCount"].includes(key)) {
      if (!Number.isSafeInteger(entry)) throw new CashHistoryError("sbi_cash_history_schema");
    } else if (typeof entry !== "string") throw new CashHistoryError("sbi_cash_history_schema");
  }
}

export function cashPageMetadata(value: unknown, kind: CashHistoryKind, pageNumber: number) {
  const page = object(value, kind === "yen" ? YEN_KEYS : FOREIGN_KEYS);
  const pageCount = integer(page["pageCount"], 0, CASH_HISTORY_MAX_PAGES);
  const totalCount = integer(page["totalCount"]);
  const records = page[kind === "yen" ? "depositRecordList" : "items"];
  if (!Array.isArray(records) || records.length > CASH_HISTORY_PAGE_SIZE)
    throw new CashHistoryError("sbi_cash_history_pagination");
  if (totalCount > 0 && pageCount !== Math.ceil(totalCount / CASH_HISTORY_PAGE_SIZE))
    throw new CashHistoryError("sbi_cash_history_pagination");
  if (totalCount === 0 && ![0, 1].includes(pageCount))
    throw new CashHistoryError("sbi_cash_history_pagination");
  if (kind === "yen") {
    if (
      page["exceededMaxCount"] !== false ||
      page["isExceededMaxCount"] !== false ||
      page["pageSize"] !== CASH_HISTORY_PAGE_SIZE ||
      !(
        page["pageNumber"] === pageNumber ||
        (totalCount === 0 && pageCount === 0 && page["pageNumber"] === 0)
      )
    )
      throw new CashHistoryError("sbi_cash_history_pagination");
    if (
      JSON.stringify(page["detailsConditions"]) !== JSON.stringify(["入金：すべて", "出金：すべて"])
    )
      throw new CashHistoryError("sbi_cash_history_schema");
    for (const prefix of [
      "totalDeposit",
      "totalPayment",
      "totalTransDeposit",
      "totalTransPayment",
    ]) {
      money(page[`${prefix}Amount`], "JPY");
      strictString(page[`${prefix}Count`], "cash history summary count", {
        pattern: /^(?:0|[1-9]\d*)$/u,
      });
      integer(Number(page[`${prefix}Count`]));
    }
  } else if (page["businessErrorMessage"] !== null)
    throw new CashHistoryError("sbi_cash_history_schema");
  const expectedRows =
    totalCount === 0
      ? 0
      : Math.min(CASH_HISTORY_PAGE_SIZE, totalCount - (pageNumber - 1) * CASH_HISTORY_PAGE_SIZE);
  if (records.length !== expectedRows || expectedRows < 0)
    throw new CashHistoryError("sbi_cash_history_total");
  return { page, records, pageCount, totalCount };
}

/** Validation is shared at collection and parse boundaries, before any row publishes. */
export function validateCashHistory(value: unknown, kind: CashHistoryKind): CashHistoryBundle {
  try {
    const bundle = object(value, [
      "schemaVersion",
      "kind",
      "requestedRange",
      "pageSize",
      "totalCount",
      "pages",
    ]);
    if (
      bundle["schemaVersion"] !== CASH_HISTORY_SCHEMA ||
      bundle["kind"] !== kind ||
      bundle["pageSize"] !== CASH_HISTORY_PAGE_SIZE
    )
      throw new CashHistoryError("sbi_cash_history_schema");
    const range = object(bundle["requestedRange"], ["from", "to"]);
    const from = normalizedDate(range["from"], "cash history range");
    const to = normalizedDate(range["to"], "cash history range");
    if (from !== cashRetentionRange(to, kind).from || range["from"] !== from || range["to"] !== to)
      throw new CashHistoryError("sbi_cash_history_range");
    const pages = bundle["pages"];
    if (!Array.isArray(pages) || pages.length === 0 || pages.length > CASH_HISTORY_MAX_PAGES)
      throw new CashHistoryError("sbi_cash_history_pagination");
    const first = cashPageMetadata(pages[0], kind, 1);
    if (bundle["totalCount"] !== first.totalCount || pages.length !== Math.max(1, first.pageCount))
      throw new CashHistoryError("sbi_cash_history_total");
    if (kind === "foreign" && first.pageCount > 1)
      throw new CashHistoryError("sbi_foreign_cash_pagination_unobserved");
    let previousDate = to;
    const seenIds = new Set<number>();
    const directional: Record<"入金" | "出金", ExactDecimal[]> = { 入金: [], 出金: [] };
    for (const [index, rawPage] of pages.entries()) {
      auditCashHistoryPage(rawPage, kind);
      const current = cashPageMetadata(rawPage, kind, index + 1);
      if (current.totalCount !== first.totalCount || current.pageCount !== first.pageCount)
        throw new CashHistoryError("sbi_cash_history_pagination");
      if (kind === "yen") {
        for (const key of YEN_KEYS.filter(
          (key) => key.startsWith("total") || key === "detailsConditions",
        ))
          if (JSON.stringify(current.page[key]) !== JSON.stringify(first.page[key]))
            throw new CashHistoryError("sbi_cash_history_total");
      }
      for (const rawRow of current.records) {
        const row = object(rawRow, kind === "yen" ? YEN_ROW_KEYS : FOREIGN_ROW_KEYS);
        const asOf = normalizedDate(
          row[kind === "yen" ? "payDepDate" : "valueDate"],
          "cash history row date",
        );
        if (asOf < from || asOf > to || asOf > previousDate)
          throw new CashHistoryError("sbi_cash_history_range");
        previousDate = asOf;
        if (kind === "yen") {
          const id = strictSafeInteger(row["did"], "cash history id", { minimum: 1 });
          if (seenIds.has(id)) throw new CashHistoryError("sbi_cash_history_pagination");
          seenIds.add(id);
          if (!["入金", "出金"].includes(String(row["payDepKbn"])))
            throw new CashHistoryError("sbi_cash_history_unknown_code");
          if (
            !["その他", "利金・配当金", "金融機関への出金", "金融機関からの入金"].includes(
              String(row["detailKbn"]),
            )
          )
            throw new CashHistoryError("sbi_cash_history_unknown_code");
          strictString(row["dispAbstract"], "cash history description", { empty: true, max: 512 });
          directional[row["payDepKbn"] as "入金" | "出金"].push(
            integerDecimal(money(row["payAmount"], "JPY").minor),
          );
        } else {
          if (
            row["cometCurrencyCode"] !== "011" ||
            row["cometCurrencyName"] !== "米ドル" ||
            !["入金", "出金"].includes(String(row["tradeType"])) ||
            ![null, "分配金", "配当金"].includes(row["cashType"] as null | string)
          )
            throw new CashHistoryError("sbi_cash_history_unknown_code");
          strictString(row["description"], "cash history description", { empty: true, max: 512 });
          money(row["amount"], "USD");
        }
      }
    }
    if (kind === "yen") {
      // The live response proved deposit/payment controls against every row.
      // Transfer controls were zero; their relationship to those totals has
      // not been observed, so positive transfers remain unsupported.
      for (const prefix of ["totalTransDeposit", "totalTransPayment"]) {
        if (
          first.page[`${prefix}Count`] !== "0" ||
          money(first.page[`${prefix}Amount`], "JPY").minor !== 0
        )
          throw new CashHistoryError("sbi_cash_history_unknown_code");
      }
      for (const [direction, prefix] of [
        ["入金", "totalDeposit"],
        ["出金", "totalPayment"],
      ] as const) {
        if (
          Number(first.page[`${prefix}Count`]) !== directional[direction].length ||
          !decimalEquals(
            sumDecimals(directional[direction]),
            integerDecimal(money(first.page[`${prefix}Amount`], "JPY").minor),
          )
        )
          throw new CashHistoryError("sbi_cash_history_total");
      }
    }
    return bundle as unknown as CashHistoryBundle;
  } catch (cause) {
    if (cause instanceof CashHistoryError) throw cause;
    throw new CashHistoryError("sbi_cash_history_schema");
  }
}
