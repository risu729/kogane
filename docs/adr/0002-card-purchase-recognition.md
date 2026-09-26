# ADR 0002: Recognise card purchases per provider row, one live holder per key

- Status: accepted (on in production since 2026-09-24)
- Date: 2026-09-24
- Implemented by: #232, #233, #234, #235, #236, #237, #238, #239, #240, #241
- Carried by: [economic events](../economic-events.md#card-purchase-recognition),
  `packages/domain/src/card-purchase.ts`,
  `packages/storage-d1/migrations/core/0047_card_purchase_recognition.sql`,
  `packages/storage-d1/src/atomic/card-purchase-recognition.ts`,
  `services/processor/src/card-purchase-job.ts`

## Context

The card milestone is "card usage → statement → bank debit without counting an
expense twice" ([roadmap](../roadmap.md#delivery-order-and-the-next-milestone)).
Vpass and MyJCB show a purchase twice over its life, a pending (unconfirmed)
row and later a posted row, under different external ids, and each row is
captured again on every run. Nothing turned an adopted row into an economic
event, so the statement and debit review of
[card settlements](../card-settlements.md) had no purchases to explain.

## Options considered

1. Derive purchases at read time from the current rows. Rejected: nothing
   would record which rows were recognised, a re-keyed row would silently
   change the totals, and there would be no decision to review (INV07).
2. Merge pending and posted rows automatically by amount and date. Rejected:
   two purchases of one amount on one day are two purchases (SC03), and a
   posted amount can differ from its authorisation.
3. One event per provider row, identified by the row's own recognition key and
   written as an ordinary event revision with a `rule` decision; heuristics
   only propose. Chosen.

## Decision

- **Recognition key**:
  `json_array(source_id, producer_id, external_id_namespace, source_account, external_id)`,
  the row's own key in one verified namespace. `card_purchase_recognition_keys_guard` (0047)
  refuses any other value and pins the observation and its parse run.
- **Event id**: `purchase_<sha256>` or `refund_<sha256>` over the policy and
  the key that first recognised it. A key a live event holds keeps that event.
- **Decisions**: every revision is a `decision_revisions` row with
  `method='rule'` and `actor_id='rule:card-purchase-recognition-v1'`, `accept`
  for the first revision and `supersede` for every later one.
- **One live holder per key**: the trigger
  `card_purchase_recognition_keys_one_live_holder` (0047) refuses a second
  live holder. This is the no-double-count invariant. A superseded revision
  holds nothing, so a supersession releases a key to the revision that
  replaced it.
- **The `purchase_recognition` lane**, every five minutes: the retire pass
  runs first (at most 100 events none of whose keys is current), then
  recognition reads from the scan cursor `card_purchase_scan_cursor`, which
  stops where the write budget stops and wraps to 0 after the last page.
  Recognition waits for the retire pass only while that pass fills and retires
  a whole page, so after a key change touching K rows it runs again within
  ⌈K / 100⌉ ticks; a page with a conflict or a failed batch never defers.
- **Pending and posted stay two events** (`authorized` and `captured`). Only
  `captured` counts as captured; `authorized` is shown apart and never added
  to it. They become one purchase only through a reviewed `relation.accept` of
  a stored candidate, whose marker is `reconciliation-proposal:<id>`
  (`packages/domain/src/pending-posted-review.ts`); `relation.reject` of an
  accepted link splits them again. The lane merges by rule only a pair the
  provider itself linked, which no deployed parser supplies today.
- **Heuristics are proposal-only (INV07)**: the lane's candidate pass writes
  `reconciliation_proposals` rows; amount and date closeness never merge
  anything.
- Only single-payment rows with an exact, non-zero JPY amount, a usage date
  and a stable card identity are recognised; every other row is skipped with a
  closed code (INV05). [ADR 0004](0004-payment-type-shapes-from-evidence.md)
  records which payment types count as single.

## Consequences

- A merge moves the posted leg to the surviving pending-origin event and
  supersedes the posted event across ids, so the captured total is unchanged
  by a merge and by a split.
- A retired event keeps its keys, so no other event can take its row. A
  changed external id retires and recreates events: churn, never a double
  count. [ADR 0007](0007-myjcb-statement-identity.md) removes the monthly
  MyJCB churn this caused.
- Refund allocation, "this row is not a purchase", installments and more bank
  adapters remain reviewed work for the
  [next milestone](../plans/2026-09-next-milestone.md).

## Verification

Synthetic data only, as listed under
[economic events](../economic-events.md#verified-locally-synthetic-data-only)
for the lane, the guards and the merge and split writes. The production
enablement is recorded in
[rollout](../rollout.md#production-enablement--2026-09-24-card-purchase-recognition).
