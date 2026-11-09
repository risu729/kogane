// Observed PowerDirect selected-period contract. Errors contain closed codes only.
import { exactObject, compactDate, decimal, nonEmptyString } from "./parsers/sbi-shinsei-common.ts";

export interface SavingsPeriodScope {
  accountNo: string;
  currency: string;
  productCode: string;
  fromDate: string;
  toDate: string;
}
export interface SavingsPeriodRow {
  txnReferenceNo: string;
  description: string;
  credit: string;
  debit: string;
  postingDate: string;
  balance: string;
  tradeTypeCode: string;
}
const bad = (): never => {
  throw new Error("history_response_invalid");
};
const exact = (value: unknown, keys: string[]) => exactObject(value, "history", keys, keys);
const strings = (value: Record<string, unknown>) => {
  for (const field of Object.values(value)) if (typeof field !== "string") bad();
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > 100_000) return bad();
  return value;
};
const fields = [
  "type",
  "fromDate",
  "toDate",
  "purgeflag",
  "currentBalance",
  "accountNo",
  "currency",
];
export function validateSavingsScope(value: unknown): SavingsPeriodScope {
  const scope = exact(value, ["accountNo", "currency", "productCode", "fromDate", "toDate"]);
  strings(scope);
  if (
    !/^\d{15}$/u.test(String(scope.accountNo)) ||
    !/^[A-Z]{3}$/u.test(String(scope.currency)) ||
    !/^\d{3}$/u.test(String(scope.productCode))
  )
    bad();
  const start = compactDate(scope.fromDate, "history"),
    end = compactDate(scope.toDate, "history");
  if (
    !/^\d{8}$/u.test(String(scope.fromDate)) ||
    !/^\d{8}$/u.test(String(scope.toDate)) ||
    start > end ||
    scope.fromDate !==
      String(Number(String(scope.toDate).slice(0, 4)) - 2) + String(scope.toDate).slice(4, 6) + "01"
  )
    bad();
  return scope as unknown as SavingsPeriodScope;
}
function wrapper(value: unknown) {
  const block = exact(value, ["requestParam", "responseParam", "header", "errorInfo"]);
  const request = exact(block.requestParam, ["nationalid"]);
  strings(request);
  nonEmptyString(request.nationalid, "history");
  strings(exact(block.header, ["referenceNo", "systemCode", "langCode"]));
  const error = exact(block.errorInfo, ["statusID", "statusMessage"]);
  strings(error);
  return { response: block.responseParam, status: error.statusID, nationalid: request.nationalid };
}
export function inspectSavingsPeriod(
  value: unknown,
  requested?: SavingsPeriodScope,
): {
  empty: boolean;
  rows: SavingsPeriodRow[];
  accountNo?: string;
  currency?: string;
  fromDate?: string;
  toDate?: string;
} {
  const root = exact(value, ["requestParam", "responseParam", "header"]);
  if (
    array(exact(root.requestParam, ["accountActivityDetails"]).accountActivityDetails).length !== 0
  )
    bad();
  const header = exactObject(
    root.header,
    "history",
    ["adapterResultCode", "newToken"],
    ["adapterResultCode"],
  );
  if (
    header.adapterResultCode !== "0" ||
    (header.newToken !== undefined && typeof header.newToken !== "string")
  )
    bad();
  const response = exactObject(
    root.responseParam,
    "history",
    ["activity", "memoInquiry", "summaryColumnTransformation", "sysTimeForCsvDownload"],
    ["activity", "sysTimeForCsvDownload"],
  );
  if (typeof response.sysTimeForCsvDownload !== "string") bad();
  const block = wrapper(response.activity),
    activity = exact(block.response, [...fields, "activityDetails"]);
  strings(Object.fromEntries(fields.map((key) => [key, activity[key]])));
  const rows = array(activity.activityDetails);
  if (block.status === "30024") {
    if (
      rows.length !== 0 ||
      fields.some((key) => activity[key] !== "") ||
      Object.keys(response).length !== 2
    )
      bad();
    return { empty: true, rows: [] };
  }
  if (
    block.status !== "00000" ||
    activity.type !== "1" ||
    activity.purgeflag !== "Y" ||
    rows.length === 0
  )
    bad();
  const accountNo = nonEmptyString(activity.accountNo, "history"),
    currency = nonEmptyString(activity.currency, "history");
  if (!/^[A-Z]{3}$/u.test(currency)) bad();
  const fromDate = compactDate(activity.fromDate, "history"),
    toDate = compactDate(activity.toDate, "history");
  if (fromDate > toDate) bad();
  if (
    requested &&
    (accountNo !== requested.accountNo ||
      currency !== requested.currency ||
      fromDate !== compactDate(requested.fromDate, "history") ||
      toDate !== compactDate(requested.toDate, "history"))
  )
    bad();
  decimal(activity.currentBalance, "history");
  const seen = new Set<string>();
  const verified = rows.map((value) => {
    const row = exact(value, [
      "txnReferenceNo",
      "description",
      "credit",
      "debit",
      "postingDate",
      "balance",
      "tradeTypeCode",
    ]);
    strings(row);
    const ref = nonEmptyString(row.txnReferenceNo, "history");
    if (seen.has(ref)) bad();
    seen.add(ref);
    nonEmptyString(row.description, "history");
    nonEmptyString(row.tradeTypeCode, "history");
    if ((row.credit === "") === (row.debit === "")) bad();
    const amount = decimal(row.credit === "" ? row.debit : row.credit, "history");
    if (amount.text.startsWith("-")) bad();
    decimal(row.balance, "history");
    const date = compactDate(row.postingDate, "history");
    if (date < fromDate || date > toDate) bad();
    return row as unknown as SavingsPeriodRow;
  });
  for (const [name, listKey, textKey] of [
    ["memoInquiry", "memoInquiryDetails", "memo"],
    ["summaryColumnTransformation", "descriptionTransformDetails", "descriptionTransform"],
  ] as const) {
    const enrichment = wrapper(response[name]);
    if (enrichment.status !== "00000" || enrichment.nationalid !== block.nationalid) bad();
    const entries = array(exact(enrichment.response, [listKey])[listKey]),
      refs = new Set<string>();
    for (const value of entries) {
      const row = exact(value, ["txnReferenceNo", textKey]);
      strings(row);
      const ref = nonEmptyString(row.txnReferenceNo, "history");
      if (!seen.has(ref) || refs.has(ref)) bad();
      refs.add(ref);
    }
    // First-response enrichment covers only the thirty visible rows; money rows are all returned.
    if (entries.length !== Math.min(30, rows.length)) bad();
  }
  return { empty: false, rows: verified, accountNo, currency, fromDate, toDate };
}
