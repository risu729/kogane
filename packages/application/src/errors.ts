// Machine-useful errors (addendum 10 section 9). Every message here is a
// fixed server-authored string: no provider content, no token, no exception
// text, no SQL, no URL. Callers act on `code`; `refs` carries only safe
// identifiers the caller is already allowed to see.
import type { FinancialError, FinancialErrorCode } from "../../domain/src/result.ts";

/** What each code lets the caller do; also the text `kogane.capabilities` publishes. */
export const ERROR_REMEDIES: Record<FinancialErrorCode, string> = {
  needs_scope_resolution: "choose a target from the granted candidates",
  incomplete_evidence: "explain the gap; request the missing scope under a separate grant",
  unsupported_semantics: "return to the provider record; do not invent a computed answer",
  needs_rule_verification: "ask for the rule to be verified; an estimate is not a fact",
  stale_context: "open a new context and re-run; do not reuse the old approval",
  approval_required: "hand the plan to an authenticated human approval path",
  idempotency_conflict: "do not resend a different payload under the same key",
  budget_exceeded: "narrow the scope or the page, or switch to a bounded job",
  evidence_restricted: "stay inside the current grant; do not look for another route",
  context_expired: "open a new context and read from the beginning",
  unauthorized: "stop; the principal has no grant for this capability",
  invalid_query: "correct the request against the published schema",
};

export function financialError(
  code: FinancialErrorCode,
  requestId: string,
  refs: readonly string[] = [],
): FinancialError {
  return {
    schemaVersion: "financial-error-v1",
    code,
    requestId,
    message: ERROR_REMEDIES[code],
    refs: [...new Set(refs)].slice(0, 100),
  };
}

/** HTTP status for each code. Auth failures keep the transport's own closed responses. */
export const ERROR_STATUS: Record<FinancialErrorCode, number> = {
  needs_scope_resolution: 422,
  incomplete_evidence: 422,
  unsupported_semantics: 400,
  needs_rule_verification: 422,
  stale_context: 409,
  approval_required: 403,
  idempotency_conflict: 409,
  budget_exceeded: 413,
  evidence_restricted: 403,
  context_expired: 409,
  unauthorized: 403,
  invalid_query: 400,
};
