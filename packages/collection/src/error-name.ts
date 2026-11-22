/**
 * A thrown value's name as a closed code, for logs (AGENTS.md: logs carry
 * counts and closed codes only). An error's `name` is whatever string its
 * thrower chose, a provider's or a library's included, so it is logged only
 * when it is one of the runtime's own error names or the lease's abort;
 * every other name is `other`, and a thrown value that is not an `Error` is
 * `non_error`. The message is never read.
 */
export const LOGGED_ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "CollectionLeaseAbort",
  "non_error",
  "other",
] as const;
export type LoggedErrorName = (typeof LOGGED_ERROR_NAMES)[number];

export function loggedErrorName(error: unknown): LoggedErrorName {
  try {
    if (!(error instanceof Error)) return "non_error";
    const name: unknown = error.name;
    // `non_error` is never an error's own name.
    return typeof name === "string" &&
      name !== "non_error" &&
      (LOGGED_ERROR_NAMES as readonly string[]).includes(name)
      ? (name as LoggedErrorName)
      : "other";
  } catch {
    // A `name` getter that throws names nothing.
    return "other";
  }
}
