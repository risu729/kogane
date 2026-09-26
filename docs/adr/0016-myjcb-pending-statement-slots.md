# ADR 0016: Key MyJCB pending statements by payment month, current while their position shows them

- Status: proposed
- Date: 2026-09-26
- Implemented by: #266
- Carried by:
  [observations](../observations.md#myjcb-pending-statements-are-one-slot-each),
  `myjcbStatementSlot` and `MYJCB_LEDGER_SNAPSHOT_CTES` in
  `packages/read-model/src/sql.ts`, step 3 of `CURRENT_CARD_USAGE_SQL` in
  `packages/read-model/src/card-usage.ts`

## Context

The read model keeps one current MyJCB credit-ledger capture per snapshot slot.
[ADR 0007](0007-myjcb-statement-identity.md) made a confirmed capture's slot
its statement, the payment month, and left the unconfirmed slot as it was: one
slot per connection, whatever the capture's position or label.

JCB closes a cycle on the 15th and confirms it around the 24th
([ADR 0003](0003-relative-period-labels.md), `docs/sources/myjcb.md`). Between
the two, the provider lists two unconfirmed statements: the cycle still
accumulating at position 0 and the closed cycle at position 1. The collector
records both as `unconfirmed` under `detailMonth-0` and `detailMonth-1`
([ADR 0005](0005-myjcb-statement-state-from-page.md)); before that fix it
recorded position 1 as `unconfirmed` every day. With one slot, only the newer of
the two captures was current. The other statement's pending rows were neither
listed nor recognised, the purchase lane retired their events to `unknown`,
and whenever the order of the two captures' publication changed, the lane
retired one statement's events and recognised the other's again with no new
information.

## Options considered

1. **Key the pending slot by its position label (`detailMonth-N`) alone.**
   Rejected. A position shows a different statement every cycle (ADR 0007), so
   the slot is not a statement. When the closed cycle is confirmed, its
   confirmed capture is current under its named month, while its last pending
   capture stays the newest of slot `detailMonth-1` until position 1 is
   unconfirmed again the next cycle: the same purchases current as pending and
   as posted for weeks. Every position-1 capture stored before ADR 0005 would
   stay in that slot too. And one statement is still current twice when its
   position-0 capture of the 15th and its position-1 capture of the 16th are
   each the newest of their label.
2. **Key the pending slot by the payment month alone** (`detailMonth-0` is
   `P0`, `detailMonth-1` is `P0 − 1` under `relative-statement-period-v1`).
   Rejected alone. A month's slot is replaced only by a newer pending capture
   of the same month, and a statement is not captured as pending again once it
   is confirmed: its last pending capture would stay current beside its
   confirmed one, and every past month's last pending capture, the position-1
   captures stored before ADR 0005 included, would become current again. It
   also rests on the unverified switch on the 16th: if the provider moves
   position 0 to the next cycle on a later day, the captures of the 15th and
   the 16th resolve to two months while showing one statement, and both would
   be current.
3. **The payment month, plus "a confirmed capture of the same month ends the
   pending one", plus a window of `P0` and `P0 − 1` of the newest capture.**
   Rejected: three rules where two suffice, the window depends on the
   unverified rule, and the late switch in option 2 still keeps one statement
   current twice.
4. **Only the pending captures of the connection's newest collection run.**
   Rejected: each artifact's parse is published on its own. While position 0
   of a new run is published and its position 1 is not, the older run's
   position-1 statement disappears and comes back, which is the churn this
   ADR removes.
5. **The payment month, current while the position still shows it.** Chosen,
   below. It needs no migration and no stored value: the month is derived from
   the stored label and `fetched_at`, and the position is the artifact key.

## Decision

- **Slot.** Every MyJCB credit-ledger capture, pending or confirmed, has the
  slot `myjcbStatementSlot`: the payment month it shows (`myjcbStatementMonth`,
  an absolute period or `detailMonth-0`/`detailMonth-1` resolved by
  `relative-statement-period-v1`). A relative label no rule places is NULL and
  never current; no pending capture has one. The partition stays (source,
  connection, statement state, slot), so a statement's pending capture and its
  confirmed capture are the same month in different partitions, and the
  confirmed side is exactly ADR 0007's.
- **Position rule.** A pending capture is current only when it is also the
  newest published ledger capture of its position, its artifact key
  `<connection>/credit-ledger-NN.json`, in any state. A newer capture of the
  position shows either the next cycle or the same statement confirmed, so the
  pending capture ends there. Two pending statements of one day are two slots
  and two positions, both current; a later capture of either replaces that one
  only.
- **Across connections** (card usage step 3, the newest representation per
  resolved account): a pending row must also come from the newest fetch run
  among the account's captures of its position, so a replaced connection's
  pending capture ends when the new connection captures that position.
- Recognition keys do not change. The key is the provider row's external id,
  and nothing here changes a parser, a label or an id.

## Consequences

- Both pending statements are listed and recognised as `authorized` purchases,
  and alternating captures no longer retire and recognise anything.
- At confirmation the statement's confirmed capture of position 1 ends its
  pending capture in the same read, so the two are never current together, as
  before. Their rows are different keys (the state is in the external id), so
  the lane retires each pending event once (`provider_status_absent`) and
  recognises the posted row once as `captured`; `authorized` and `captured`
  are never added, and the candidate pass may propose the pair for review.
- A pending statement that moves from position 0 to position 1 on the 16th
  still gets new keys, because its label is in its rows' fingerprint: its
  events retire and are recognised again once per cycle. This ADR does not
  change that; fixing it would be an identity change of the kind ADR 0007
  weighed.
- The switch on the 16th stays unverified. The position rule bounds its
  effect: two captures of one position are never current together, whatever
  months the rule gives them, so a statement that stays at one position is
  current once however the rule keys it. What a wrong switch day still does:
  - pending captures between the rule's switch and the provider's real one
    are keyed by the wrong month (listed and grouped under it);
  - across the two positions the month is the only link, so when the rule and
    the provider disagree about the day a statement moves from position 0 to
    position 1, and position 1 of the move day is published while position 0
    is not yet, the last capture of position 0 (still showing the statement)
    and the new capture of position 1 are two months and **both current: one
    statement current twice**, recognised twice by the lane, until position 0
    is published again and ends the older capture (the lane then retires its
    events). The mirror case hides a statement instead: a newer capture of one
    position keyed to the same month as an older capture of the other
    position, showing a different statement, shadows it until that position
    is captured again. Both last only as long as the publication lag between
    the two positions; neither can be told apart from a correct move without
    the rows themselves. `card-usage.test.ts` pins the double case ("limit:
    with a wrong switch day …").

  A capture on days 12–30 that contradicts the rule is corrected by a new rule
  version, never by editing v1.

- Other limits, not changed here. A pending capture of position 0 stays
  current while its position is not published again, so if no capture of the
  statement's position 1 is published between the 16th and its confirmation,
  and position 0 is still unpublished when the confirmed capture of position 1
  arrives, the statement is current as pending and as confirmed until position
  0 is published (the single unconfirmed slot had the same gap when no
  unconfirmed capture was published in that window). Across connections the
  step-3 rule sees rows, not captures: a replacing connection's capture with
  no rows at a position does not end another connection's pending rows there
  (as step 3's slot rule already did not). A capture without a statement state
  is not pending: the position rules leave it, as before.
- Deploy: nothing is re-parsed or rewritten, no migration. Where the newest
  captures hold a pending position 1 beside position 0, position 0's rows
  become current and are recognised on the next tick. A position-1 capture
  stored as `unconfirmed` before ADR 0005 stays not current once any newer
  capture of position 1 exists. Rollback restores the one slot.
- ADR 0005's "one unconfirmed snapshot slot" and ADR 0006's "one unconfirmed
  MyJCB slot per connection" describe the read model before this ADR. ADR
  0006's conclusion still holds: a pending capture and the posted capture it
  became are never both current rows.

## Verification

Synthetic data only. `packages/read-model/test/card-usage.test.ts` ("two
pending MyJCB statements are two slots"): both pending statements of one day
current where the shipped text kept one; a later capture of position 0
replacing only position 0; a confirmed capture ending its statement's pending
one; an older capture of a position not current where the rule resolves it to
another month; a statement's position-0 capture ended by its newer position-1
capture while the new position 0 is unpublished; a replaced connection's
pending capture ended by the new connection's; two connections of one account
in one run both current, and a later run of one position ending only that
position of the other connection; a capture without a state left alone; and
the wrong-switch-day double above. Each read-model rule (the month slot, the
position rank, step 3's position rule) was removed in turn to see these tests
fail.
`services/processor/test/myjcb-statement-identity.test.ts`: two pending
statements recognised once each, a later capture of one of them retiring
nothing, and the confirmation retiring one pending event and recognising one
captured event; and the move from position 0 to position 1 on the 16th, in
both publication orders: position 1 first retires the old key and recognises
the new one in one tick, position 0 first leaves the statement absent for a
tick; it is never live twice.

The frozen shipped text (`card-usage-legacy-sql.ts`) no longer states the
intended rows, by design: it keeps one pending slot per connection, and since
ADR 0007 it keys confirmed captures by the raw period. The row differentials
(`card-usage-differential.test.ts`, `card-usage-scale.test.ts`,
`card-purchase-keys.test.ts`, every scenario of `card-usage.test.ts`, and
`packages/application/test/card-purchase-scale.test.ts`) therefore compare the
current reads with the shipped text with these rules substituted
(`STATEMENT_SLOT_CURRENT_CARD_USAGE_SQL`): its plan untouched, the slot from
`myjcbStatementSlot`, "newest of its slot" and "newest of its position"
restated as NOT EXISTS, and step 3's position rule as a GROUP BY, instead of
window functions. The
random stores now draw pending and confirmed captures at positions 0 and 1,
relative labels, per-connection runs and two connections of one account, and
the coverage check requires that the shipped one-slot text differs, that the
position rank and the step-3 rule each decide a row, and that two pending
statements of one connection are current. The plan checks still run the
unmodified shipped text and pass unchanged.
