# ADR 0080: A change planned again after its plan expired is a renewal with its own id

- Status: proposed
- Date: 2026-11-06
- Carried by:
  `packages/application/src/command/plan.ts` (`planIdAt`, `planDigestOf`'s
  `renewal`, `storedRenewal`),
  `packages/application/src/command/simulate.ts`,
  [change lifecycle](../change-lifecycle.md#plan-digest)
- Related: [ADR 0063](0063-delegated-ai-operation-path.md) (the delegated
  decision tools refuse an expired plan and a stale simulation),
  [ADR 0064](0064-common-audit-log.md) (one `applied` record per plan)

## Context

A plan's id is the digest of what it would do
(`canonicalDigest({ kind, payload, expectedRevisions, baseContextId })`), and
`createPlan` inserts the row only when no row has that id. A plan lives 15
minutes (`PLAN_TTL_SECONDS_DEFAULT`), and the 0031 triggers let only `status`
move, so an expired row can never be reopened, and nothing may be deleted.

So a person who opened a review, left it for more than 15 minutes and planned
the same change again over unchanged data got the expired plan back
(`created: false`, the old `expires_at`). `approve` refused it with
`plan_expired`, the confirmation screen told them to re-simulate, and a
re-simulation reported the plan fresh with the same id. The change could not
be approved again until some unrelated decision moved one of its pins. The
same holds for the delegated decision tools, which refuse an expired plan
before they prepare anything.

## Options considered

1. **Update the expired row's `expires_at`.** Rejected: plans are append-only
   (0031); reopening one would also revive approvals bound to it.
2. **Put the creation instant in every plan's digest.** Rejected: planning
   the same change twice within its lifetime would make two plans, and a
   resend could no longer find the first one.
3. **Chain renewals: the next id is the digest of the content plus the
   expired plan's id.** Rejected: finding the open plan walks the whole chain,
   one D1 read per earlier expiry.
4. **Renew by lifetime-long window (chosen).** The first plan of a change
   keeps the plain digest. A renewal adds `renewal: { ttlSeconds, window }`,
   where `window` is the index of the lifetime-long window, counted from the
   epoch, that the renewal's creation instant falls in.

## Decision

`createPlan` takes the plain digest unless the plan under it is still open
(`planned` or `approved`) and has expired. Then a renewal created in the
previous window that has not expired is the answer, and otherwise the renewal
of the current window. A plan created in window w lives at least until window
w + 1 begins, so no open plan of the change is older than the previous window:
three key lookups decide it, whatever the number of earlier expiries. Planning
the same change again while its plan is open and unexpired returns that plan,
as before.

A plan that was committed, marked stale or rejected is never renewed; it is
answered as it was. The expired plan stays as it was, `planned` or
`approved`, and its approvals stay bound to it and cannot be used.

`simulate` re-derives a stored plan's id from its content: the plain digest,
or, when the id is not that, the renewal its own `created_at` and
`expires_at` name. A plan is stale when the re-derived id differs (a pin was
added or moved, or the id is no derivation of the row) or a pinned revision
moved. `resimulatedPlanId` is the plan's own id while it is fresh, and
otherwise the plain digest of the change over the current data.

Approvals, commits and receipts are unchanged: they bind the stored plan id.

## Consequences

- A first plan's id is the digest the lifecycle documents; only a renewal
  carries the extra field.
- Windows follow the lifetime a call asks for. Every route asks for the
  default; a caller that changed the lifetime between re-plans could be
  answered an expired plan again, as before this ADR.
- An expired plan is still `planned` or `approved` in `change_plans`; a
  reader that lists open plans by status alone sees it, as before.
- No migration, no new error code, no new route.

## Verification

`packages/application/test/plan-renewal.test.ts` (synthetic instrument
mappings): a change planned again after its plan expired gets a new, open
plan that approves and commits while the expired row stays unchanged and
unapprovable; re-planning within a plan's lifetime, across a window
boundary, returns that plan, and a third plan follows a second expiry; a
renewal simulates fresh until another decision moves its pin, then stale with
the plain digest of the moved data; a first plan keeps the documented digest;
a row whose id is no derivation of its content simulates stale.
