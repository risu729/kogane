export type CollectionMode = "daily" | "backfill";

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
  "chrome-stable-no-ua-all-tamia-default-automation",
  "chrome-stable-windows-matched-all-tamia",
  "chrome-stable-windows-matched-direct",
  "patchright-chrome-native-all-tamia",
  "patchright-chrome-native-direct",
  "chrome-direct-process-attach-late-all-tamia",
  "chrome-direct-process-attach-late-direct",
] as const;

export type ContainerProbeVariant = (typeof CONTAINER_PROBE_VARIANTS)[number];

export interface StoredArtifact {
  month: string;
  key: string;
  bytes: number;
  sha256: string;
}
export interface CollectionFailure {
  operation: string;
  errorType: string;
  message: string;
}

export interface CollectionManifest {
  schemaVersion: string;
  source: "prestia-globalpass";
  runtimeRevision?: string;
  runId: string;
  mode: CollectionMode;
  startedAt: string;
  completedAt: string;
  status: "success" | "partial" | "failed";
  availableMonths: string[];
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
  | { type: "error"; errorType: string; message: string };

export function parseMode(value: string | null): CollectionMode {
  if (value === null || value === "daily") return "daily";
  if (value === "backfill") return value;
  throw new Error("mode must be daily or backfill");
}

export function parseContainerProbeVariant(
  value: string | null,
): ContainerProbeVariant {
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

export function runPrefix(startedAt: string, runId: string): string {
  const date = startedAt.slice(0, 10).replaceAll("-", "/");
  return `raw/prestia-globalpass/${date}/${runId}`;
}
