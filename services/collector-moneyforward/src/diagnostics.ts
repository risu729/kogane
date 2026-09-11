export type Stage =
  | "credential-load"
  | "login-entry"
  | "passkey-options"
  | "passkey-sign"
  | "passkey-assert"
  | "auth-redirect"
  | "accounts-index"
  | "account-selector"
  | "account-detail"
  | "monthly-detail"
  | "artifact-store"
  | "manifest-store";
export type Reason =
  | "unexpected-redirect"
  | "redirect-limit"
  | "missing-location"
  | "invalid-response"
  | "missing-csrf"
  | "missing-account-context"
  | "session-not-authenticated";

export class MoneyForwardHttpError extends Error {
  constructor(readonly status: number) {
    super("Money Forward HTTP request failed");
    this.name = "MoneyForwardHttpError";
  }
}
export class MoneyForwardProtocolError extends Error {
  constructor(
    readonly reasonCode: Reason,
    readonly status?: number,
  ) {
    super("Money Forward provider response was unexpected");
    this.name = "MoneyForwardProtocolError";
  }
}
interface SafeFailure {
  errorType: string;
  failureCode: string;
  httpStatus?: number;
  reasonCode?: Reason;
}
export function safeFailure(error: unknown): SafeFailure {
  try {
    const result: SafeFailure = { errorType: "UnknownError", failureCode: "operation_failed" };
    if (error instanceof MoneyForwardHttpError || error instanceof MoneyForwardProtocolError) {
      result.errorType =
        error instanceof MoneyForwardHttpError
          ? "MoneyForwardHttpError"
          : "MoneyForwardProtocolError";
      result.failureCode =
        error instanceof MoneyForwardHttpError
          ? "provider_http_failed"
          : "provider_protocol_failed";
      const status = error.status;
      if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
        result.httpStatus = status;
      const reason = error instanceof MoneyForwardProtocolError ? error.reasonCode : undefined;
      if (
        reason !== undefined &&
        new Set([
          "unexpected-redirect",
          "redirect-limit",
          "missing-location",
          "invalid-response",
          "missing-csrf",
          "missing-account-context",
          "session-not-authenticated",
        ]).has(reason)
      )
        result.reasonCode = reason;
    } else if (error instanceof Error) {
      const name = error.name;
      if (
        typeof name === "string" &&
        ["Error", "TypeError", "SyntaxError", "RangeError", "AbortError", "TimeoutError"].includes(
          name,
        )
      )
        result.errorType = name;
    }
    return result;
  } catch {
    return { errorType: "UnknownError", failureCode: "operation_failed" };
  }
}
export function logFailure(runId: string, stage: Stage, error: unknown): SafeFailure {
  const result = safeFailure(error);
  if (stage === "credential-load") result.failureCode = "credential_configuration_required";
  emit("error", {
    event: "collector-stage-failed",
    source: "moneyforward-me",
    runId,
    stage,
    ...result,
  });
  return result;
}
export function logStage(runId: string, stage: Stage): void {
  emit("log", { event: "collector-stage-started", source: "moneyforward-me", runId, stage });
}
export function logEvent(event: Record<string, unknown>): void {
  emit("log", event);
}
function emit(level: "log" | "error", event: Record<string, unknown>): void {
  try {
    console[level](JSON.stringify(event));
  } catch {
    /* Never change collection because logging failed. */
  }
}
