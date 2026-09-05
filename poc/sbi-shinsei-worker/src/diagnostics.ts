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
  constructor(readonly httpStatus: number, readonly responseReason = "unclassified-response") {
    super("SBI Shinsei container request failed");
    this.name = "ContainerResponseError";
  }
}

export function safeErrorType(error: unknown): string {
  try {
    return inspectErrorType(error);
  } catch { return "UnknownError"; }
}

/** Only exact SDK/runtime phrases or typed stop fields; never emit their text. */
export function containerLifecycleDetails(error: unknown): Record<string, string | number> {
  const details: Record<string, string | number> = { errorType: safeErrorType(error), reason: "unknown-lifecycle-error" };
  try {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const exit = /^(container exited with unexpected exit code|runtime signalled the container to exit): ([0-9]{1,3})$/u.exec(message);
    if (exit && Number(exit[2]) <= 255) {
      details.reason = exit[1] === "container exited with unexpected exit code" ? "process-exit" : "runtime-signal";
      details.exitCode = Number(exit[2]);
    } else {
      const reasons: Record<string, string> = {
        "Network connection lost.": "transport-disconnected",
        "there is no container instance that can be provided to this durable object": "instance-unavailable",
        "you are requesting too many containers per second": "instance-rate-limited",
        "the container is not listening": "port-not-listening",
        "Container crashed while checking for ports, did you start the container and setup the entrypoint correctly?": "startup-process-exit",
        "Aborted waiting for container to start as we received a cancellation signal": "startup-canceled",
      };
      if (Object.hasOwn(reasons, message)) details.reason = reasons[message]!;
    }
  } catch { /* A hostile accessor must not break the lifecycle hook. */ }
  return details;
}

export function containerStopDetails(params: unknown): Record<string, string | number> {
  const details: Record<string, string | number> = { reason: "unknown-stop" };
  try {
    if (!params || typeof params !== "object") return details;
    const { reason, exitCode } = params as { reason?: unknown; exitCode?: unknown };
    if (reason === "exit" || reason === "runtime_signal") details.reason = reason;
    if (typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) details.exitCode = exitCode;
  } catch { /* Best effort. */ }
  return details;
}

/** Consume only a small failed response; discard all text after classification. */
export async function containerResponseReason(response: Response, timeoutMs = 1_000): Promise<string> {
  try { return await inspectContainerResponse(response, timeoutMs); }
  catch { return "unclassified-response"; }
}

async function inspectContainerResponse(response: Response, timeoutMs: number): Promise<string> {
  if (response.status !== 500 || !response.body) return "unclassified-response";
  const reader = response.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2_048) return "unclassified-response";
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder().decode(bytes);
      if (text === "Container suddenly disconnected, try again") return "transport-disconnected";
      // Fixed SDK envelopes; the appended exception text is never emitted.
      if (text.startsWith("Failed to start container: ")) return "startup-failed";
      if (text.startsWith("Error proxying request to container: ")) return "proxy-failed";
      return "unclassified-response";
    } catch { return "unclassified-response"; }
    finally {
      try { void reader.cancel().catch(() => {}); } catch { /* Best effort. */ }
      try { reader.releaseLock(); } catch { /* A timed-out read may still be pending. */ }
    }
  };
  try {
    return await Promise.race([
      read(),
      new Promise<string>(resolve => { timeout = setTimeout(() => resolve("unclassified-response"), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
    // Canceling unblocks a pending read, but do not wait on a broken producer.
    try { void reader.cancel().catch(() => {}); } catch { /* Best effort. */ }
  }
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
    if (["transport-disconnected", "startup-failed", "proxy-failed"].includes(error.responseReason)) diagnostics.responseReason = error.responseReason;
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
