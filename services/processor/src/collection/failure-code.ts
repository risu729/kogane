/** Error-class grammar shared by collection and operation-dispatch diagnostics. */
const FAILURE_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * A bounded class code, never an exception message or arbitrary Error.name.
 * Reading a custom name/constructor may itself throw; diagnostics stay safe.
 */
export function safeFailureCode(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "unknown";
    const name = error.name;
    const code: unknown = name === "" ? error.constructor.name : name;
    return typeof code === "string" && FAILURE_CLASS.test(code) ? code : "unknown";
  } catch {
    return "unknown";
  }
}
