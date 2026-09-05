import * as errors from "./errors";
import type { CollectionFailure } from "./types";

const FIXED_STAGES = new Set([
  "handoff-size", "handoff-json", "handoff-shape", "request-json", "request-shape",
  "container-busy", "container-internal", "navigation-page-unavailable", "navigation-cafis-unavailable",
  "login-form-unavailable", "login-button-disabled", "login-button-click-failed", "ui-login-response-timeout",
  "login-json", "login-shape", "login-rejected", "security-connect-timeout", "security-connect-shape",
  "validate-token-shape", "validate-token-result", "read-failed", "core-read-result-code",
  "unexpected-origin", "missing-input", "collector-unavailable", "cafis-generation", "credential-shape", "login-failed",
]);
const CONTAINER_STAGES = new Set([
  "chrome-start", "relay-start", "chrome-attach", "navigation-final-url", "navigation-cafis", "ui-input",
  "ui-waiters", "ui-click", "ui-login-response", "login-session", "security-connect", "authenticated-reads", "handoff",
]);
const READ_STAGES = "login|security-connect|validate-token|top-balances|balance-summary|exchange-rate|yen-deposit";
const READ_FAILURE = new RegExp(`^(${READ_STAGES})-(network|content-type|oversize|json|shape|invalid-token|result-code|failed|http-(?:0|[1-5][0-9]{2}))$`, "u");
const WORKER_STAGES = new Set(["credential-validation", "container-start", "container-request", "container-response", "browser-handoff", "staging-write", "manifest-write", "raw-evidence-import", "teardown", "relay-read", "relay-write", "container-lifecycle"]);

export function browserDiagnostics(stage: string): NonNullable<CollectionFailure["diagnostics"]> {
  const known = FIXED_STAGES.has(stage) || READ_FAILURE.test(stage) ||
    (stage.startsWith("container-") && CONTAINER_STAGES.has(stage.slice(10)));
  if (!known) return { stage: "unknown-browser-stage" };
  const http = stage.match(/-http-([1-5][0-9]{2})$/u);
  return { stage, ...(http ? { httpStatus: Number(http[1]) } : {}) };
}

export class BrowserCollectionError extends Error {
  constructor(readonly stage: string, readonly authenticationAttempted: boolean) {
    super(`SBI Shinsei browser collection stopped at ${browserDiagnostics(stage).stage}`);
    this.name = "BrowserCollectionError";
  }
}

export class ContainerResponseError extends Error {
  constructor(readonly httpStatus: number) {
    super("SBI Shinsei container request failed");
    this.name = "ContainerResponseError";
  }
}

export function safeErrorType(error: unknown): string {
  try {
    return inspectErrorType(error);
  } catch { return "UnknownError"; }
}

function inspectErrorType(error: unknown): string {
  if (error instanceof BrowserCollectionError) return "BrowserCollectionError";
  if (error instanceof ContainerResponseError) return "ContainerResponseError";
  // Constructor membership, never an arbitrary error.name supplied by a dependency.
  for (const [name, constructor] of Object.entries(errors)) {
    if (error instanceof constructor) return name;
  }
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  return error instanceof Error ? "Error" : "UnknownError";
}

export function failure(operation: string, error: unknown, stage = "browser-handoff"): CollectionFailure {
  const staging = operation.startsWith("r2:");
  const diagnostics: NonNullable<CollectionFailure["diagnostics"]> = error instanceof BrowserCollectionError
    ? { ...browserDiagnostics(error.stage), authenticationAttempted: error.authenticationAttempted === true }
    : { stage: staging ? "staging-write" : WORKER_STAGES.has(stage) ? stage : "unknown-worker-stage" };
  if (error instanceof ContainerResponseError && Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) {
    diagnostics.httpStatus = error.httpStatus;
  }
  return {
    operation,
    errorType: safeErrorType(error),
    message: staging ? "staging_write_failed" : "collector_request_failed",
    diagnostics,
  };
}

// The importer strictly accepts only these three keys. Keep its schema stable;
// retain allowlisted diagnostic values in the existing bounded source message.
export function manifestFailure(entry: CollectionFailure): CollectionFailure {
  const { operation, errorType, message, diagnostics } = entry;
  const suffix = diagnostics
    ? Object.entries(diagnostics).map(([key, value]) => `${key}=${value}`).join("; ")
    : "";
  return { operation, errorType, message: suffix ? `${message}; ${suffix}`.slice(0, 300) : message };
}

/** Observability must not abort collection, state persistence, or cleanup. */
export function emitDiagnostic(level: "log" | "warn" | "error", record: Record<string, unknown>): void {
  try { console[level](JSON.stringify(record)); }
  catch { /* Best effort, including serialization and logger failures. */ }
}

/** Static stage labels only; never serialize an exception or request. */
export function stageDiagnostics(runId: string) {
  const startedAt = Date.now();
  return {
    async step<T>(stage: string, action: () => Promise<T>, resultOutcome?: (value: T) => "success" | "partial" | "failed"): Promise<T> {
      const safeStage = WORKER_STAGES.has(stage) || stage === "collection" ? stage : "unknown-worker-stage";
      const start = Date.now();
      emitDiagnostic("log", { event: "sbi-shinsei-stage", runId, stage: safeStage, outcome: "started", durationMs: 0 });
      try {
        const value = await action();
        const outcome = resultOutcome?.(value) ?? "success";
        emitDiagnostic(outcome === "failed" ? "error" : outcome === "partial" ? "warn" : "log", { event: "sbi-shinsei-stage", runId, stage: safeStage, outcome, durationMs: Math.max(0, Date.now() - start) });
        return value;
      } catch (error) {
        emitDiagnostic(stage === "teardown" ? "warn" : "error", { event: "sbi-shinsei-stage", runId, stage: safeStage, outcome: "failed", durationMs: Math.max(0, Date.now() - start), errorType: safeErrorType(error) });
        throw error;
      }
    },
    terminal(status: "success" | "partial" | "failed"): void {
      emitDiagnostic("log", { event: "sbi-shinsei-stage", runId, stage: "terminal", outcome: status, durationMs: Math.max(0, Date.now() - startedAt) });
    },
  };
}
