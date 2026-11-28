import { safeErrorType } from "../diagnostics";

/**
 * The local CLI's failure line: closed codes only. `errorType` is the
 * collector's constructor-membership code (`safeErrorType`), never the thrown
 * `name`, and the thrown message is not printed: either can carry what the
 * bank's page said.
 */
export function localFailureLine(error: unknown): { event: string; errorType: string } {
  return { event: "sbi-shinsei-local-failed", errorType: safeErrorType(error) };
}
