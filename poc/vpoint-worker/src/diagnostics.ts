export type CollectionStage = "balance-read" | "artifact-store" | "manifest-store" | "central-import" |
  "session-load" | "email-challenge-request" | "smfg-read" | "history-read" |
  "vmoney-history-read" | "email-reconcile" | "session-invalidate" |
  "email-receive" | "email-parse" | "email-store" | "email-forward" |
  "email-code-parse" | "email-auth-complete" | "post-auth-collection";

const KNOWN_ERROR_TYPES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "VPointError", "VPointProtocolError", "VPointApplicationError", "VPointSessionExpiredError", "VPointReauthenticationPendingError"]);

export interface SafeFailure {
  errorType: string;
  failureCode: string;
  httpStatus?: number;
  applicationCode?: string;
  reasonCode?: string;
}

// Raw exception messages, stacks, URLs and provider bodies are never diagnostics.
export function safeFailure(error: unknown): SafeFailure {
  try { return inspectFailure(error); }
  catch { return { errorType: "UnknownError", failureCode: "operation_failed" }; }
}

function inspectFailure(error: unknown): SafeFailure {
  const rawName = error instanceof Error ? error.name : undefined;
  const name = typeof rawName === "string" ? rawName : "UnknownError";
  const errorType = KNOWN_ERROR_TYPES.has(name) ? name : "UnknownError";
  const failureCode = name.includes("CredentialConfiguration")
    ? "credential_configuration_required"
    : name.includes("ReauthenticationPending") ? "email_authentication_pending"
    : name.includes("ReauthenticationRequired") || name.includes("SessionExpired")
      ? "authentication_required"
      : name.includes("Protocol") ? "provider_protocol_failed"
      : name.includes("Application") ? "provider_application_failed"
      : name === "VPointError" || name.includes("HttpError") ? "provider_http_failed"
      : name === "TypeError" ? "runtime_type_error" : "operation_failed";
  const result: SafeFailure = { errorType, failureCode };
  if (error instanceof Error && KNOWN_ERROR_TYPES.has(name)) {
    const status = "status" in error ? error.status : undefined;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      result.httpStatus = status;
    }
    const reason = "reasonCode" in error ? error.reasonCode : undefined;
    if (typeof reason === "string" && new Set([
      "invalid-json", "missing-results", "empty-first-page", "pagination-total-changed",
      "premature-end", "page-limit", "invalid-total",
    ]).has(reason)) result.reasonCode = reason;
    const code = "applicationCode" in error ? error.applicationCode : undefined;
    if (typeof code === "string" && /^\d{4}$/u.test(code)) result.applicationCode = code;
  }
  return result;
}

export function logFailure(runId: string, stage: CollectionStage, error: unknown): SafeFailure {
  const detail = safeFailure(error);
  emit("error", {
    event: "collector-stage-failed",
    source: "v-point",
    runId,
    stage,
    ...detail,
  });
  return detail;
}

export function logStage(runId: string, stage: CollectionStage): void {
  emit("log", { event: "collector-stage-started", source: "v-point", runId, stage });
}

const AUTH_STEPS: Record<string, string> = {
  "/tm/pc/login/STKIp0018001.do": "login-entry",
  "/tm/pc/login/STKIp0002010.do": "member-entry",
  "/tm/pc/login/STKIp0002011.do": "auth-method",
  "/tm/pc/login/STKIp0002040.do": "email-confirm",
  "/tm/pc/login/STKIp0002042.do": "email-code-request",
  "/tm/pc/login/STKIp0002045.do": "email-code-submit",
  "/api/user_info": "session-initialize",
  "/api/balance_info": "session-probe",
};

export function logAuthTrace(runId: string, trace: { pathname: string; status: number }): void {
  try {
  emit("log", {
    event: "vpoint-auth-step",
    source: "v-point",
    runId,
    step: Object.hasOwn(AUTH_STEPS, trace.pathname) ? AUTH_STEPS[trace.pathname] : "other",
    httpStatus: Number.isInteger(trace.status) && trace.status >= 100 && trace.status <= 599 ? trace.status : undefined,
  });
  } catch { /* Diagnostics must never interrupt authentication. */ }
}

export function logEvent(event: Record<string, unknown>): void { emit("log", event); }

function emit(level: "log" | "error", event: Record<string, unknown>): void {
  try { console[level](JSON.stringify(event)); }
  catch { /* Observability failures cannot replace collector outcomes. */ }
}
