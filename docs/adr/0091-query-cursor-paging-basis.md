# ADR 0091: A query cursor is bound to its context's pinned inputs, not to the request's clock

- Status: accepted (merged 2026-11-08 in [#1172](https://github.com/risu729/kogane/pull/1172))
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
  with every publication event is not built. (The
  [amendment of 2026-11-21](#amendment-2026-11-21-a-publication-marker-that-moves-with-every-publication-change),
  proposed, builds it.)
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

## Amendment 2026-11-21: a publication marker that moves with every publication change

- Status: proposed
- Date: 2026-11-21
- Carried by: `services/app/src/agent-service.ts` (`contextInputs`),
  `packages/read-model/src/observation-reader.ts` (`publicationMarks`,
  `PUBLICATION_MARKS_SQL`, `SOURCE_PUBLICATION_MARKS_SQL` in `sql.ts`,
  `PublicationMarks` in `reader.ts`),
  `packages/domain/src/context.ts` (`financial-context-v2`)

**Context.** The Consequences above recorded a limit: `publicationHighWater`
was the highest visible parse run id of the grant's sources, and "a marker that
moves with every publication event is not built". The `activity` and
`reported-state` rows are read from the published parse runs of visible,
not-excluded runs, under each dataset's snapshot and eligibility policy.
Three changes move those rows without recording a newer parse run, so the marker, the paging basis and, at one evaluation clock, the
`contextId` stayed equal while the answer changed (INV09,
[ADR 0001](0001-domain-axes.md)):

- an activation of an artifact's candidate run, or a rollback, moves its
  `published_parse_runs` pointer to a run older than the newest visible one;
- an `exclude_from_financial_views` annotation hides a run whose parse runs
  are not the newest visible one;
- an operator's in-place update of `dataset_snapshot_policies`
  ([parser coverage](../parser-coverage.md): naming a dataset for the `unit`
  eligibility scope, or another snapshot policy) changes which published runs
  are current. The table is operational state, not append-only, and the
  update records no event.

`services/app/test/query-paging-basis.test.ts` reproduced each on origin/main
(8ba0e3b5): the first page's row changed, while the cursor's `basisRef` and
the `contextId` did not, and the earlier cursor was answered `200` from the
changed rows. The parser build set was held equal on purpose; an activation
onto a build no visible run used moved the parser build digest and hid the gap.

**Options considered.**

1. Keep the limit. Rejected: it is an INV09 gap in a published id, and a page
   read after the change repeats or skips rows.
2. Pin CORE's `core_source_revision`. It moves with every write the balance
   projection reads (migration 0038), but it is one counter for the whole
   store: a change in a source outside a listed grant would move that grant's
   marker, which the context must not let happen (SC18,
   [ADR 0047](0047-mcp-client-connection.md) point 4). It also moves with
   writes these rows never read (mappings, decisions), so every cursor would
   go stale far more often.
3. Pin a digest of every published pointer of the grant's sources. Exact, but
   it reads one row per (artifact, parser) on every query.
4. Pin three marks of what those changes write, read within the grant's
   sources: the newest `publication_events` id (every pointer change appends
   one, migration 0026; the table is append-only, so a new id is always the
   highest), the number of `exclude_from_financial_views` annotations
   (append-only, migrations 0003 and 0043; the kind is the only one the table
   allows and one run holds it at most once, so nothing revokes an exclusion
   without a migration), and a digest of the policy columns the lists read
   from `dataset_snapshot_policies` (`source_id`, `parser_name`, `dataset`,
   `policy_id`, `required_parser_version`,
   `replaces_previous_on_complete_empty`, `unit_scope`,
   `snapshot_selection`). The first is one primary-key search, the second
   scans the exclusions, the third the policy rows (245 on the migrated
   schema, one per parser and dataset, not one per capture).

**Decision.** Option 4. `publicationHighWater` is
`published-parse-runs@<id>+publication-events@<id>+exclusions@<n>+snapshot-policies@<digest>`.
For a whole-store grant the marks are the whole store's
(`PUBLICATION_MARKS_SQL`); for a listed grant they are read through
`fetch_artifacts` and `fetch_runs` for the listed visible sources only, and
the policy rows that name a listed source (`SOURCE_PUBLICATION_MARKS_SQL`). The context schema becomes
`financial-context-v2`; its keys are unchanged.

**Consequences.**

- An activation, a rollback, an exclusion or a policy update makes an earlier cursor
  `stale_context`, and two answers at one clock across it carry different
  `contextId`s and `resultRef`s.
- Every `contextId`, `resultRef` and paging basis changes once at deploy, and a
  cursor issued before it is `stale_context`. Nothing stores them.
- A denied source's publication, exclusion or policy update still moves no
  listed grant's context. Every proved caller holds a whole-store grant over
  the Worker ([ADR 0084](0084-mcp-operator-authority-without-delegation.md)),
  so a listed grant is the shared service's; the tests below call it directly.
- Cost on D1 (workerd `rows_read`, the migrated CORE schema): the whole-store
  statement reads 247 rows, of which 245 are the policy rows, and returns
  about 27 KB of policy text, whatever the number of publication events; the
  listed statement reads the listed sources' artifacts, events and runs
  through `idx_fetch_artifacts_source_dataset_time`,
  `publication_events_target` and `idx_fetch_runs_source` (plans without
  table statistics).
- Limits: the overview, the marks and the rows are read in separate
  statements, so a change that lands between the marks and the rows is
  answered under the earlier marker: that answer's `contextId` is the one of
  the unchanged store, and a cursor checked against that marker resumes over
  the changed rows. A policy row counts for the source it names; a row whose
  `source_id` is not the source of the artifacts it matches moves no listed
  grant that holds only those artifacts. A deploy that changes the read SQL
  between two pages keeps the basis, as before.

**Verification.** `services/app/test/query-paging-basis.test.ts`: over the
real read model and CORE migrations, an unchanged store keeps the rows, the
`contextId` and the basis; an activation onto an older candidate run, an
exclusion of a run below the newest visible one and a dataset named for the
`unit` eligibility scope each change the first page, the `contextId` at one
clock and the basis, and the earlier cursor is `409 stale_context`; and all
three in a source outside a listed grant move the whole-store context but
leave the listed grant's rows, `contextId` and basis equal and its cursor
`200`. Reverting `contextInputs` to the parse-run marker fails the three
change cases, leaving the policy digest out fails the third, and reading the
whole-store marks for a listed grant fails the last.
`packages/read-model/test/publication-marks.test.ts`: the listed marks move
only with the listed sources' events, exclusions and policy updates, the
whole-store marks with any, and a policy column the lists do not read
(`updated_at_ms`) moves none.
