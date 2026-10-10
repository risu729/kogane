import { MIZUHO_CLIENT_ERROR_CODES, type MizuhoCollection } from "./client";

export type MizuhoPhase = "configuration" | "login" | "collection" | "persistence";
const ISSUE_CODES = new Set<string>([
  ...MIZUHO_CLIENT_ERROR_CODES,
  "account-limit",
  "history-pagination-unverified",
]);

/** Never copy provider fields, unit keys, exception text or session material. */
export function mizuhoCoverageDiagnostic(collection: MizuhoCollection | undefined) {
  const issueCodes = [
    ...new Set(
      (collection?.issues ?? []).map((code) =>
        ISSUE_CODES.has(code) ? code : "unclassified-collection-issue",
      ),
    ),
  ];
  return {
    providerOutcome:
      collection === undefined
        ? "failed"
        : collection.failedUnits.length > 0
          ? "partial"
          : "success",
    coverageStatus: collection?.partial ? "partial" : "unknown",
    coverageReason:
      collection === undefined
        ? "collection-unavailable"
        : collection.failedUnits.length > 0
          ? "collection-incomplete"
          : collection.partial
            ? "history-pagination-unverified"
            : "first-page-scope-unverified",
    accountCount: collection?.accounts.length ?? 0,
    historyCount: collection?.histories.length ?? 0,
    failedUnitCount: collection?.failedUnits.length ?? 0,
    issueCodes,
  };
}

/** Best effort only: a broken log sink must not change acquisition or persistence. */
export function logMizuhoRecord(record: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(record));
  } catch {
    /* Do not retry, replace the original result, or log the logger's error. */
  }
}

export function logMizuhoPhase(runId: string, phase: MizuhoPhase) {
  logMizuhoRecord({ event: "mizuho-collection-phase", runId, phase });
}
