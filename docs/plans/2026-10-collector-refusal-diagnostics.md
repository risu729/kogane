# Collector refusal and persistence diagnostics

Status: implemented locally; independent review, PR CI and deployment pending.

Date: 2026-10-10

## Evidence and scope

Read-only operational evidence identified SBI VC failed session checks with a
`manual_agreement_required` reauthentication result; St.George coordinator
refusals without a structured reason in Worker logs; and a V Point expired-session
attempt followed by a separate successful post-authentication run. These are
different conditions, not proof that a deployment failed or every terminal write
failed. The St.George persisted refusal reason is not yet verified in production.

## Implemented

- SBI VC attaches the persisted blocked-run id to the alarm result, distinguishes
  terminal persistence failure from session refusal, and reports the explicit
  manual-agreement reason. Automatic login attempts stop while that reason is
  recorded; the existing explicit authenticated reauthentication route remains
  available after the owner completes the provider's agreement. No agreement is
  accepted by this change. Writer exceptions are classified inside the session
  Durable Object before its scheduled result crosses RPC; unrelated exceptions
  cannot impersonate that result by using the same error text.
- St.George preserves a newly stored failed run's id across durable blocked-state
  restarts; legacy blocks without an id remain valid. Alarms distinguish closed
  refusal, busy, state-unavailable and terminal-persistence codes. Structured
  stage/result logs contain closed codes and operational counts only. Logging
  cannot replace a stored result. No block is automatically resumed, and pending
  persistence keeps its existing retry-without-another-bank-request behavior.
- V Point reports `reauthentication_pending` for its existing narrow pending-auth
  predicate. The first run remains failed; a later email-triggered run remains a
  separate run. A failed terminal write takes precedence. Email/OTP handling,
  evidence and historical statuses are unchanged.
  Only exceptions from the terminal writer receive the persistence code;
  session, lease and planning exceptions retain their existing classification.

## Verification and remaining proof

Synthetic tests cover blocked run linkage, no repeated automatic login after a
manual-agreement refusal, persistence failure precedence, closed-code logging,
logging failure isolation, legacy durable-state compatibility and Worker alarm
integration. Existing collector CI remains required. No provider semantics,
credentials, adopted financial state or collection coverage are changed.
R2 HEAD exception fixtures exercise both SBI alarm branches through real DO RPC
and V Point's pending-challenge run without contacting a provider.

Deployment is not recovery evidence: SBI VC still requires owner action;
St.George needs its next diagnostic result and an explicit resume decision;
V Point's separate follow-up run must be checked independently. Normal schedules
provide future evidence; this change does not authorize extra live bank requests.
