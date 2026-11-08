/**
 * What the container saw when a browser run failed, stored with that failed
 * run in R2 so the reason outlives the 7-day log retention: closed labels for
 * the stage, exception type and route refusal, the observed login POST count,
 * and the bank's visible notice text (headings and alerts on its own
 * non-account pages), redacted and bounded. The container applies the same
 * rules; this re-checks everything that crosses into the Worker.
 */
export interface RunDiagnostic {
  stage: string;
  errorType: string;
  refusal: string;
  loginPostCount: 0 | 1 | 2;
  durationMs: number;
  notices: string[];
}

// Mirrors RUNTIME_STAGES, RUNTIME_ERROR_TYPES and RUNTIME_REFUSALS in
// container/browser.mjs; test/run-diagnostic.test.ts keeps them equal.
export const RUN_STAGES: ReadonlySet<string> = new Set([
  "request-validation",
  "profile-create",
  "relay-start",
  "display-start",
  "browser-start",
  "browser-ready",
  "browser-connect",
  "extractor-load",
  "login-navigate",
  "login-state",
  "login-form",
  "credential-user-id",
  "credential-security-number",
  "credential-password",
  "login-pre-submit-state",
  "login-submit",
  "login-navigation",
  "login-result-state",
  "portfolio-extract",
  "portfolio-result-state",
  "portfolio-validate",
  "account-validate",
  "account-navigate",
  "account-state",
  "account-extract",
  "account-result-state",
  "snapshot-validate",
  "unknown",
]);
export const RUN_ERROR_TYPES: ReadonlySet<string> = new Set([
  "CollectionError",
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "TimeoutError",
  "AbortError",
  "DOMException",
  "unknown",
]);
export const RUN_REFUSALS: ReadonlySet<string> = new Set([
  "response-inspection",
  "route-other-origin",
  "route-userinfo",
  "route-fragment",
  "route-path",
  "route-invalid",
  "route-login-post",
  "route-changed",
  "result-route-not-portfolio",
  "portfolio-marker-missing",
  "unknown",
]);

export const MAX_NOTICES = 4;
export const MAX_NOTICE_CHARS = 160;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Number runs (any script) and email-shaped words are replaced; whitespace is collapsed. */
export function redactNotice(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\S*@\S*/gu, "[email]")
    .replace(/\p{N}(?:[\s./-]*\p{N})+/gu, "#")
    .replace(/\p{N}/gu, "#")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_NOTICE_CHARS);
}

/** The validated diagnostic, or undefined: a bad one never replaces the failure. */
export function parseRunDiagnostic(value: unknown): RunDiagnostic | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "durationMs,errorType,loginPostCount,notices,refusal,stage") return undefined;
  const { stage, errorType, refusal, loginPostCount, durationMs, notices } = input;
  if (
    typeof stage !== "string" ||
    !RUN_STAGES.has(stage) ||
    typeof errorType !== "string" ||
    !RUN_ERROR_TYPES.has(errorType) ||
    typeof refusal !== "string" ||
    !RUN_REFUSALS.has(refusal) ||
    (loginPostCount !== 0 && loginPostCount !== 1 && loginPostCount !== 2) ||
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_DURATION_MS ||
    !Array.isArray(notices) ||
    notices.length > MAX_NOTICES ||
    // The container sends at most this; anything longer is not its output, and
    // is refused before any pattern runs over it.
    !notices.every((notice) => typeof notice === "string" && notice.length <= MAX_NOTICE_CHARS)
  )
    return undefined;
  const kept: string[] = [];
  for (const notice of notices) {
    const redacted = redactNotice(notice);
    if (redacted && !kept.includes(redacted)) kept.push(redacted);
  }
  return { stage, errorType, refusal, loginPostCount, durationMs, notices: kept };
}
