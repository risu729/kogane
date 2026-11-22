/**
 * The closed codes this collector stores and logs for a thrown error: the
 * manifest's failures and units (so the terminal's `safeErrorCode`), the
 * health record's `lastErrorCode` and `lastReauthErrorCode`, and the
 * `sbi_vc_keepalive` and `sbi_vc_reauth` log lines. A message is kept only
 * when it is one of the collector's own codes below: a message that merely
 * looks like a code is still free text, which a provider response or a
 * library may have chosen. `test/error-code.test.ts` checks that every
 * literal message this collector throws is in the set and that every message
 * template is one the set or `HTTP_STATUS_CODE` covers.
 */
const FIXED_CODES = [
  // worker.ts
  "missing_passkey_credential",
  "missing_session_seed",
  "missing_encryption_key",
  "session_seed_json_invalid",
  "missing_response_body",
  "response_too_large",
  "terminal_persistence_failed",
  "scheduled_keepalive_failed",
  "scheduled_collection_session_failed",
  "scheduled_collection_failed",
  "unknown_cron_trigger",
  // classifyCryptoError, rethrown as a message by worker.ts
  "session_encrypt_failed",
  "crypto_data_error",
  "crypto_invalid_access",
  "crypto_not_supported",
  "crypto_operation_error",
  "crypto_error",
  // crypto.ts
  "unsupported_session_version",
  "invalid_encryption_key",
  // session.ts
  "invalid_session_seed",
  "invalid_gateway_envelope",
  // passkey.ts
  "invalid_passkey_credential",
  "nonzero_passkey_counter_not_supported",
  "invalid_passkey_challenge",
  "unexpected_passkey_signature_format",
  "passkey_initiation_rejected",
  "passkey_login_rejected",
  "manual_agreement_required",
  "passkey_login_missing_account_id",
  "passkey_non_json_response",
  "invalid_passkey_gateway_envelope",
  "invalid_passkey_credential_id",
  "invalid_base64url",
  // collector.ts
  "executions_recent_invalid_pagination",
  "executions_recent_page_limit_exceeded",
  "executions_recent_pagination_length_mismatch",
  "collector_non_json_response",
  "collector_gateway_rejected",
  "collector_invalid_gateway_envelope",
  "collector_missing_response_body",
  "collector_response_too_large",
  // storage.ts
  "invalid_artifact_dataset",
  "invalid_document_artifact",
  "invalid_json_artifact",
  "artifact_key_already_exists",
  // documents.ts
  "report_year_range_invalid",
  "report_list_invalid",
  "report_list_pagination_invalid",
  "annual_report_download_unobserved",
  "report_list_total_changed",
  "report_list_duplicate_identity",
  "report_list_page_limit",
  "pnl_list_shape_unobserved",
  "pnl_list_pagination_unconfirmed",
  "pnl_api_csv_mismatch",
  "report_row_unobserved",
  "report_status_unobserved",
  "report_buffer_invalid",
  "report_signature_invalid",
  "pnl_api_incomplete",
  "pnl_api_shape_unobserved",
  "pnl_api_date_unobserved",
  "pnl_api_row_unobserved",
  "pnl_api_duplicate_identity",
  // pnl-zip.ts
  "pnl_zip_invalid",
  "pnl_csv_schema_unobserved",
  "pnl_csv_period_mismatch",
  "pnl_csv_execution_identity_invalid",
  "pnl_csv_invalid",
  // leverage-executions.ts
  "leverage_execution_invalid_pagination",
  "leverage_execution_rows_unobserved",
  "leverage_execution_transport_unverified",
  // shared-collection.ts
  "shared_leverage_unit_missing",
  "shared_artifact_json_invalid",
  "shared_secure_key_present",
  "shared_capture_missing",
  "shared_binary_document_missing",
] as const;

/**
 * collector.ts `collectPages`: each paginated view's refusals, thrown as
 * `<prefix>_<reason>` with the hyphenated prefix and stored with underscores.
 */
const PAGINATION_PREFIXES = [
  "executions_historical",
  "cashflows_historical",
  "cashflows_all_recent",
  "cashflows_all_historical",
] as const;
const PAGINATION_REASONS = [
  "invalid_pagination",
  "pagination_total_changed",
  "pagination_length_mismatch",
  "invalid_identity",
  "duplicate_identity",
  "page_limit_exceeded",
] as const;

export const SBI_VC_ERROR_CODES: ReadonlySet<string> = new Set([
  ...FIXED_CODES,
  ...PAGINATION_PREFIXES.flatMap((prefix) =>
    PAGINATION_REASONS.map((reason) => `${prefix}_${reason}`),
  ),
]);

/** A refused gateway or passkey-login response: its bounded HTTP status only. */
const HTTP_STATUS_CODE = /^(?:collector|passkey)_http_[1-5]\d{2}$/u;

/**
 * The closed code of a thrown error. One of the collector's own codes is kept
 * (hyphens folded to underscores, as the pagination prefixes are hyphenated);
 * otherwise only the error's class decides: `json_parse_failed`, a
 * `crypto_*` code, `type_error`, or `unexpected_error`. No other text leaves,
 * and nothing is thrown: a `message` or `name` getter or a prototype read (a
 * Proxy's `getPrototypeOf` trap) that throws only takes that step away.
 */
export function classifyError(error: unknown): string {
  try {
    const message: unknown = error instanceof Error ? error.message : undefined;
    if (typeof message === "string") {
      const code = message.replaceAll("-", "_");
      if (SBI_VC_ERROR_CODES.has(code) || HTTP_STATUS_CODE.test(code)) return code;
    }
  } catch {
    // A throwing accessor cannot carry text past the closed set.
  }
  try {
    if (error instanceof SyntaxError) return "json_parse_failed";
    if (error instanceof DOMException) return classifyCryptoError(error);
    if (error instanceof TypeError) return "type_error";
  } catch {
    // A prototype read that throws leaves no class to go by.
  }
  return "unexpected_error";
}

/**
 * The closed code of a Web Crypto failure: `session_encrypt_failed` for a
 * value that is not a `DOMException`, else its `name` mapped to a `crypto_*`
 * code. Never throws: a prototype read that throws counts as not a
 * `DOMException`, and a `name` getter that throws (as the built-in one does
 * on a Proxy) gives `crypto_error`.
 */
export function classifyCryptoError(error: unknown): string {
  let isDomException = false;
  try {
    isDomException = error instanceof DOMException;
  } catch {
    // A prototype read that throws leaves no class to go by.
  }
  if (!isDomException) return "session_encrypt_failed";
  let name: unknown;
  try {
    name = (error as DOMException).name;
  } catch {
    // A throwing `name` getter is an unknown name.
  }
  switch (name) {
    case "DataError":
      return "crypto_data_error";
    case "InvalidAccessError":
      return "crypto_invalid_access";
    case "NotSupportedError":
      return "crypto_not_supported";
    case "OperationError":
      return "crypto_operation_error";
    default:
      return "crypto_error";
  }
}
