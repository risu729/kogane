import { UnknownResponseShapeError } from "./errors";
import type { CollectionFailure, RawArtifact } from "./types";

const REPORT_DATASET = "monthly-report-pdf";
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_REPORT_PERIODS = 120;
const PERIOD = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/u;
const encoder = new TextEncoder();

function invalid(): never {
  throw new UnknownResponseShapeError("monthly_report_response_invalid");
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)))
    invalid();
  return object;
}
function root(value: unknown): Record<string, unknown> {
  const response = exact(value, ["responseParam", "header"]);
  const header = exact(
    response.header,
    response.header &&
      typeof response.header === "object" &&
      Object.hasOwn(response.header, "newToken")
      ? ["adapterResultCode", "newToken"]
      : ["adapterResultCode"],
  );
  if (
    header.newToken !== undefined &&
    (typeof header.newToken !== "string" ||
      header.newToken.length === 0 ||
      header.newToken.length > 4096)
  )
    invalid();
  if (header.adapterResultCode !== "0") invalid();
  if (
    !response.responseParam ||
    typeof response.responseParam !== "object" ||
    Array.isArray(response.responseParam)
  )
    invalid();
  return response.responseParam as Record<string, unknown>;
}
function reportPeriod(year: unknown, month: unknown): string {
  if (
    typeof year !== "string" ||
    !/^\d{4}$/u.test(year) ||
    year === "0000" ||
    typeof month !== "string" ||
    !/^(?:0[1-9]|1[0-2])$/u.test(month)
  )
    invalid();
  return `${year}-${month}`;
}
export function reportList(value: unknown): string[] {
  const response = exact(root(value), [
    "postingDate",
    "mailID",
    "eStatementStatus",
    "mfReportStatus",
    "slPostingDate",
    "periodDetails",
  ]);
  for (const field of [
    "postingDate",
    "mailID",
    "eStatementStatus",
    "mfReportStatus",
    "slPostingDate",
  ]) {
    if (typeof response[field] !== "string" || response[field].length > 4096) invalid();
  }
  if (!Array.isArray(response.periodDetails) || response.periodDetails.length > MAX_REPORT_PERIODS)
    invalid();
  const periods = response.periodDetails.map((value) => {
    const period = exact(value, ["year", "month"]);
    return reportPeriod(period.year, period.month);
  });
  if (new Set(periods).size !== periods.length) invalid();
  return periods.sort().reverse();
}
export function selectedReportPeriods(
  offered: readonly string[],
  stored: readonly string[],
): string[] {
  if (
    offered.length > MAX_REPORT_PERIODS ||
    stored.length > 1200 ||
    [...offered, ...stored].some((period) => !PERIOD.test(period)) ||
    new Set(offered).size !== offered.length ||
    new Set(stored).size !== stored.length
  )
    invalid();
  const sorted = [...offered].sort().reverse();
  const known = new Set(stored);
  return sorted.filter((period, index) => index === 0 || !known.has(period));
}
export function reportPdf(value: unknown, period: string): Uint8Array {
  if (!PERIOD.test(period)) invalid();
  const response = exact(root(value), [
    "postingDate",
    "month",
    "year",
    "fileName",
    "fileSize",
    "fileStream",
  ]);
  if (
    reportPeriod(response.year, response.month) !== period ||
    typeof response.postingDate !== "string" ||
    response.postingDate.length > 4096 ||
    typeof response.fileName !== "string" ||
    response.fileName.length > 4096 ||
    typeof response.fileSize !== "string" ||
    !/^[1-9]\d{0,6}$/u.test(response.fileSize)
  )
    invalid();
  const size = Number(response.fileSize);
  const encoded = response.fileStream;
  if (
    size < 5 ||
    size > MAX_REPORT_BYTES ||
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(MAX_REPORT_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  )
    invalid();
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    invalid();
  }
  if (btoa(decoded) !== encoded || decoded.length !== size || !decoded.startsWith("%PDF-"))
    invalid();
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
const failed = (): CollectionFailure => ({
  operation: "read:monthly-reports",
  errorType: "ResponseSchemaError",
  message: "provider_response_invalid",
});

/** Provider list/filenames/status fields remain transient; only PDF bytes leave this validator. */
export function parseMonthlyReports(
  value: unknown,
  stored: readonly string[],
): { artifacts: RawArtifact[]; failures: CollectionFailure[] } {
  const artifacts: RawArtifact[] = [];
  const failures: CollectionFailure[] = [];
  try {
    const handoff = exact(value, ["list", "downloads"]);
    if (
      typeof handoff.list !== "string" ||
      encoder.encode(handoff.list).byteLength > 2 * 1024 * 1024 ||
      !Array.isArray(handoff.downloads)
    )
      invalid();
    const selected = selectedReportPeriods(reportList(JSON.parse(handoff.list)), stored);
    if (handoff.downloads.length > selected.length) invalid();
    if (handoff.downloads.length !== selected.length) failures.push(failed());
    for (const [index, value] of handoff.downloads.entries()) {
      try {
        const entry =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : invalid();
        const hasError = Object.hasOwn(entry, "errorCode");
        exact(entry, hasError ? ["year", "month", "errorCode"] : ["year", "month", "raw"]);
        const period = reportPeriod(entry.year, entry.month);
        if (period !== selected[index]) invalid();
        if (hasError) {
          if (
            entry.errorCode !== "report_read_failed" &&
            entry.errorCode !== "report_budget_exceeded"
          )
            invalid();
          failures.push({
            operation: "read:monthly-reports",
            errorType: "ProviderReadError",
            message: "provider_read_failed",
          });
          continue;
        }
        if (typeof entry.raw !== "string" || encoder.encode(entry.raw).byteLength > 2 * 1024 * 1024)
          invalid();
        const bytes = reportPdf(JSON.parse(entry.raw), period);
        artifacts.push({
          dataset: REPORT_DATASET,
          filename: `monthly-report-${period}.pdf`,
          mediaType: "application/pdf",
          body: new Uint8Array(bytes).buffer,
        });
      } catch {
        failures.push(failed());
      }
    }
  } catch {
    failures.push(failed());
  }
  return { artifacts, failures };
}

/** Reuse registered immutable evidence as the checkpoint; no cursor or second index is written. */
export async function storedReportPeriods(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare(`SELECT DISTINCT substr(a.artifact_key,16,7) AS period
    FROM fetch_artifacts a JOIN fetch_run_seals s ON s.fetch_run_id=a.fetch_run_id
    JOIN fetch_units u ON u.id=a.fetch_unit_id AND u.fetch_run_id=a.fetch_run_id
    JOIN fetch_unit_reports r ON r.fetch_unit_id=u.id AND r.report_kind='terminal'
    WHERE a.source_id='sbi-shinsei-bank' AND a.artifact_role='provider_document'
      AND a.dataset='monthly-report-pdf' AND r.normalized_outcome='success'
      AND r.safe_failure_code IS NULL
      AND u.unit_key='monthly-report-' || substr(a.artifact_key,16,7)
      AND a.artifact_key='monthly-report-' || substr(a.artifact_key,16,7) || '-' || a.sha256 || '.pdf'
    ORDER BY period DESC LIMIT 1201`)
    .all<{ period: string }>();
  if (
    !result.success ||
    result.results.length > 1200 ||
    result.results.some(({ period }) => !PERIOD.test(period))
  )
    throw new Error("report_inventory_unavailable");
  return result.results.map(({ period }) => period);
}

export function validateReportResponse(
  schema: "list" | "download",
  value: unknown,
): Record<string, unknown> {
  if (schema === "list") reportList(value);
  else {
    const response = root(value);
    reportPdf(value, reportPeriod(response.year, response.month));
  }
  return value as Record<string, unknown>;
}
