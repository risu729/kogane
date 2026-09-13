export const FAILURE_CODES = [
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
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export function safeFailureCode(value: unknown): FailureCode {
  return FAILURE_CODES.includes(value as FailureCode) ? (value as FailureCode) : "container-failed";
}
