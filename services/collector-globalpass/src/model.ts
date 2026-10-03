import type { ActivityPaginationCode } from "./pagination";
import type { GlobalPassSanitizerCode, GlobalPassSanitizerExpectation } from "./sanitize";

export type CollectionMode = "daily" | "backfill";

/**
 * v3 (2026-10-04): artifact records carry `page` and `pageCount`, a month is
 * stored as one artifact per page, and each manifest artifact names its page.
 */
export const GLOBALPASS_SCHEMA_VERSION = "globalpass-browser-poc-v3" as const;
export const GLOBALPASS_DATASET = "globalpass-activity" as const;
export const GLOBALPASS_MEDIA_TYPE = "text/html" as const;
/**
 * What the collector does with a month's pages: the container follows the
 * pager's Next link to the last page (at most `ACTIVITY_PAGE_CAP` pages) and
 * sends every page; the Worker stores each one and proves the month whole
 * against the pager's stated total (`pagination.ts`, ADR 0026's amendment of
 * 2026-10-04). It was `first_page_only` before.
 */
export const GLOBALPASS_PAGINATION_STATUS = "pages_walked" as const;

export const CONTAINER_PROBE_VARIANTS = [
  "baseline",
  "webdriver-false",
  "windows",
  "headed-windows",
  "headed-persistent-windows",
  "chrome-stable-headed-persistent-windows",
  "chrome-stable-no-ua-direct",
  "chrome-stable-no-ua-split",
  "chrome-stable-no-ua-all-tamia",
  "chrome-stable-no-ua-all-cloudflare-gateway",
  "chrome-stable-no-ua-all-tamia-default-automation",
  "chrome-stable-windows-matched-all-tamia",
  "chrome-stable-windows-matched-direct",
  "patchright-chrome-native-all-tamia",
  "patchright-chrome-native-direct",
  "chrome-direct-process-attach-late-all-tamia",
  "chrome-direct-process-attach-late-direct",
  "chromium-native-all-tamia",
] as const;

export type ContainerProbeVariant = (typeof CONTAINER_PROBE_VARIANTS)[number];

export interface StoredArtifact {
  dataset: typeof GLOBALPASS_DATASET;
  month: string;
  /** The page of the month, 1 for the page the month selection renders. */
  page: number;
  key: string;
  mediaType: typeof GLOBALPASS_MEDIA_TYPE;
  bytes: number;
  sha256: string;
}
export interface CollectionFailure {
  operation: "browser-collection" | "contract" | "sanitization" | "pagination" | "r2";
  errorType: string;
  errorCode:
    | "browser_collection_failed"
    | "container_contract_invalid"
    /** A sanitizer refusal that carried no closed code (none is thrown today). */
    | "html_sanitization_failed"
    /** Which check of `sanitizeGlobalPassActivityHtml` refused the page. */
    | GlobalPassSanitizerCode
    /** The month's pages are not proven whole (`pagination.ts`, `monthCoverageCode`). */
    | ActivityPaginationCode
    | "artifact_store_failed"
    | "selected_month_missing";
  artifactKey?: string;
  /**
   * On a sanitizer refusal only: which expectation of the sanitizer's
   * contract failed (ADR 0026's amendment of 2026-09-28). A closed code.
   */
  expectationCode?: GlobalPassSanitizerExpectation;
}

export interface CollectionManifest {
  schemaVersion: typeof GLOBALPASS_SCHEMA_VERSION;
  source: "prestia-globalpass";
  runtimeRevision?: string;
  runId: string;
  mode: CollectionMode;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  availableMonths: string[];
  selectedMonths: string[];
  captureComplete: boolean;
  paginationStatus: typeof GLOBALPASS_PAGINATION_STATUS;
  artifacts: StoredArtifact[];
  failures: CollectionFailure[];
}

export type ContainerRecord =
  | {
      type: "metadata";
      runtimeRevision?: string;
      availableMonths: string[];
      selectedMonths: string[];
      browserVersion: string;
    }
  | {
      type: "artifact";
      month: string;
      /** The walk's page number, 1..min(pageCount, ACTIVITY_PAGE_CAP), in order. */
      page: number;
      /** The page count the container read from the pager; 1 without a pager. */
      pageCount: number;
      html: string;
    }
  | {
      type: "error";
      operation: "browser-collection";
      errorType: string;
      errorCode: "browser_collection_failed";
    };

export function parseMode(value: string | null): CollectionMode {
  if (value === null || value === "daily") return "daily";
  if (value === "backfill") return value;
  throw new Error("mode must be daily or backfill");
}

export function parseContainerProbeVariant(value: string | null): ContainerProbeVariant {
  for (const candidate of CONTAINER_PROBE_VARIANTS) {
    if (value === candidate) return candidate;
  }
  throw new Error("unknown container probe variant");
}

export function safeMonth(value: string): string {
  if (!/^20\d{2}-(?:0[1-9]|1[0-2])$/u.test(value)) {
    throw new Error("GLOBAL PASS month has an unsafe format");
  }
  return value;
}

export function selectedMonthsForMode(mode: CollectionMode, availableMonths: string[]): string[] {
  assertCanonicalMonths(availableMonths, "availableMonths");
  return mode === "backfill" ? [...availableMonths] : availableMonths.slice(0, 2);
}

export function assertCanonicalMonths(values: string[], name: string): void {
  if (values.length === 0 || values.length > 15) {
    throw new Error(`${name} must contain between one and 15 months`);
  }
  const safe = values.map(safeMonth);
  if (new Set(safe).size !== safe.length) {
    throw new Error(`${name} contains duplicate months`);
  }
  const sorted = [...safe].sort().reverse();
  if (safe.some((month, index) => month !== sorted[index])) {
    throw new Error(`${name} must be reverse chronological`);
  }
  for (let index = 1; index < safe.length; index += 1) {
    if (previousMonth(safe[index - 1]!) !== safe[index]) {
      throw new Error(`${name} must be contiguous`);
    }
  }
}

/**
 * A month's page 1 keeps the key every earlier run used, so stored runs, the
 * parser's key check and the ledgers stay valid; page 2 onward is
 * page-qualified (`activity-YYYY-MM-p2.html`).
 */
export function artifactFilename(month: string, page = 1): string {
  if (!Number.isInteger(page) || page < 1 || page > 9) {
    throw new Error("GLOBAL PASS activity page is out of range");
  }
  return page === 1
    ? `activity-${safeMonth(month)}.html`
    : `activity-${safeMonth(month)}-p${page}.html`;
}

export function strictCollectionStatus(
  artifacts: StoredArtifact[],
  failures: CollectionFailure[],
  selectedMonths: string[],
): { status: CollectionManifest["status"]; captureComplete: boolean } {
  const artifactMonths = artifacts.map((artifact) => safeMonth(artifact.month));
  const months = artifactMonths.filter((month, index) => artifactMonths.indexOf(month) === index);
  if (months.some((month) => !selectedMonths.includes(month))) {
    throw new Error("GLOBAL PASS artifact month was not selected");
  }
  const expectedStoredOrder = selectedMonths.filter((month) => months.includes(month));
  if (months.some((month, index) => month !== expectedStoredOrder[index])) {
    throw new Error("GLOBAL PASS artifacts are not in selected month order");
  }
  // A month's pages are contiguous in the list, distinct and in walk order. A
  // page refused by the sanitizer leaves a gap, never a repeat.
  for (const month of months) {
    const pages = artifacts.slice(
      artifactMonths.indexOf(month),
      artifactMonths.lastIndexOf(month) + 1,
    );
    if (pages.some((artifact) => artifact.month !== month)) {
      throw new Error("GLOBAL PASS artifacts are not in selected month order");
    }
    for (let index = 1; index < pages.length; index += 1) {
      if (pages[index]!.page <= pages[index - 1]!.page) {
        throw new Error("duplicate GLOBAL PASS artifact page");
      }
    }
  }
  const captureComplete =
    selectedMonths.length > 0 &&
    months.length === selectedMonths.length &&
    months.every((month, index) => month === selectedMonths[index]) &&
    failures.length === 0;
  return {
    captureComplete,
    status: captureComplete ? "success" : artifacts.length === 0 ? "failed" : "partial",
  };
}

export function runPrefix(startedAt: string, runId: string): string {
  const date = startedAt.slice(0, 10).replaceAll("-", "/");
  return `raw/prestia-globalpass/${date}/${runId}`;
}

function previousMonth(value: string): string {
  const [yearText, monthText] = value.split("-");
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
