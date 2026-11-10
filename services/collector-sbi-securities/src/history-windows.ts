import type { Artifact } from "./types";

export interface HistoryWindow {
  from: string;
  to: string;
}
export type HistoryDataset = "domestic-trade-records" | "foreign-trade-records";
export type HistoryFailureCode =
  | "sbi_history_window_invalid"
  | "sbi_domestic_history_window_failed"
  | "sbi_domestic_history_truncated"
  | "sbi_domestic_history_range_mismatch"
  | "sbi_foreign_history_window_failed"
  | "sbi_foreign_history_page_invalid"
  | "sbi_foreign_history_page_limit"
  | "sbi_foreign_history_retention_unavailable";

export class SbiHistoryError extends Error {
  readonly code: HistoryFailureCode;
  constructor(code: HistoryFailureCode, options?: ErrorOptions) {
    super(code, options);
    this.code = code;
  }
}

export function jstDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function date(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new SbiHistoryError("sbi_history_window_invalid");
  return parsed;
}

export function addDays(value: string, days: number): string {
  const parsed = date(value);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** The earliest request in the successful historical domestic and US scans. */
export function historyYearStart(today: string): string {
  const parsed = date(today);
  return `${parsed.getUTCFullYear() - 2}-01-01`;
}

/** Newest first: the normal last-90-days request remains the first window. */
export function historyWindows(range: HistoryWindow): HistoryWindow[] {
  date(range.from);
  date(range.to);
  if (range.from > range.to) throw new SbiHistoryError("sbi_history_window_invalid");
  const windows: HistoryWindow[] = [];
  for (let to = range.to; to >= range.from;) {
    const candidate = addDays(to, -89);
    const from = range.from > candidate ? range.from : candidate;
    windows.push({ from, to });
    if (windows.length > 13) throw new SbiHistoryError("sbi_history_window_invalid");
    to = addDays(from, -1);
  }
  return windows;
}

/** The successful historical mobile scan began January 1 of year - pastYears. */
export function foreignHistoryRange(pastYears: unknown, today: string): HistoryWindow {
  date(today);
  if (pastYears !== 2) throw new SbiHistoryError("sbi_foreign_history_retention_unavailable");
  const range = { from: historyYearStart(today), to: today };
  historyWindows(range);
  return range;
}

export function sbiArtifactKey(artifact: Artifact): string {
  return artifact.artifactKey ?? `${artifact.dataset}.json`;
}

/** Every successful window survives a failure of a different window. */
export async function collectHistoryArtifacts(options: {
  dataset: HistoryDataset;
  range: HistoryWindow;
  collect: (window: HistoryWindow) => Promise<unknown>;
  onError?: (error: SbiHistoryError) => void;
}): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  for (const [index, window] of historyWindows(options.range).entries()) {
    try {
      const body = await options.collect(window);
      artifacts.push({
        dataset: options.dataset,
        mediaType: "application/json",
        body,
        window,
        ...(index === 0
          ? {}
          : { artifactKey: `${options.dataset}-${window.from}-${window.to}.json` }),
      });
    } catch (cause) {
      const error =
        cause instanceof SbiHistoryError
          ? cause
          : new SbiHistoryError(
              options.dataset === "domestic-trade-records"
                ? "sbi_domestic_history_window_failed"
                : "sbi_foreign_history_window_failed",
              { cause },
            );
      if (options.onError === undefined) throw error;
      options.onError(error);
    }
  }
  return artifacts;
}
