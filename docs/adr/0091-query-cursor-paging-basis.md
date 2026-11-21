# ADR 0091: A query cursor is bound to its context's pinned inputs, not to the request's clock

- Status: accepted (merged 2026-11-08 in [#1172](https://github.com/risu729/kogane/pull/1172));
  the [2026-11-21 amendment](#amendment-2026-11-21-an-empty-holdings-or-coverage-scope-is-a-gap-not-a-complete-answer)
  is proposed
- Date: 2026-11-08; amended 2026-11-21
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
- The clock filters no row: `executeQuery` reads neither `effectiveTime`,
  `evaluationClock` nor `knowledgeCutoff` (a stated cutoff is reported in the
  context, not applied to the reads), so two pages under different clocks
  read the same rows while the basis holds.
- Limit: the basis is only as strict as the publication marker it pins.
  `publicationHighWater` is the highest visible parse run id of the grant's
  sources (`contextInputs` in `services/app/src/agent-service.ts`), so a
  publication change that does not move it keeps the same basis: a release
  activation onto candidate runs older than the newest visible run, or a
  rollback to an earlier run ([release adoption](../release-adoption.md)).
  A page read after such a change can repeat or skip rows of the page before
  it. The old binding did not detect this either; it only made every later
  page `stale_context`. `contextId` pins the same marker. A marker that moves
  with every publication event is not built.
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
  name the other source's older row as `no_rows_in_scope`; a source read to
  its end without a row is still named, on the whole-store read and on a
  listed grant whose other source stopped at the page; a stated knowledge
  cutoff keeps the basis across clocks and a different one changes it; a
  cursor of the old `{contextId, queryDigest, offset}` shape is refused.
- `services/app/test/agent-api.test.ts`: over the real Worker, the page after
  `{"intent":"activity","limit":1}`, asked two seconds later, is `200` with
  the next row and its own `contextId`.

## Amendment 2026-11-21: an empty `holdings` or `coverage` scope is a gap, not a complete answer

- Status: proposed
- Date: 2026-11-21
- Carried by: `packages/application/src/query/execute.ts` (`executeQuery`:
  `unheldGranted`, the `holdings` and `coverage` branches),
  [agent API](../agent-api.md) (the coverage and holdings paragraphs)

**Context.** The decision above names `no_rows_in_scope` for an `activity` or
`reported-state` source read to its end with no row. `holdings` and
`coverage` had no such rule, and answered `complete` when nothing was known:
`holdings` returned `units: []` for an `account` filter the snapshot never
measured, an empty snapshot, or a listed grant whose sources the store holds
none of; `coverage` returned no scope and every count 0 for a `source` filter
the store does not hold, and left a listed grant's unheld sources out without
a gap. Each reads as a known nothing (INV05).

**Options considered.**

1. Keep the empty `complete` answer. Rejected: INV05.
2. Refuse the query (`not_found` or `evidence_restricted`). Rejected: a
   refusal for an unheld but granted value would differ from the answer for a
   held one with nothing in it, and an `evidence_restricted` for a granted
   value would be untrue.
3. Answer `partial` with a closed gap. Chosen.

**Decision.** In `holdings`, a scope pair the snapshot holds neither a
summable row nor a coverage row of, and a source a listed grant names that the
store does not hold, is the gap `no_measures_in_scope` (scope `null`, like the
other holdings gaps), and the answer is `partial`. An account whose
measurements are adopted but none of them a summable currency stock is
measured and stays `complete`. In `coverage`, a `source` filter the store does
not hold, and without a filter each source a listed grant names that the
store does not hold, is the existing gap `no_artifacts_collected` on
`source:<id>`, and the answer is `partial`.

**Consequences.**

- Only values the caller sent or its own grant names are named; a filter
  outside the grant is still `evidence_restricted` before anything is read, so
  an existing-but-denied source or account and an unheld one answer the same
  (SC18). Since [ADR 0084](0084-mcp-operator-authority-without-delegation.md) every caller holds the
  whole-store grant, so the listed-grant cases are reached only by tests until
  a narrower grant returns.
- Answers for measured scopes are unchanged byte for byte. `contextId` and the
  paging basis do not change: the context pins inputs, not the result, and
  neither intent pages.
- `no_measures_in_scope` is a new published reason code; the gap reason
  vocabulary stays open text checked only for length
  (`validFinancialResult`).

**Verification.** `packages/application/test/query.test.ts`, "an empty scope
is a reason, never a complete empty answer (INV05)": an unmeasured `account`
filter, an empty snapshot, a listed account never measured beside a measured
one, an unheld `source` filter on the whole-store and on a listed grant (a
denied one stays `evidence_restricted`), and a listed grant's unheld sources
without a filter are `partial` with the gap; a points-only account and a held
`source` filter stay `complete`. Six of these fail against the previous
`execute.ts`.
