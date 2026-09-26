# ADR 0010: Bound terminal registration by a per-invocation operation budget

- Status: accepted
- Date: 2026-09-25
- Implemented by: #250 (closes the question of issue #87)
- Amended by: [ADR 0024](0024-collection-scan-judged-terminals.md) (a terminal
  already judged no longer spends one of the scan's five attempts; the
  operation budget is unchanged)
- Carried by:
  [processor §3.3](../processor.md#33-operation-budget-and-staged-registration-issue-87),
  `packages/application/src/collection/budget.ts`,
  `services/processor/test/registration-budget.test.ts`

## Context

Issue #87 asked that the retired Vpass importer's initial catalogue stay under
Cloudflare's per-invocation limits. Its successor, the Processor's in-process
terminal registration, makes no Service Binding call but was bounded only by
artifact count: every call re-added every unit and range, re-verified every
object and re-staged every inventory item. One 34-artifact Vpass card measured
669 D1 statements and 69 R2 calls in one call, against D1's documented 1,000
queries per invocation, and a queue batch holds up to ten terminals. An
inventory chunk of 50 was also above the contract's 30, so a run above 50
artifacts never sealed.

## Options considered

1. Lower the artifact count per call. Rejected: the cost per artifact varies
   with transforms and relations, so a count does not bound operations.
2. Reintroduce signed continuations between invocations. Rejected: their
   importer, queue and ingest clients are retired, and the state already in
   CORE is enough to resume.
3. Meter every D1 statement and R2 call and share one budget across all
   registrations of an invocation, in idempotent steps. Chosen.

## Decision

- **500 operations per invocation**, shared by every registration in it (the
  queue consumer's whole batch, or the cron's `collection_scan` and
  `operation_dispatch` together); an operation is one D1 statement, each
  statement of a batch counted, or one R2 call. 500 is half the documented D1
  limit.
- **Steps with reserves**: a step starts only while its measured reserve and
  the audit reserve still fit; the test fails when a step outgrows its
  reserve.
- **Continuation**: a registration that reaches the budget yields `pending`
  with its progress in CORE, and `collection_scan` continues up to five
  pending runs, oldest first, before listing anything. One that could not
  start is `deferred` and retried.
- **No signed continuations**: none exists any more to be versioned.
- The contract stays `terminal-registration-v1`: descriptors, inventory digest
  and seal attempt id are byte-identical, so runs left unfinished continue
  under the same identity instead of registering a second revision.

## Consequences

- A Vpass card of about twenty statement pages registers in one invocation; a
  34-artifact card takes two (467 and 292 operations).
- A descriptor the ingest contract refuses is blocked with its code instead of
  failing on every tick.
- Each invocation logs one aggregate-only `invocation_budget` line, and
  `/internal/health` shows the registration backlog.

## Verification

`registration-budget.test.ts` on synthetic terminals: boundary tests at,
below and above the budget edge, and an invocation killed after the run report
and after the seal.
