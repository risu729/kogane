# ADR 0105: Preserve Vpass credit snapshots as overlapping provider reports

- Status: proposed
- Date: 2026-11-10
- Issue: [#1256](https://github.com/risu729/kogane/issues/1256)

## Context

The [dated normal-browser observation](../sources/vpass.md#2026-11-10-daily-per-card-credit-and-revolving-snapshots)
established available credit and outstanding amounts separately from statement
pages. Authori reports 1,000 JPY precision; the separate revolving response
reports two exact-yen fields. Overall, card and payment-component amounts
overlap and multiple cards share limits. Existing statement responses already
retain masked limit advisory information.

## Options considered

1. Treat availability as a bank balance or authori integers as yen. Rejected:
   both change the observed meaning; they would fabricate assets and precision.
2. Publish card/component residuals as canonical liabilities and sum them.
   Rejected: shared limits and overlapping outstanding reports are not a
   disjoint debt universe.
3. Add an independent daily card snapshot with explicit reported metrics,
   precision and non-additivity. Chosen.

## Decision

- Reuse the current authenticated member session, observed empty-content POST
  sequence and card selection. Capture each selected card daily, with no new
  collection parameter, login interaction, cursor or financial action.
- Persist a separate `<session>-credit-card-NNN` run before statements.
  Its original `card-NNN` unit and v2 binding unit retain the exact existing
  stable card-binding contract and acquisition session. A card's snapshot and
  statements can succeed independently, and one card cannot discard another.
- Keep the two credit responses in private DATA after the new
  `vpass-credit-json-sanitizer@v1` removes authentication, session and
  card-reference fields. It explicitly preserves observed Authori data keys,
  which the statement sanitizer's broad `auth` rule would redact.
  The existing sanitizer v1 output and old stored objects remain unchanged.
- Register only `credit/authori.json` and `credit/revo.json`, as sanitized
  JSON, to `credit-snapshot` under `terminal-registration-v8`. Freeze
  v1-v7 mappings. Unchanged descriptors carry over without republishing
  statement transactions.
- `vpass-credit-snapshot@1.0.1` publishes reported overall/card/revolving/
  installment-twice-bonus limit, outstanding and availability only for visible
  rows. Monetary conversion cross-checks raw thousand-yen integers against
  the observed 万円 display. Metric names explicitly retain thousand-yen
  precision and `extra._kogane.reportedPrecisionJPY=1000`.
  Separate `revoZan` and `hensaiAmount` retain signed exact reported yen,
  with precision 1. No unobserved raw limit scale is inferred.
- Unknown shapes, missing rows, unexpected display flags, inconsistent amounts,
  malformed dates or unsuccessful sessions cannot publish a complete snapshot.
  Hidden rows produce no numeric-zero observation.
- Every metric is provider-reported, non-additive, outside net assets and in
  one shared-credit overlap group. The legacy balance list labels capacity
  and reported outstanding explicitly; no new liability adoption occurs.
- Migration 0092 adds only the `coverage-v1`, unit-scope selecting policy.
  Complete newer card containers replace previous containers. History remains
  append-only. The provider catalogue uses the existing `balance` type and
  `partial` status, so no catalogue vocabulary/status-meaning version changes.

The cash reconstruction perimeter and opening balances exclude this parser:
a reported credit container establishes no cash-basis opening stock.

## Consequences

The reported-state reader can show each card's daily report without adding
shared overall/card/component values into assets or liabilities. Two runs
remain evidence but contribute only the latest complete card snapshot.
Exact installment precision remains unobserved and #1256 remains open.
Authentication challenges, cashing interpretation and exact installment debt
are unsupported; V Point is not collected again. No deployment, live collector,
production replay or production publication is part of this change.

## Verification

Synthetic fixtures cover scale/display agreement, signed exact revolving
values, hidden rows, card partitions, malformed sessions/shapes/flags/dates and
unchanged statement sanitizer behavior. The processor integration test drives
the real scheduled collector through mocked observed routes, shared R2,
registration, parsing/publication and the actual dated-balance reader for two
cards over two runs; it also checks the existing stable binding view and
non-additive metric definitions. Required workspace/root checks and independent
review are recorded in the PR after they run.

The container registry includes the new policy. The local pipeline applies
migration 0092 once, preserves operator overrides on reopen, and admits a
partial parent only when existing policy/unit metadata proves independence.
The 1.0.1 reader records the display-container evidence even when all rows
are hidden; it emits no balance of zero and cannot replace an earlier
container with an empty claim. Real-parser local tests keep the failed card on its prior snapshot and reject
a newer paired response set with one unreadable artifact. Production policy
seed, comparison-route and registration-version assertions remain explicit.

## Amendment 2026-11-12: Preserve the normal Authori view transition

The [normal-browser observation](../sources/vpass.md#2026-11-12-the-normal-authori-module-transition)
establishes `vp.member.pages.info` as the public module returned by the final
successful Authori response. One failed stored Authori artifact independently
matched that module in a bounded remote projection; the reader's empty-only
transition guard was its first rejection. Aggregate counts alone do not prove
the inner cause of every other failed artifact.

Reader 1.0.2 admits this exact transition only for `credit/authori.json`, while
preserving empty-transition acceptance and the empty-only Revo contract.
Unknown transitions, unsuccessful result codes, false login flags and every
financial shape/display check remain closed. Accepting arbitrary nonempty
transitions was rejected: it would lose the distinction from an interaction
or login gate. No new provider meaning, metric, precision or catalogue status
is inferred.

Migration 0102 advances only the full shipped 0092 default to reader 1.0.2.
Every policy field and the shipped timestamp participates in its guard;
operator alternatives, including rollback pins, remain untouched. Raw objects,
historical parses and publication records are unchanged. The local store
applies the same guarded migration on reopen.

Synthetic tests cover exact normal-transition acceptance, historical empty
acceptance, near matches, wrong-endpoint use and unsuccessful sessions. The
existing native scheduled-collector/publication/current-reader test uses the
normal Authori module and empty Revo responses without changing its assertions
or deadline. Migration tests verify exact default advancement, idempotence and
preservation of every operator-selected field. Production reprocessing and
daily publication verification are separate from this compatibility change.
