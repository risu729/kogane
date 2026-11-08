// The closed failure codes the container reports on its `error` record. The
// Worker admits only these (`GLOBALPASS_CONTAINER_FAILURE_CODES` in
// `src/model.ts` holds the same list) and writes the code into the run's
// manifest, so the run's `safeErrorCode` says which step failed instead of the
// generic `browser_collection_failed`.

/** The code of a failure the container recognised, by the stage it failed in. */
const STAGE_CODES = new Map([
  ["relay-start", "globalpass_relay_start_failed"],
  ["browser-launch", "globalpass_browser_launch_failed"],
  ["login-page", "globalpass_login_page_failed"],
  ["challenge", "globalpass_challenge_failed"],
  ["login-submit", "globalpass_login_submit_failed"],
  ["activity-open", "globalpass_activity_open_failed"],
  ["month-discovery", "globalpass_month_discovery_failed"],
  ["statement-read", "globalpass_statement_read_failed"],
  ["logout", "globalpass_browser_close_failed"],
  ["browser-close", "globalpass_browser_close_failed"],
  ["relay-close", "globalpass_browser_close_failed"],
]);

export const CONTAINER_FAILURE_CODES = new Set([
  ...STAGE_CODES.values(),
  // No attempt got a Turnstile token within its wait.
  "globalpass_challenge_timeout",
  // The edge answered the login page with Access Denied.
  "globalpass_challenge_denied",
  // The edge answered the credential POST with Access Denied.
  "globalpass_login_denied",
  // The credential POST returned to the credential form.
  "globalpass_login_rejected",
  // A failure in no known stage.
  "browser_collection_failed",
]);

/** An error that already knows its closed code. Its message never leaves the container. */
export class CollectorFailure extends Error {
  constructor(code, message, { name = "Error", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = name;
    this.code = CONTAINER_FAILURE_CODES.has(code) ? code : "browser_collection_failed";
  }
}

/** The closed code of a failure: its own, else the one of the stage it failed in. */
export function failureCode(error, failedStage) {
  if (error instanceof CollectorFailure) return error.code;
  return STAGE_CODES.get(failedStage) ?? "browser_collection_failed";
}
