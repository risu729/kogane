// Offline-only contracts for the 2026-10-10 yen ordinary-savings UI observation.
// Nothing here fetches, stores evidence, registers a parser, or enables a route.
import type { TransportRequest } from "../types";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 1000; // Local inspection budget, not a provider limit.
const DAY_MS = 86_400_000;
const ACTIVITY_FIELDS = [
  "type",
  "fromDate",
  "toDate",
  "purgeflag",
  "currentBalance",
  "accountNo",
  "currency",
] as const;
const ROW_FIELDS = [
  "txnReferenceNo",
  "description",
  "credit",
  "debit",
  "postingDate",
  "balance",
  "tradeTypeCode",
] as const;
const CSV_HEADER = ["取引日", "摘要", "出金金額", "入金金額", "残高", "メモ"] as const;

export type HistoryInspectionCode =
  | "history_request_invalid"
  | "history_response_unavailable"
  | "history_body_invalid"
  | "history_shape_unverified"
  | "history_provider_status_unverified"
  | "history_context_mismatch"
  | "history_rows_invalid"
  | "history_csv_charset_unverified"
  | "history_csv_shape_unverified"
  | "history_csv_rows_mismatch";

/** Closed codes only: no provider fields or values enter an exception. */
export class HistoryInspectionError extends Error {
  constructor(readonly code: HistoryInspectionCode) {
    super(code);
    this.name = "HistoryInspectionError";
  }
}

export interface ObservedYenPeriod {
  readonly accountNo: string;
  /** Observed wire format, YYYYMMDD. */
  readonly fromDate: string;
  readonly toDate: string;
}

export interface HistoryRow {
  readonly txnReferenceNo: string;
  readonly description: string;
  readonly credit: string;
  readonly debit: string;
  readonly postingDate: string;
  readonly balance: string;
  readonly tradeTypeCode: string;
}

export interface HistoryInspection {
  readonly outcome: "rows_observed" | "provider_reported_empty";
  readonly coverageStatus: "unknown";
  readonly reasonCodes: readonly string[];
  readonly requestContext: ObservedYenPeriod;
  readonly periodEchoVerified: boolean;
  readonly rows: readonly HistoryRow[];
  readonly memos: ReadonlyMap<string, string>;
}

function fail(code: HistoryInspectionCode): never {
  throw new HistoryInspectionError(code);
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("history_shape_unverified");
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(object, key))
  ) {
    return fail("history_shape_unverified");
  }
  return object;
}

function string(value: unknown): string {
  if (typeof value !== "string") return fail("history_shape_unverified");
  return value;
}

function nonempty(value: unknown): string {
  const text = string(value);
  if (text.length === 0) return fail("history_shape_unverified");
  return text;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) return fail("history_shape_unverified");
  return value;
}

function dateNumber(value: string, slash = false): number {
  const pattern = slash ? /^(\d{4})\/(\d{2})\/(\d{2})$/u : /^(\d{4})(\d{2})(\d{2})$/u;
  const match = pattern.exec(value);
  if (!match) return fail("history_request_invalid");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = Date.UTC(year, month - 1, day);
  const date = new Date(instant);
  if (
    year < 1000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return fail("history_request_invalid");
  }
  return instant;
}

function validatePeriod(scope: ObservedYenPeriod): void {
  if (
    typeof scope.accountNo !== "string" ||
    !/^\d{15}$/u.test(scope.accountNo) ||
    typeof scope.fromDate !== "string" ||
    typeof scope.toDate !== "string"
  ) {
    fail("history_request_invalid");
  }
  const start = dateNumber(scope.fromDate);
  const end = dateNumber(scope.toDate);
  // A deliberately small local budget; larger windows require separate evidence.
  if (end < start || (end - start) / DAY_MS >= 31) fail("history_request_invalid");
}

/** Explicit UI-selected yen period only; the existing catalog still refuses it. */
export function buildObservedYenPeriodRequest(scope: ObservedYenPeriod): TransportRequest {
  validatePeriod(scope);
  return {
    operation: "account.casa-activity-specific-period",
    body: {
      requestParam: {
        accountNo: scope.accountNo,
        type: "1",
        fromDate: scope.fromDate,
        toDate: scope.toDate,
        eventType: "3",
      },
    },
  };
}

function wrapper(value: unknown): { response: unknown; status: string; nationalId: string } {
  const block = exact(value, ["requestParam", "responseParam", "header", "errorInfo"]);
  const request = exact(block.requestParam, ["nationalid"]);
  const nationalId = nonempty(request.nationalid);
  const header = exact(block.header, ["referenceNo", "systemCode", "langCode"]);
  nonempty(header.referenceNo);
  nonempty(header.systemCode);
  nonempty(header.langCode);
  const error = exact(block.errorInfo, ["statusID", "statusMessage"]);
  string(error.statusMessage); // Validated, never included in diagnostics.
  return { response: block.responseParam, status: string(error.statusID), nationalId };
}

function decimal(value: string, allowEmpty = false): void {
  if ((allowEmpty && value === "") || /^-?\d+(?:\.\d+)?$/u.test(value)) return;
  fail("history_rows_invalid");
}

function row(value: unknown, scope: ObservedYenPeriod): HistoryRow {
  const object = exact(value, ROW_FIELDS);
  const result: HistoryRow = {
    txnReferenceNo: nonempty(object.txnReferenceNo),
    description: nonempty(object.description),
    credit: string(object.credit),
    debit: string(object.debit),
    postingDate: string(object.postingDate),
    balance: string(object.balance),
    tradeTypeCode: nonempty(object.tradeTypeCode),
  };
  decimal(result.credit, true);
  decimal(result.debit, true);
  decimal(result.balance);
  if ((result.credit === "") === (result.debit === "")) fail("history_rows_invalid");
  const posting = dateNumber(result.postingDate, true);
  if (posting < dateNumber(scope.fromDate) || posting > dateNumber(scope.toDate))
    fail("history_context_mismatch");
  return result;
}

/** Validates an already-observed decoded JSON response; makes no network call. */
export function inspectObservedHistoryResponse(
  scope: ObservedYenPeriod,
  response: {
    readonly status: number;
    readonly mediaType: string;
    readonly body: string;
  },
): HistoryInspection {
  validatePeriod(scope);
  if (response.status !== 200 || response.mediaType !== "application/json")
    fail("history_response_unavailable");
  if (new TextEncoder().encode(response.body).byteLength > MAX_BODY_BYTES)
    fail("history_body_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return fail("history_body_invalid");
  }
  const root = exact(parsed, ["requestParam", "responseParam", "header"]);
  const rootRequest = exact(root.requestParam, ["accountActivityDetails"]);
  if (array(rootRequest.accountActivityDetails).length !== 0) fail("history_shape_unverified");
  if (exact(root.header, ["adapterResultCode"]).adapterResultCode !== "0")
    fail("history_provider_status_unverified");
  const responseRecord = root.responseParam;
  if (
    typeof responseRecord !== "object" ||
    responseRecord === null ||
    Array.isArray(responseRecord)
  )
    fail("history_shape_unverified");
  const activity = wrapper((responseRecord as Record<string, unknown>).activity);
  const detail = exact(activity.response, [...ACTIVITY_FIELDS, "activityDetails"]);
  const rows = array(detail.activityDetails);
  const common = { coverageStatus: "unknown" as const, requestContext: { ...scope } };
  if (activity.status === "30224") {
    const empty = exact(responseRecord, ["activity", "sysTimeForCsvDownload"]);
    nonempty(empty.sysTimeForCsvDownload);
    if (rows.length !== 0 || ACTIVITY_FIELDS.some((key) => detail[key] !== ""))
      fail("history_shape_unverified");
    return {
      ...common,
      outcome: "provider_reported_empty",
      periodEchoVerified: false,
      rows: [],
      memos: new Map(),
      reasonCodes: ["history_empty_period_unconfirmed", "history_continuation_unverified"],
    };
  }
  if (activity.status !== "00000") fail("history_provider_status_unverified");
  const success = exact(responseRecord, [
    "activity",
    "memoInquiry",
    "summaryColumnTransformation",
    "sysTimeForCsvDownload",
  ]);
  nonempty(success.sysTimeForCsvDownload);
  for (const key of ACTIVITY_FIELDS) nonempty(detail[key]);
  if (
    detail.type !== "1" ||
    detail.accountNo !== scope.accountNo ||
    detail.currency !== "JPY" ||
    dateNumber(string(detail.fromDate), true) !== dateNumber(scope.fromDate) ||
    dateNumber(string(detail.toDate), true) !== dateNumber(scope.toDate)
  )
    fail("history_context_mismatch");
  decimal(string(detail.currentBalance));
  // purgeflag is preserved by the caller's evidence, not interpreted here.
  if (rows.length === 0) fail("history_shape_unverified");
  const verifiedRows = rows.map((value) => row(value, scope));
  const references = new Set(verifiedRows.map((value) => value.txnReferenceNo));
  if (references.size !== verifiedRows.length) fail("history_rows_invalid");
  const memos = new Map<string, string>();
  for (const [key, listKey, textKey] of [
    ["memoInquiry", "memoInquiryDetails", "memo"],
    ["summaryColumnTransformation", "descriptionTransformDetails", "descriptionTransform"],
  ] as const) {
    const block = wrapper(success[key]);
    if (block.status !== "00000") fail("history_provider_status_unverified");
    if (block.nationalId !== activity.nationalId) fail("history_context_mismatch");
    const items = array(exact(block.response, [listKey])[listKey]);
    const seen = new Set<string>();
    for (const item of items) {
      const object = exact(item, ["txnReferenceNo", textKey]);
      const reference = nonempty(object.txnReferenceNo);
      if (!references.has(reference) || seen.has(reference)) fail("history_rows_invalid");
      seen.add(reference);
      const text = string(object[textKey]);
      if (key === "memoInquiry") memos.set(reference, text);
    }
    if (seen.size !== references.size) fail("history_rows_invalid");
  }
  return {
    ...common,
    outcome: "rows_observed",
    periodEchoVerified: true,
    rows: verifiedRows,
    memos,
    reasonCodes: ["history_continuation_unverified", "history_purge_semantics_unverified"],
  };
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += char;
      continue;
    }
    if (char === '"') {
      if (field !== "" || closed) fail("history_csv_shape_unverified");
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (char === "\r" && text[index + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closed = false;
      index += 1;
      if (rows.length > MAX_ROWS + 1) fail("history_csv_shape_unverified");
    } else {
      if (closed || char === "\n" || char === "\r") fail("history_csv_shape_unverified");
      field += char;
    }
  }
  if (quoted) fail("history_csv_shape_unverified");
  if (row.length !== 0 || field !== "" || closed) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length > MAX_ROWS + 1) fail("history_csv_shape_unverified");
  return rows;
}

/**
 * CDP supplied decoded text, not the original Shift_JIS bytes. This checks that
 * limited observation only. No CSV replay builder exists: its session token
 * boundary and byte-exact download remain unverified.
 */
export function inspectObservedHistoryCsv(
  history: HistoryInspection,
  response: {
    readonly status: number;
    readonly contentType: string;
    readonly decodedText: string;
    /** Values observed on the actual CSV request, with tokens excluded. */
    readonly requestContext: ObservedYenPeriod;
  },
): {
  readonly rowCount: number;
  readonly coverageStatus: "unknown";
  readonly byteExact: false;
  readonly persisted: false;
} {
  validatePeriod(response.requestContext);
  if (response.status !== 200) fail("history_response_unavailable");
  if (!/^text\/csv\s*;\s*charset=Shift_JIS$/iu.test(response.contentType))
    fail("history_csv_charset_unverified");
  if (
    history.outcome !== "rows_observed" ||
    !history.periodEchoVerified ||
    response.requestContext.accountNo !== history.requestContext.accountNo ||
    response.requestContext.fromDate !== history.requestContext.fromDate ||
    response.requestContext.toDate !== history.requestContext.toDate
  )
    fail("history_context_mismatch");
  if (
    new TextEncoder().encode(response.decodedText).byteLength > MAX_BODY_BYTES ||
    response.decodedText.includes("\uFFFD")
  )
    fail("history_body_invalid");
  const rows = csvRows(response.decodedText);
  const header = rows.shift();
  if (
    !header ||
    header.length !== CSV_HEADER.length ||
    CSV_HEADER.some((value, index) => header[index] !== value)
  )
    fail("history_csv_shape_unverified");
  if (rows.length !== history.rows.length) fail("history_csv_rows_mismatch");
  for (let index = 0; index < rows.length; index += 1) {
    const csv = rows[index];
    const activity = history.rows[index];
    if (!csv || !activity || csv.length !== CSV_HEADER.length) fail("history_csv_shape_unverified");
    const expected = [
      activity.postingDate,
      activity.description,
      activity.debit,
      activity.credit,
      activity.balance,
      history.memos.get(activity.txnReferenceNo),
    ];
    if (expected.some((value, column) => value === undefined || value !== csv[column]))
      fail("history_csv_rows_mismatch");
  }
  return { rowCount: rows.length, coverageStatus: "unknown", byteExact: false, persisted: false };
}
