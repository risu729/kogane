import { readGateway, type Fetcher } from "./collector";
import { inspectPnlZip, type PnlCsvCounts } from "./pnl-zip";
import type { SharedCapture } from "./shared-collection";
import type {
  CollectionFailure,
  CollectionUnit,
  CollectorArtifact,
  ProviderDocument,
  ReadEvent,
  SessionMaterial,
} from "./types";

interface ReportRow {
  basisYmdDate: string;
}
const FIRST_OBSERVED_YEAR = 2018;
const PAGE_SIZE = 30;
const MAX_PAGES = 100;

export async function collectSbiVcDocuments(options: {
  session: SessionMaterial;
  captures: readonly SharedCapture[];
  cashflowsComplete: boolean;
  onSession: (session: SessionMaterial) => Promise<void>;
  onArtifact: (artifact: CollectorArtifact) => Promise<void>;
  diagnostic?: ReturnType<
    typeof import("../../../packages/collector-diagnostics/src/index").createDiagnostics
  >;
  fetcher?: Fetcher;
  now?: Date;
}): Promise<{ units: CollectionUnit[]; failures: CollectionFailure[] }> {
  let session = options.session;
  const units: CollectionUnit[] = [];
  const failures: CollectionFailure[] = [];
  const read = async (
    event: ReadEvent,
    data: Record<string, unknown>,
    mediaType: "application/json" | "application/pdf" | "application/zip" = "application/json",
  ) => {
    const action = () =>
      readGateway(
        options.fetcher ?? fetch,
        session,
        event,
        { ...data, secureKey: session.secureKey },
        mediaType,
      );
    const result = options.diagnostic
      ? await options.diagnostic.step(
          event === "tradeReportList"
            ? "gateway-report-list"
            : event === "monthlyTradeReport"
              ? "gateway-monthly-report"
              : "gateway-pnl-data",
          action,
        )
      : await action();
    session = result.session;
    await options.onSession(session);
    return result;
  };
  const failed = (unit: CollectionUnit, error: unknown) => {
    unit.status = "partial";
    unit.errorCode = safeError(error);
    failures.push({ operation: "reports", errorCode: unit.errorCode });
  };
  const year = Number(
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: "Asia/Tokyo" }).format(
      options.now ?? new Date(),
    ),
  );
  if (
    !Number.isSafeInteger(year) ||
    year < FIRST_OBSERVED_YEAR ||
    year - FIRST_OBSERVED_YEAR >= 100
  )
    throw new Error("report_year_range_invalid");
  const annual: CollectionUnit = { unitKey: "report-annual-index", status: "success" };
  try {
    const result = await read("tradeReportList", {
      statementType: "YEAR",
      getUnreadReportOnly: "false",
      pageSize: "30",
      pageNumber: "0",
    });
    await options.onArtifact({
      dataset: "report-annual-list-page-0001",
      body: result.sanitizedBody,
    });
    const body = result.body;
    if (!record(body) || !Array.isArray(body.list)) throw new Error("report_list_invalid");
    const total = integer(body.totalSize);
    if (
      total === undefined ||
      integer(body.pageNumber) !== 0 ||
      integer(body.totalNumOfPages) !== Math.ceil(total / PAGE_SIZE) ||
      body.list.length !== Math.min(total, PAGE_SIZE)
    )
      throw new Error("report_list_pagination_invalid");
    annual.observedCount = body.list.length;
    annual.expectedCount = total;
    annual.absenceMeaning = total === 0 ? "complete-empty" : "not-applicable";
    if (total !== 0) throw new Error("annual_report_download_unobserved");
  } catch (error) {
    failed(annual, error);
  }
  units.push(annual);
  for (let selectedYear = FIRST_OBSERVED_YEAR; selectedYear <= year; selectedYear += 1) {
    const index: CollectionUnit = { unitKey: `report-index-${selectedYear}`, status: "success" };
    const months: ReportRow[] = [];
    let pnl: ReportRow[] = [];
    const ids = new Set<string>();
    let total: number | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await read("tradeReportList", {
          statementType: "MONTH",
          fromBasisYmdDate: `${selectedYear}0101`,
          toBasisYmdDate: `${selectedYear}1231`,
          getUnreadReportOnly: "false",
          pageSize: String(PAGE_SIZE),
          pageNumber: String(page),
        });
        await options.onArtifact({
          dataset: `report-month-list-${selectedYear}-page-${String(page + 1).padStart(4, "0")}`,
          body: result.sanitizedBody,
        });
        const body = result.body;
        if (!record(body) || !Array.isArray(body.list)) throw new Error("report_list_invalid");
        const count = integer(body.totalSize);
        if (
          count === undefined ||
          integer(body.pageNumber) !== page ||
          integer(body.totalNumOfPages) !== Math.ceil(count / PAGE_SIZE) ||
          body.list.length !== Math.min(PAGE_SIZE, Math.max(0, count - page * PAGE_SIZE))
        )
          throw new Error("report_list_pagination_invalid");
        total ??= count;
        if (total !== count) throw new Error("report_list_total_changed");
        const rows = reportRows(body.list, "MONTH", selectedYear);
        for (const row of rows) {
          if (ids.has(row.basisYmdDate)) throw new Error("report_list_duplicate_identity");
          ids.add(row.basisYmdDate);
        }
        months.push(...rows);
        if ((page + 1) * PAGE_SIZE >= total) break;
        if (page + 1 === MAX_PAGES) throw new Error("report_list_page_limit");
      }
    } catch (error) {
      failed(index, error);
    }
    try {
      const result = await read("tradeReportList", {
        statementType: "TRADE_DATA",
        fromBasisYmdDate: `${selectedYear}0101`,
        toBasisYmdDate: `${selectedYear}1231`,
        getUnreadReportOnly: "false",
        pageSize: "30",
        pageNumber: "0",
      });
      await options.onArtifact({
        dataset: `report-pnl-list-${selectedYear}`,
        body: result.sanitizedBody,
      });
      if (
        !record(result.body) ||
        Object.keys(result.body).length !== 1 ||
        !Array.isArray(result.body.list)
      )
        throw new Error("pnl_list_shape_unobserved");
      if (result.body.list.length >= PAGE_SIZE) throw new Error("pnl_list_pagination_unconfirmed");
      pnl = reportRows(result.body.list, "TRADE_DATA", selectedYear);
    } catch (error) {
      failed(index, error);
    }
    units.push(index);
    for (const [kind, rows] of [
      ["monthly-report", months],
      ["pnl-data", pnl],
    ] as const) {
      for (const row of rows) {
        const unit: CollectionUnit = { unitKey: `${kind}-${row.basisYmdDate}`, status: "success" };
        let csv: PnlCsvCounts | undefined;
        try {
          const mediaType = kind === "monthly-report" ? "application/pdf" : "application/zip";
          const result = await read(
            kind === "monthly-report" ? "monthlyTradeReport" : "plCalcData",
            { basisYmDate: row.basisYmdDate },
            mediaType,
          );
          const bytes = decodeDocument(result.body, mediaType);
          const document: ProviderDocument = { kind, basisDate: row.basisYmdDate, mediaType };
          await options.onArtifact({
            dataset: kind === "monthly-report" ? "monthly-report-pdf" : "pnl-data-zip",
            body: bytes,
            document,
          });
          if (kind === "pnl-data") csv = await inspectPnlZip(bytes, row.basisYmdDate);
        } catch (error) {
          failed(unit, error);
        }
        units.push(unit);
        if (csv !== undefined) {
          const check: CollectionUnit = {
            unitKey: `pnl-check-${row.basisYmdDate}`,
            status: "success",
          };
          const counts: {
            csv: { executions: number; cashflows: number };
            api?: { executions: number; cashflows: number };
            status: "matched" | "unavailable" | "mismatch";
          } = {
            csv: { executions: csv.executions, cashflows: csv.cashflows },
            status: "unavailable",
          };
          try {
            const api = apiMonth(
              options.captures,
              row.basisYmdDate.slice(0, 6),
              options.cashflowsComplete,
            );
            counts.api = { executions: api.executionIds.size, cashflows: api.cashflows };
            if (
              api.executionIds.size !== csv.executions ||
              csv.executionIds.some((id) => !api.executionIds.has(id)) ||
              csv.executionIds.some(
                (id, index) => api.executionDates.get(id) !== csv.executionDates[index],
              ) ||
              api.cashflows !== csv.cashflows
            ) {
              counts.status = "mismatch";
              throw new Error("pnl_api_csv_mismatch");
            }
            counts.status = "matched";
          } catch (error) {
            failed(check, error);
          }
          try {
            await options.onArtifact({
              dataset: `pnl-check-${row.basisYmdDate}`,
              body: JSON.stringify({ schema: "sbi-vc-pnl-check-v1", ...counts }),
            });
          } catch (error) {
            failed(check, error);
          }
          units.push(check);
        }
      }
    }
  }
  return { units, failures };
}

function reportRows(list: unknown[], type: "MONTH" | "TRADE_DATA", year: number): ReportRow[] {
  const ids = new Set<string>();
  return list.map((row) => {
    if (
      !record(row) ||
      row.statementType !== type ||
      typeof row.reportTitle !== "string" ||
      typeof row.basisYmdDate !== "string" ||
      !validBasis(row.basisYmdDate, year)
    )
      throw new Error("report_row_unobserved");
    if (
      type === "MONTH" &&
      ((row.readStatus !== "0" && row.readStatus !== "1") ||
        typeof row.readStatusString !== "string")
    )
      throw new Error("report_status_unobserved");
    if (ids.has(row.basisYmdDate)) throw new Error("report_list_duplicate_identity");
    ids.add(row.basisYmdDate);
    return { basisYmdDate: row.basisYmdDate };
  });
}
function validBasis(value: string, year: number): boolean {
  if (!/^\d{8}$/u.test(value) || value.slice(0, 4) !== String(year)) return false;
  const date = new Date(Date.UTC(year, Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
  return date.toISOString().slice(0, 10).replaceAll("-", "") === value;
}
export function decodeDocument(
  body: unknown,
  mediaType: "application/pdf" | "application/zip",
): Uint8Array {
  if (
    !record(body) ||
    body.type !== "Buffer" ||
    !Array.isArray(body.data) ||
    body.data.length > 4 * 1024 * 1024 ||
    body.data.some(
      (byte) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255,
    )
  )
    throw new Error("report_buffer_invalid");
  const bytes = Uint8Array.from(body.data as number[]);
  if (
    mediaType === "application/pdf"
      ? new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
      : bytes.length < 4 ||
        bytes[0] !== 0x50 ||
        bytes[1] !== 0x4b ||
        bytes[2] !== 3 ||
        bytes[3] !== 4
  )
    throw new Error("report_signature_invalid");
  return bytes;
}
function apiMonth(captures: readonly SharedCapture[], month: string, cashflowsComplete: boolean) {
  if (!cashflowsComplete) throw new Error("pnl_api_incomplete");
  const executions = new Map<string, string>();
  const executionTuples = new Map<string, string>();
  const cashflows = new Map<string, string>();
  const required = new Set([
    "executions-recent-page-0001",
    "executions-historical-page-0001",
    "cashflows-all-recent-page-0001",
    "cashflows-all-historical-page-0001",
  ]);
  for (const capture of captures) {
    const execution = /^executions-(?:recent|historical)-page-\d{4}$/u.test(capture.dataset);
    const cashflow = /^cashflows-all-(?:recent|historical)-page-\d{4}$/u.test(capture.dataset);
    if (!execution && !cashflow) continue;
    required.delete(capture.dataset);
    if (typeof capture.body !== "string") throw new Error("pnl_api_shape_unobserved");
    const envelope: unknown = JSON.parse(capture.body);
    if (!record(envelope) || !record(envelope.body) || !Array.isArray(envelope.body.list))
      throw new Error("pnl_api_shape_unobserved");
    for (const row of envelope.body.list) {
      if (!record(row)) throw new Error("pnl_api_shape_unobserved");
      const date = row[execution ? "executionDatetime" : "eventDatetime"];
      if (typeof date !== "string" || !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/u.test(date))
        throw new Error("pnl_api_date_unobserved");
      if (date.slice(0, 7).replace("/", "") !== month) continue;
      if (
        execution
          ? typeof row.CExecutionId !== "string" || typeof row.CExecutionIdSubNo !== "string"
          : typeof row.cashflowID !== "string" || row.processStatusType !== "PROCESSED"
      )
        throw new Error("pnl_api_row_unobserved");
      const identity = execution
        ? `${row.CExecutionId}-${row.CExecutionIdSubNo}`
        : (row.cashflowID as string);
      const collection = execution ? executions : cashflows;
      if (execution) {
        const tuple = JSON.stringify([row.CExecutionId, row.CExecutionIdSubNo]);
        if (executionTuples.has(identity) && executionTuples.get(identity) !== tuple)
          throw new Error("pnl_api_duplicate_identity");
        executionTuples.set(identity, tuple);
      }
      if (collection.has(identity) && collection.get(identity) !== date)
        throw new Error("pnl_api_duplicate_identity");
      collection.set(identity, date);
    }
  }
  if (required.size !== 0) throw new Error("pnl_api_incomplete");
  return {
    executionIds: new Set(executions.keys()),
    executionDates: executions,
    cashflows: cashflows.size,
  };
}
const SAFE_REPORT_ERRORS = new Set([
  "annual_report_download_unobserved",
  "report_year_range_invalid",
  "report_list_invalid",
  "report_list_pagination_invalid",
  "report_list_total_changed",
  "report_list_duplicate_identity",
  "report_list_page_limit",
  "pnl_list_shape_unobserved",
  "pnl_list_pagination_unconfirmed",
  "report_row_unobserved",
  "report_status_unobserved",
  "report_buffer_invalid",
  "report_signature_invalid",
  "pnl_api_csv_mismatch",
  "pnl_api_incomplete",
  "pnl_api_shape_unobserved",
  "pnl_api_date_unobserved",
  "pnl_api_row_unobserved",
  "pnl_api_duplicate_identity",
  "pnl_zip_invalid",
  "pnl_csv_schema_unobserved",
  "pnl_csv_period_mismatch",
  "pnl_csv_execution_identity_invalid",
  "pnl_csv_invalid",
  "collector_non_json_response",
  "collector_gateway_rejected",
  "collector_invalid_gateway_envelope",
  "collector_response_too_large",
  "collector_missing_response_body",
  "invalid_document_artifact",
  "invalid_json_artifact",
  "invalid_artifact_dataset",
]);
function safeError(error: unknown): string {
  return error instanceof Error &&
    (SAFE_REPORT_ERRORS.has(error.message) || /^collector_http_[1-5]\d{2}$/u.test(error.message))
    ? error.message
    : "report_collection_failed";
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}
