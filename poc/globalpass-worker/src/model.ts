export type CollectionMode = "daily" | "backfill";

export const GLOBALPASS_SCHEMA_VERSION = "globalpass-browser-poc-v2" as const;
export const GLOBALPASS_DATASET = "globalpass-activity" as const;
export const GLOBALPASS_MEDIA_TYPE = "text/html" as const;
export const GLOBALPASS_PAGINATION_STATUS = "unproven" as const;

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
  key: string;
  mediaType: typeof GLOBALPASS_MEDIA_TYPE;
  bytes: number;
  sha256: string;
}
export interface CollectionFailure {
  operation: "browser-collection" | "contract" | "sanitization" | "r2";
  errorType: string;
  errorCode:
    | "browser_collection_failed"
    | "container_contract_invalid"
    | "html_sanitization_failed"
    | "artifact_store_failed"
    | "selected_month_missing";
  artifactKey?: string;
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
  | { type: "artifact"; month: string; html: string }
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

export function artifactFilename(month: string): string {
  return `activity-${safeMonth(month)}.html`;
}

export function strictCollectionStatus(
  artifacts: StoredArtifact[],
  failures: CollectionFailure[],
  selectedMonths: string[],
): { status: CollectionManifest["status"]; captureComplete: boolean } {
  const artifactMonths = artifacts.map((artifact) => safeMonth(artifact.month));
  if (new Set(artifactMonths).size !== artifactMonths.length) {
    throw new Error("duplicate GLOBAL PASS artifact month");
  }
  if (artifactMonths.some((month) => !selectedMonths.includes(month))) {
    throw new Error("GLOBAL PASS artifact month was not selected");
  }
  const expectedStoredOrder = selectedMonths.filter((month) => artifactMonths.includes(month));
  if (artifactMonths.some((month, index) => month !== expectedStoredOrder[index])) {
    throw new Error("GLOBAL PASS artifacts are not in selected month order");
  }
  const captureComplete =
    selectedMonths.length > 0 &&
    artifactMonths.length === selectedMonths.length &&
    artifactMonths.every((month, index) => month === selectedMonths[index]) &&
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
