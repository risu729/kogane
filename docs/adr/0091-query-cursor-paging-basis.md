# ADR 0091: A query cursor is bound to its context's pinned inputs, not to the request's clock

- Status: proposed
- Date: 2026-11-08
- Carried by: `packages/application/src/context/open.ts` (`pagingBasisRef`),
  `packages/application/src/query/cursor.ts`,
  `packages/application/src/query/spec.ts` (`querySpecDigest`),
  `packages/application/src/query/execute.ts`
- Related: [agent API: contexts, cursors and hand-off](../agent-api.md#contexts-cursors-and-hand-off)

## Context

`kogane.financial.query` (and `GET /api/v2/query`, the same service) pages
`activity` and `reported-state` with an opaque cursor that carried
`{contextId, queryDigest, offset}`. A request is refused `stale_context` when
the cursor's `contextId` or `queryDigest` differs from the ones the request
computes.

Every request opens its context at its own clock: both adapters pass the
request's second as `now`, and the context manifest pins it three times
(`effectiveTime`, the defaulted `knowledgeCutoff` and `evaluationClock`).
`contextId` is the digest of that manifest and `queryDigest` the digest of a
spec that also carries `effectiveTime`. So both changed every second, and a
`nextCursor` was refused on any request made in a later second than the page
that issued it: the next page could not be read at all. A test over the real
Worker confirmed it on origin/main (a8355fc6): the page after
`{"intent":"activity","limit":1}`, asked two seconds later, answered
`409 stale_context`. The tests that paged successfully opened both contexts
at one fixed clock.

The documentation already described the intended binding: the query digest
"covers the intent, perimeter, bases and filters", and a context id changes
when "its inputs have moved on", every one of which is immutable in the store.
The clock is not such an input, and no intent reads by it: the rows a page
reads depend on the publication, the perimeter, the parser builds, the
releases and the filters.

## Options considered

1. **Keep the binding, documented.** A cursor is good only within the second
   it was issued in, so `nextCursor` is useless to any client.
2. **Carry the clock in the cursor and reopen the context at it.** The second
   page would carry the first page's `contextId`, but the adapters open the
   context before the service reads the cursor, the clock would become a
   caller-supplied input of the context, and a later page would report an
   evaluation instant that is not when it was evaluated.
3. **Drop the clock from `contextId`.** Changes the hand-off identifiers
   (`contextId`, `resultRef`) every client and page already shows, for a
   problem only the cursor has.
4. **Bind the cursor to the context's pinned inputs without the clock.** The
   context and its id stay as they are; the cursor carries a separate paging
   basis, the digest of the manifest without `effectiveTime`,
   `evaluationClock` and a defaulted `knowledgeCutoff` (a stated one stays
   pinned), and the query digest leaves out `effectiveTime` as it already
   leaves out the page size.

## Decision

Option 4. `openContext` returns `pagingBasisRef` (`basis_<64 hex>`) beside
the context. A cursor is base64url of `{basisRef, queryDigest, offset}`;
`querySpecDigest` digests the resolved spec without `limit` and
`effectiveTime`. A request resumes from the cursor's offset when its own
paging basis and query digest equal the cursor's, and is refused
`stale_context` otherwise: a moved publication high-water, another
perimeter, parser builds, identity, metric or decimal release, another
intent or filter, or a stated knowledge cutoff that differs.

## Consequences

- The next page is read on any later request while the store's pinned inputs
  hold, and refused once one of them moves, as before.
- Each page still reports the `contextId` of its own request, so two pages of
  one cursor carry different `contextId`s and `resultRef`s; their rows come
  from the same pinned inputs.
- A cursor issued before this change has the old shape and is refused
  `stale_context`; it could not have been used a second after it was issued.
- `executeQuery` names a source `no_rows_in_scope` only when every scope pair
  that could hold its rows was read to its end. A whole-store read stops once
  it has the page and its lookahead row, so a source whose rows all lie past
  them was named as having none (a page of a source sorted after the rows
  read, or older than them); such a page is `partial` with `nextCursor`, and
  now names no gap it cannot know.

## Verification

- `packages/application/test/query.test.ts`: the page after a cursor, opened
  one second later with the same pinned inputs, returns the next row and no
  further cursor; the same cursor after the publication high-water moved is
  `stale_context`; a cursor from another context's basis is still refused;
  with 600 newer rows of one source, a page of the whole-store read does not
  name the other source's older row as `no_rows_in_scope`.
- `services/app/test/agent-api.test.ts`: over the real Worker, the page after
  `{"intent":"activity","limit":1}`, asked two seconds later, is `200` with
  the next row and its own `contextId`.
