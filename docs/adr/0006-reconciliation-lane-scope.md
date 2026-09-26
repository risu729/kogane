# ADR 0006: Keep the reconciliation lane to provider identifiers and the matching window

- Status: accepted
- Date: 2026-09-26
- Implemented by: #243 (stage A, the window, the cursor); #258 (retires the
  lane's Vpass/MyJCB stage B); the purchase lane's candidate pass is #241
- Carried by: [economic events](../economic-events.md#matching-stages),
  `services/processor/src/reconciliation-job.ts`,
  `packages/storage-d1/migrations/core/0048_reconciliation_scan_cursor.sql`,
  `services/processor/src/card-purchase-job.ts`

## Context

The reconciliation lane proposed pairs over published rows. Stage A paired
Vpass and MyJCB captures of one displayed row by their fingerprint external
ids, about 26,000 `provider_same` proposals nobody could decide. Stage B paired
every pending row of a month with every posted row of it (40 × 60 rows gave
2,400 candidates, nearly all ambiguous), and each slice re-read its first
1,000 rows every tick, so rows past them were never paired. Card purchase
recognition ([ADR 0002](0002-card-purchase-recognition.md)) added a second
pending-to-posted matcher over recognised events.

## Options considered

1. Keep both matchers for Vpass and MyJCB. Rejected: the lane pairs rows, and
   the shared snapshot definitions (`src/sql.ts` in `packages/read-model`)
   keep one capture per Vpass card and statement month, whatever the family,
   and one unconfirmed MyJCB slot per connection (since
   [ADR 0016](0016-myjcb-pending-statement-slots.md), one per pending
   statement, ended by any newer capture of its position). A pending capture and the
   posted capture it became are therefore never both current rows. Only
   recognised events keep both: an `authorized` event stays live, or retired
   to `unknown`, beside the `captured` one.
2. Pair over every stored row rather than current rows. Rejected: it pairs
   captures of one row with each other and grows with history.
3. Keep the pending-to-posted heuristic in the purchase lane's candidate pass
   (#241), and narrow the reconciliation lane to what it can decide. Chosen.

## Decision

- **Stage A** pairs only identifiers the provider issued
  (`identifierOrigin: "provider"` on both sides, from the parser's
  `_kogane.identityOrigin`). A collector fingerprint or an unrecorded origin
  pairs nothing.
- **Stage B** admits a pair without a provider link id only inside the
  matching window: the posted row's usage day is the pending row's day or at
  most 5 days after it (`DEFAULT_MATCH_OPTIONS.dayWindow`). More than one
  candidate for one pending row, or for one posted row, marks all of them
  ambiguous (`multiple_candidates` / `candidate_not_unique`). `proposalIdentity`
  is unchanged, so a stored pair keeps its digest.
- **Scan cursor**: each slice pages through its rows with one row in
  `reconciliation_scan_cursor` (CORE 0048, operational), and a stored
  proposal never takes the write budget again.
- **Stage B for Vpass and MyJCB is retired from this lane** (#258):
  each slice names the stages it runs (`RECONCILIATION_SLICES[].stages`, a
  closed set of `A` and `B`), and both the Vpass and the MyJCB slice name
  stage A only. A stage-A-only slice reads a group only for a page row with a
  provider-issued id (`pairable`), so for Vpass and MyJCB a tick pages through
  its rows and reads no group, looks up no digest and writes nothing. The
  pending-to-posted heuristic for card usage lives only in the purchase lane's
  candidate pass. Proposals the lane already stored stay as history, open or
  decided; proposals are append-only and nothing resolves or deletes them, and
  a stored digest is never sent again by either lane.

## Consequences

- The `provider_same` rows written before #243 stay `proposed`; candidate reads
  select stage B by the `(kind, stage)` index of 0048, so they are never read.
- A source whose parser records a provider-issued row id (SBI Shinsei,
  PayPay) pairs nothing in stage A until it records the origin and joins a
  slice.
- Coverage gap: a row the purchase lane does not recognise (an unsupported
  payment type, an amount that is not exact, an unresolved account) gets no
  pending-to-posted candidate; a MyJCB pending and confirmed row whose usage
  days straddle a month end fall in two candidate groups and are not paired;
  and a pending refund is never paired with a posted purchase, or the
  reverse, because the candidate pass pairs only events of one kind. On the
  CI-scale card store the lane's old stage B made 292 proposals: 26 the
  candidate pass also makes, 151 other captures of those pairs, 21 refund
  against purchase and 94 on a row the purchase lane does not recognise
  (`payment_type_unsupported`).
- Stage B proposals the lane stored before #258 stay as history, open or
  decided.

## Verification

`packages/domain/test/reconcile.test.ts` pins the window and the unchanged
digests, and `services/processor/test/reconciliation.test.ts` the sweep, its
cursor, the deployed stage-A-only slices (no group read, no lookup, no write,
a stored proposal untouched) and a provider-issued id still pairing under
stage A, on synthetic data.
`services/processor/test/reconciliation-coverage.test.ts` sorts every stage B
proposal the old lane made on the CI-scale card store into the four groups
above, none unexplained.
