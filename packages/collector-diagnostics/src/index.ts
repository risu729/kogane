// Operational metadata only. Never forward exception text, stack, URLs, or provider bodies.
const SOURCES = new Set([
  "mobile-suica",
  "myjcb",
  "sbi-securities",
  "sbi-vc-trade",
  "vpass",
  "smbc-direct",
  "prestia-globalpass",
]);
const STAGES = new Set([
  "configuration",
  "browser-bootstrap",
  "browser-collection",
  "history-collection",
  "pagination",
  "artifact-write",
  "manifest-write",
  "central-import",
  "connection-collection",
  "domestic-collection",
  "main-site-collection",
  "foreign-collection",
  "session-load",
  "session-persist",
  "collection",
  "reauthentication",
  "keepalive",
  "session-open",
  "card-selection",
  "statement-discovery",
  "statement-collection",
  "card-collection",
  "balance-collection",
  "transactions-collection",
  "progress-persist",
  "browser-close",
  "logout",
  "retry-scheduled",
  "container-start",
  "container-request",
  "container-destroy",
  "gateway-cash-balances",
  "gateway-account-margin",
  "gateway-position-summary",
  "gateway-executions-recent",
  "gateway-executions-historical",
  "gateway-cashflows-historical",
]);
const ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "TimeoutError",
  "AbortError",
  "DOMException",
  "DataError",
  "InvalidAccessError",
  "NotSupportedError",
  "OperationError",
  "HumanRequiredError",
  "StopConditionError",
  "HistoryBoundaryError",
]);
const SAFE_CODES = new Set([
  "history_request_failed",
  "history_session_expired",
  "history_response_invalid",
  "history_row_count_invalid",
  "history_boundary_unproven",
  "missing_session_seed",
  "missing_encryption_key",
  "missing_passkey_credential",
  "collector_non_json_response",
  "collector_gateway_rejected",
  "collector_invalid_gateway_envelope",
  "collector_missing_response_body",
  "collector_response_too_large",
  "session_seed_json_invalid",
  "transactions_service_time_unavailable",
  "transactions_rejected",
  "transactions_json_invalid",
  "challenge_expired",
  "challenge_missing",
  "session_missing",
  "approval_not_completed",
  "unknown-upstream-state",
  "passkey-browser-setup",
  "passkey-cdp-enable",
  "passkey-authenticator-add",
  "passkey-credential-add",
  "passkey-login-page",
  "passkey-control",
  "passkey-trigger",
  "passkey-assertion",
  "passkey-landing",
  "passkey-session-import",
  "collect-discovery",
  "collect-credit",
  "collect-credit-menu",
  "collect-credit-first-detail",
  "collect-credit-past-months",
  "collect-credit-month-fetch",
  "collect-credit-month-parse",
  "collect-credit-export",
  "credit-ledger-headers",
  "credit-ledger-item-cell",
  "credit-ledger-cell-count",
  "collect-debit",
]);

export interface SafeErrorDetails {
  category:
    | "http"
    | "timeout"
    | "network"
    | "configuration"
    | "authentication"
    | "response"
    | "unknown";
  errorType: string;
  httpStatus?: number;
  code?: string;
}

export function safeErrorDetails(error: unknown): SafeErrorDetails {
  try {
    return inspectError(error);
  } catch {
    return { category: "unknown", errorType: "UnknownError" };
  }
}

function inspectError(error: unknown): SafeErrorDetails {
  const name = error instanceof Error ? error.name : "UnknownError";
  const details: SafeErrorDetails = {
    category: "unknown",
    errorType: ERROR_TYPES.has(name) ? name : "UnknownError",
  };
  if (!(error instanceof Error)) return details;
  // An exception message is inspected only for known shapes; it is never emitted.
  const message = error.message;
  const status = Reflect.get(error, "httpStatus") ?? Reflect.get(error, "status");
  const knownStatus = /^(?:collector_http_|history_http_)([1-5][0-9]{2})$/u.exec(message)?.[1];
  const numericStatus =
    typeof status === "number" ? status : knownStatus ? Number(knownStatus) : undefined;
  if (
    numericStatus !== undefined &&
    Number.isInteger(numericStatus) &&
    numericStatus >= 100 &&
    numericStatus <= 599
  ) {
    details.httpStatus = numericStatus;
    details.category = "http";
  } else if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /^(?:Network connection lost\.?|fetch failed)$/u.test(message)
  ) {
    details.category = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
  } else if (
    /^Missing Worker secret(?: binding)?: [A-Z0-9_]+$/u.test(message) ||
    /^missing_(?:session_seed|encryption_key|passkey_credential)$/u.test(message)
  ) {
    details.category = "configuration";
  } else if (name === "HumanRequiredError" || message === "history_session_expired") {
    details.category = "authentication";
  } else if (name === "SyntaxError" || name === "StopConditionError" || SAFE_CODES.has(message)) {
    details.category = "response";
  }
  const code = Reflect.get(error, "code");
  if (typeof code === "string" && SAFE_CODES.has(code)) details.code = code;
  else if (SAFE_CODES.has(message)) details.code = message;
  return details;
}

export function createDiagnostics(source: string, runId: string) {
  const startedAt = Date.now();
  const safeSource = SOURCES.has(source) ? source : "unknown";
  const safeRunId =
    /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/iu.test(
      runId,
    )
      ? runId
      : "unknown";
  function emit(stage: string, outcome: string, durationMs: number, error?: unknown): void {
    const record = {
      event: "collector-diagnostic",
      source: safeSource,
      runId: safeRunId,
      stage: stage === "terminal" || STAGES.has(stage) ? stage : "unknown",
      outcome,
      durationMs: Math.max(0, durationMs),
      ...(outcome === "failed" ? safeErrorDetails(error) : {}),
    };
    // Observability must not change the result of a provider or storage operation.
    try {
      if (outcome === "failed") console.error(JSON.stringify(record));
      else console.log(JSON.stringify(record));
    } catch {
      /* Logging is best effort. */
    }
  }
  return {
    async step<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
      const start = Date.now();
      emit(stage, "started", 0);
      try {
        const result = await operation();
        emit(stage, "success", Date.now() - start);
        return result;
      } catch (error) {
        emit(stage, "failed", Date.now() - start, error);
        throw error;
      }
    },
    retry(stage: string, retryCount: number, retryScheduled: boolean): void {
      try {
        console.warn(
          JSON.stringify({
            event: "collector-retry",
            source: safeSource,
            runId: safeRunId,
            stage: STAGES.has(stage) ? stage : "unknown",
            retryCount: Number.isSafeInteger(retryCount) && retryCount >= 0 ? retryCount : 0,
            retryScheduled: retryScheduled === true,
          }),
        );
      } catch {
        /* Logging must not prevent the existing retry from being scheduled. */
      }
    },
    failure(stage: string, error: unknown): void {
      emit(stage, "failed", Date.now() - startedAt, error);
    },
    finish(status: "success" | "partial" | "failed"): void {
      emit("terminal", status, Date.now() - startedAt);
    },
  };
}
