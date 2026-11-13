// Classification is transient: callers retain only a boolean, never exception text.
const PLATFORM_LIMIT =
  /too many api requests by single worker invocation|too many subrequests|subrequest depth limit|worker invocation limit/iu;

/** Recognize a platform invocation limit without allowing error introspection to throw. */
export function platformLimitError(error: unknown): boolean {
  try {
    if (!(error instanceof Error)) return false;
    const message: unknown = error.message;
    return typeof message === "string" && PLATFORM_LIMIT.test(message);
  } catch {
    return false;
  }
}
