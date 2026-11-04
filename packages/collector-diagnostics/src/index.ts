// Operational metadata only. Never forward exception text, stack, URLs, or provider bodies.
const SOURCES = new Set([
  "mobile-suica",
  "myjcb",
  "sbi-securities",
  "sbi-vc-trade",
  "vpass",
  "smbc-direct",
  "prestia-globalpass",
  "st-george",
]);
const STAGES = new Set([
  "configuration",
  "browser-bootstrap",
  "browser-collection",
  "history-collection",
  "pagination",
  "artifact-write",
  "manifest-write",
  // U09: the shared DATA target writes the run's terminal manifest instead of
  // a per-source collector manifest and a central import.
  "terminal-write",
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
  "GlobalPassSanitizerError",
]);
const SAFE_CODES = new Set([
  // St.George's closed refusal vocabulary; no provider error text is admitted.
  "human-required",
  "login-rejected",
  "bank-request-error",
  "network-error",
  "unexpected-page",
  "navigation-denied",
  "invalid-credentials",
  "invalid-snapshot",
  "container-failed",
  "collection-interrupted",
  "invalid-configuration",
  "invalid-request",
  "runtime-unavailable",
  "runtime-failed",
  "deadline-exceeded",
  "authentication-challenge",
  "http-denied",
  "unexpected-route",
  "login-layout-unknown",
  "session-expired",
  "navigation-failed",
  "snapshot-shape",
  "account-limit",
  "snapshot-limit",
  "download-blocked",
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
  "credit-menu-group",
  "collect-credit-first-detail",
  "collect-credit-past-months",
  "collect-credit-month-fetch",
  "collect-credit-month-parse",
  "collect-credit-export",
  "credit-ledger-headers",
  "credit-ledger-item-cell",
  "credit-ledger-cell-count",
  "credit-statement-state",
  "credit-statement-period",
  "collect-debit",
  // GLOBAL PASS: which check of the activity-page sanitizer refused a page.
  "globalpass_html_contract_invalid",
  "globalpass_html_redaction_failed",
  "globalpass_html_shape_unreviewed",
  "globalpass_html_utf8_invalid",
]);

// The closed strings a failure's `shape` may carry (GLOBAL PASS: which
// sanitizer expectation refused a page, on which element and attribute class,
// in which phase; ADR 0026's amendment of 2026-09-28). Any other string in a
// shape is dropped, so a shape can carry nothing but these, booleans and counts.
const SAFE_SHAPE_STRINGS = new Set([
  "unknown",
  "input",
  "output",
  // expectations
  "utf8_invalid",
  "doctype_missing",
  "activity_heading_missing",
  "forbidden_token",
  "sentinel_present",
  "size_out_of_range",
  "css_url",
  "blocked_element",
  "duplicate_attribute",
  "http_equiv_unallowed",
  "url_attribute",
  "action_unallowed",
  "href_unallowed",
  "src_unallowed",
  "event_handler_unallowed",
  "credential_field",
  "hidden_name_unallowed",
  "hidden_value_missing",
  "variant_unmatched",
  "redaction_count_mismatch",
  "redacted_value_unexpected",
  "variant_changed",
  // elements
  "a",
  "button",
  "form",
  "img",
  "link",
  "meta",
  "script",
  "select",
  "style",
  "applet",
  "audio",
  "base",
  "embed",
  "fencedframe",
  "frame",
  "frameset",
  "iframe",
  "object",
  "portal",
  "source",
  "svg",
  "track",
  "video",
  "other",
  // attribute classes
  "action",
  "event_handler",
  "href",
  "http_equiv",
  "id",
  "name",
  "src",
  "type",
  "value",
]);
// The closed keys a failure's `shape` may carry, at either level. Any other
// key is dropped, so no key can be built from what a page says.
const SAFE_SHAPE_KEYS = new Set([
  // the refusal
  "expectation",
  "phase",
  "element",
  "attribute",
  "summarized",
  "byteMagnitude",
  "textMagnitude",
  "elements",
  "contract",
  "landmarks",
  "forbiddenTokens",
  // elements: opening tags counted by name
  "table",
  "tr",
  "th",
  "td",
  "form",
  "input",
  "select",
  "button",
  "script",
  "style",
  "a",
  "link",
  "img",
  "meta",
  "title",
  "blocked",
  // contract: the counts the reviewed variants are defined by
  "forms",
  "staticActionForms",
  "hiddenInputs",
  "hiddenUnlisted",
  "cc",
  "engUseFlg",
  "nablarchHidden",
  "nablarchHiddenNonempty",
  "nablarchNeedsHiddenEncryption",
  "nablarchSubmit",
  "referenceDate",
  // landmarks
  "doctype",
  "activityHeading",
  "activityHeadingInTitle",
  "loginForm",
  "passwordField",
  "monthSelect",
  "sentinel",
  // forbiddenTokens
  "jsessionid",
  "token",
  "csrf",
  "turnstile",
  "session",
  "localStorage",
]);
const MAX_SHAPE_KEYS = 64;

type ShapeScalar = number | boolean | string;
export type SafeShape = Record<string, ShapeScalar | Record<string, ShapeScalar>>;

/**
 * Keeps only what a diagnostic `shape` may carry: at most two levels of
 * objects whose keys are in `SAFE_SHAPE_KEYS` and whose values are non-negative
 * safe integers, booleans or strings from `SAFE_SHAPE_STRINGS`. Everything
 * else is dropped. Returns `undefined` when nothing is left.
 */
export function safeShape(value: unknown): SafeShape | undefined {
  try {
    const outer = safeShapeLevel(value, true);
    return outer && Object.keys(outer).length > 0 ? (outer as SafeShape) : undefined;
  } catch {
    return undefined;
  }
}

function safeShapeLevel(
  value: unknown,
  nested: boolean,
): Record<string, ShapeScalar | Record<string, ShapeScalar>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, ShapeScalar | Record<string, ShapeScalar>> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_SHAPE_KEYS)) {
    if (!SAFE_SHAPE_KEYS.has(key)) continue;
    if (typeof entry === "boolean") result[key] = entry;
    else if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0) {
      result[key] = entry;
    } else if (typeof entry === "string" && SAFE_SHAPE_STRINGS.has(entry)) result[key] = entry;
    else if (nested) {
      const inner = safeShapeLevel(entry, false);
      if (inner && Object.keys(inner).length > 0) {
        result[key] = inner as Record<string, ShapeScalar>;
      }
    }
  }
  return result;
}

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
  function emit(
    stage: string,
    outcome: string,
    durationMs: number,
    error?: unknown,
    shape?: unknown,
  ): void {
    const kept = outcome === "failed" && shape !== undefined ? safeShape(shape) : undefined;
    const record = {
      event: "collector-diagnostic",
      source: safeSource,
      runId: safeRunId,
      stage: stage === "terminal" || STAGES.has(stage) ? stage : "unknown",
      outcome,
      durationMs: Math.max(0, durationMs),
      ...(outcome === "failed" ? safeErrorDetails(error) : {}),
      ...(kept ? { shape: kept } : {}),
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
    /**
     * `context.shape` is kept only as `safeShape` allows: closed strings,
     * booleans and counts, never text.
     */
    failure(stage: string, error: unknown, context?: { shape?: unknown }): void {
      emit(stage, "failed", Date.now() - startedAt, error, context?.shape);
    },
    finish(status: "success" | "partial" | "failed"): void {
      emit("terminal", status, Date.now() - startedAt);
    },
  };
}
