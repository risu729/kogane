import {
  MIZUHO_CLIENT_ERROR_CODES,
  MIZUHO_PARSE_ERROR_CODES,
  MIZUHO_LOGIN_CHECKS,
  MIZUHO_LOGIN_FORMS,
  MIZUHO_HTTP_STATUS_CLASSES,
  MizuhoClientError,
  type MizuhoCollection,
} from "./client";

export type MizuhoPhase =
  | "configuration"
  | "login"
  | "collection"
  | "account-list"
  | "history"
  | "persistence";

/** Project only allow-listed scalar fields; never spread an exception object. */
export function mizuhoLoginDiagnostic(error: unknown) {
  if (!(error instanceof MizuhoClientError) || error.code !== "login-unrecognized-page") return {};
  const value = error.loginDiagnostic;
  if (
    !value ||
    !MIZUHO_LOGIN_CHECKS.includes(value.loginCheck) ||
    !MIZUHO_LOGIN_FORMS.includes(value.expectedForm) ||
    !MIZUHO_HTTP_STATUS_CLASSES.includes(value.httpStatusClass)
  )
    return {};
  return {
    loginCheck: value.loginCheck,
    expectedForm: value.expectedForm,
    httpStatusClass: value.httpStatusClass,
  };
}
const ISSUE_CODES = new Set<string>([
  ...MIZUHO_CLIENT_ERROR_CODES,
  ...MIZUHO_PARSE_ERROR_CODES,
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
