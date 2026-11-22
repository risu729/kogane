# ADR 0119: A snapshot read's cursor continues at another offered page size

- Status: accepted (merged 2026-11-20 in [#1446](https://github.com/risu729/kogane/pull/1446))
- Date: 2026-11-19
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414) (point 2, "Paging is fragile")
- Carried by: `packages/storage-d1/src/read/cursor.ts` (`checkReadCursor`,
  `pageSizeDigests`), `services/app/src/balances-v2.ts`,
  `services/app/src/rewards-read.ts`
- Related: [ADR 0091](0091-query-cursor-paging-basis.md) (the query cursor
  already leaves out the page size), [ADR 0081](0081-ui-parity-through-mcp.md)
  (the routes and the MCP tools share one reader),
  [balance read model: cursor contract](../balance-read-model.md#cursor-contract),
  [READ database](../read-model-d1.md)

## Context

`GET /api/v2/balances/latest`, `/api/v2/balances/history`,
`/api/v2/rewards/expiry` and `/api/v2/rewards/simulations` page one fixed
snapshot with a keyset cursor `{snapshotId, readInstanceId, filterDigest,
position}`. `filterDigest` is the digest of the route, the resolved scope, the
page size and (for balances) the identity read mode, and a continuation whose
digest differs is `400 cursor_mismatch`. The MCP tools `kogane.balances.read`
and `kogane.rewards.read` call the same readers, so they answer the same.

Issue 1414 records a client that re-sent `nextCursor` from
`kogane.balances.read` with a different `limit` and got
`{"error":"cursor_mismatch"}`, with no hint of what had to match. A client
whose answers are cut by its own size limit naturally asks the next page
smaller, or larger once it knows the shape.

Nothing a page reads depends on its size. The latest list reads rows after the
cursor's `row_seq` in the snapshot's fixed order; history reads rows after the
cursor's sort key and id, bounded by the snapshot's published high-water parse
run; reward pages read rows after the cursor's `row_seq`. Membership is fixed
by the snapshot the cursor names, whatever the size. So binding the page size
refused continuations that are exactly as correct as the ones it allowed. The
agent query cursor already leaves the page size out of its digest
([ADR 0091](0091-query-cursor-paging-basis.md), `querySpecDigest`), so the two
cursor families also disagreed.

## Options considered

1. **Keep the binding and say what changed.** The refusal could name the page
   size when the cursor matches the query at another size. The client still
   has to restart from the first page or keep its first size, for a
   continuation that would have been correct.
2. **Drop the page size from new digests.** The cursor's digest would cover
   only the route, scope and mode. Every cursor issued before the deploy
   carries the digest with its size, so it would be refused once unless the
   old digests were also accepted, which is option 3's check anyway.
3. **Accept the same query's digest at any offered size (chosen).** The cursor
   and the digest stay as they are. A continuation also compares the cursor's
   digest with the same route, scope and mode at each size the route offers
   (`PROJECTION_PAGE_LIMITS` 50, 100, 200, 500 for balances,
   `REWARD_READ_PAGE_LIMITS` 25, 50, 100, 200 for rewards). On a match the page
   is read at the size asked now, from the cursor's position, and the next
   cursor carries the digest at that size.

## Decision

Option 3. `checkReadCursor` takes an optional `pageSizeDigests`; when it lists
the cursor's digest, the digest check passes, and the read-instance and
snapshot checks apply unchanged. The balance and reward routes compute the
list only when a cursor is present (four SHA-256 digests). A size outside the
offered list is still `400 invalid_limit`, and another route, scope,
`program` filter or identity read mode is still `400 cursor_mismatch`.

## Consequences

- A client may change `limit` between pages of one walk; the pages join with
  no row repeated or skipped, on the snapshot the first page named.
- Cursors issued before this change keep working: their format and digest are
  unchanged.
- The web pages never change the size mid-walk, so they see no difference. The
  MCP tools change in what they accept: a call that was refused
  (`cursor_mismatch`) now answers its page. No tool description, schema or
  field changes.
- A cursor still says nothing about what differs when it is refused: the
  digest cannot be inverted, and naming which part of the query moved is left
  open (issue 1414 asks for it).
- The CORE path's cursor rules in `packages/domain/src/paging.ts`
  (`checkKeysetCursor`) are unchanged; only the READ cursor check gains the
  list.

## Verification

- `packages/storage-d1/test/read-cursor.test.ts`: a cursor whose digest is in
  `pageSizeDigests` continues; without the list, or with a list that does not
  name it, it is `cursor_mismatch`; another read instance or an unreadable
  snapshot is still `context_expired`.
- `services/app/test/balances-v2.test.ts`: a latest cursor read at 50
  continues at 100 and its cursor at 200, and the three pages equal the first
  350 rows of one page of 500 on the same snapshot; a history cursor read at
  50 continues at 100 and equals the first 150 rows of a page of 200; a
  changed filter or identity read mode at another size, and a latest cursor
  on the history route, are `cursor_mismatch`.
- `services/app/test/rewards-v2-read.test.ts`: an expiry cursor read at 25
  continues at 50 and the two pages equal one page of 200; a `program`
  filter at another size is `cursor_mismatch`. A simulations cursor in the
  route's own form read at 25 continues at 100, and an expiry cursor on the
  simulations route is `cursor_mismatch` (a fresh snapshot has no simulation
  rows, so this checks the digest list, not the join; simulations read the
  same `row_seq` keyset as expiry).
- Each of these fails on main before the change (`400 cursor_mismatch`).
