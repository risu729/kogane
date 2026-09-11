// The machine-useful error codes of addendum 10 section 9, plus the few
// lifecycle codes the change commands need. An error names what the caller may
// do next; it never carries provider content, an amount, a token or an
// exception string.
export const COMMAND_ERROR_CODES = [
  // Addendum 10 section 9.
  "needs_scope_resolution",
  "incomplete_evidence",
  "unsupported_semantics",
  "needs_rule_verification",
  "stale_context",
  "approval_required",
  "idempotency_conflict",
  "budget_exceeded",
  "evidence_restricted",
  // Lifecycle codes: a plan, approval or receipt the caller named is not
  // usable. Kept separate from the nine above so the table stays readable.
  "invalid_command",
  "commands_disabled",
  // Authorization codes. `subject_not_granted` is the caller's answer: the
  // deployment is configured and its allow-lists do not name this subject.
  // `grants_misconfigured` is the deployment's own fault — the grant
  // configuration cannot be read, so nobody is graded at all (grants.ts).
  "subject_not_granted",
  "grants_misconfigured",
  "plan_not_found",
  "plan_expired",
  "plan_not_open",
  "approval_not_found",
  "approval_expired",
  "approval_exhausted",
  "approval_scope_mismatch",
  "receipt_not_found",
  "target_missing",
  "target_ambiguous",
  "commit_failed",
] as const;
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

export interface CommandError {
  ok: false;
  error: CommandErrorCode;
  /** Safe identifiers only (plan id, subject ref); never values or free text. */
  refs?: readonly string[];
}

export type CommandResult<T> = ({ ok: true } & T) | CommandError;

export function commandError(error: CommandErrorCode, refs: readonly string[] = []): CommandError {
  return refs.length > 0 ? { ok: false, error, refs } : { ok: false, error };
}

/** HTTP status for one code, so every adapter answers the same way. */
export function statusForCommandError(code: CommandErrorCode): number {
  switch (code) {
    case "approval_required":
    case "evidence_restricted":
      return 403;
    case "commands_disabled":
    case "subject_not_granted":
      return 403;
    // Not the caller's fault and not a refusal of this caller: this
    // deployment's grant configuration cannot be read, so it grades nobody.
    // Same status as a missing writer binding, for the same reason.
    case "grants_misconfigured":
      return 503;
    case "plan_not_found":
    case "approval_not_found":
    case "receipt_not_found":
      return 404;
    case "stale_context":
    case "idempotency_conflict":
    case "plan_expired":
    case "plan_not_open":
    case "approval_expired":
    case "approval_exhausted":
    case "approval_scope_mismatch":
      return 409;
    case "budget_exceeded":
      return 429;
    case "commit_failed":
      return 500;
    default:
      return 400;
  }
}
