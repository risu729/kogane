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

## Amendment 2026-11-21: a merged event is retired by its posted row

- Status: proposed
- Date: 2026-11-21
- Owner approval: required before merge, as a changed rule of this accepted
  record. No route, tool or wire shape changes; the captured totals of the
  purchase pages and `kogane.purchases.explain` stop counting twice the
  purchase this case counted twice.

### Context

The retire pass retired a live event only when none of its keys was current
(`staleCardPurchaseKeysSql`): "an event that still holds one current key is
not stale". The writer, though, treats a merged event (one posted key and its
pending key, the shape a reviewed or provider-linked pending-to-posted merge
leaves) as following its posted row: it is revised from that row, and its
pending row adds nothing. The two rules disagree when the pending row is still
current and the posted row is not. A MyJCB pending capture stays current
beside the confirmed one until its position (`credit-ledger-NN`) is captured
again ([ADR 0016](0016-myjcb-pending-statement-slots.md)), so a reviewed merge
can hold a current pending key. If the confirmed row is then captured under
another key (its cells read differently, or a parser release changes the
external ids and the confirmed ledger is re-parsed first), the new row is
recognised as a new captured event while the merged event, kept alive by its
pending key, stays captured with the old leg: the captured total counts one
purchase twice (INV06). Unmerged, the same change retires the posted event
and recognises its replacement: churn, never a double count. A synthetic
reproduction on the deployed parsers showed a captured total of twice the
purchase; nothing in production was read.

### Options considered

1. **Keep "one current key".** The double count stays until the pending
   position is captured again. Rejected.
2. **Decide a revision by its posted keys when it holds one, else by all its
   keys (chosen).** The retire rule then matches the writer's: a merged event
   follows its posted row for revision, re-anchoring and retirement. A
   revision with no posted key is decided as before.
3. **Retire only the merged event's leg, keeping it captured without one.**
   A captured event without a leg is a shape no reader handles; rejected.

### Decision

`staleCardPurchaseKeysSql` reports the keys of a live `authorized` or
`captured` revision none of whose deciding keys is current: its posted keys
when it holds one, else all its keys. `held_current` keeps a revision found
through a current key only when that key is posted or the revision holds no
posted key (probed by the primary key). The retire pass is unchanged: it
retires the merged event holding both keys, before recognition, so the
replacement is never counted beside it.

### Consequences

- A merged event whose posted row is gone is retired even while its pending
  row is current. That pending row stays held by the retired event, so it is
  neither recognised again nor shown apart as an authorisation; the
  replacement row is its own captured event, which a reviewer can link to a
  new pending row as before. If the posted row reappears, the merged event is
  captured again, as before.
- Every other revision is reported exactly as before: the read returns the
  shipped text's rows plus exactly the keys of revisions holding a posted key,
  none of them current, and a current pending key.
- Cost: one primary-key probe per current key that a revision holds; no new
  scan. The retirement proof (migration 0064) is unchanged: the read depends
  on the same tables.

### Verification

- `services/processor/test/card-purchase-merged-posted-gone.test.ts`: on the
  deployed MyJCB parser and the change lifecycle on Miniflare D1, a purchase
  on both ledgers merged by a reviewed accept, then its confirmed row captured
  under another key while the pending capture stays current: the merged event
  is retired holding both keys, the replacement is the one captured event, the
  captured total is the purchase once, and a second pass writes nothing. It
  failed before the change (captured total twice the purchase).
- `packages/read-model/test/card-purchase-keys.test.ts`: the same shape on the
  card store fixture, reported stale with both keys.
- `packages/read-model/test/card-purchase-stale-reference.ts`, used by
  `card-purchase-keys.test.ts`, `card-usage-differential.test.ts` and
  `card-usage-scale.test.ts`: every read equals the frozen shipped text
  (`card-usage-legacy-sql.ts`) plus exactly the revisions the amendment adds,
  computed in TypeScript from the live keys and the current rows, at every
  page size; the random seeds draw such a revision (a new drawn state), the
  scaled store holds none and its plan checks still pass without table
  statistics.
