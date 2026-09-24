# Economic events, allocations, obligations and reconciliation

Architecture addendum A10 (findings AR07 and AR08; addendum 07; root review 09
§2–§4). This change adds the first Layer C vertical slice: a rule that proposes
matches between observations, a decision that adopts one, and an event model
with typed legs, allocations, obligations and settlements that the read side can
explain down to the raw bytes.

Nothing here rewrites Layer A or Layer B. No observation is updated or deleted,
no parser version changes, and the existing visible result set is unchanged
while both flags are off.

## Product delivery scope

The implemented Vpass pending/posted slice below is the starting point for
phases 6–7, not completion of reconciliation or event generation. The
[next product milestone](roadmap.md#phases-67--reconciliation-and-economic-event-generation)
adds MyJCB, card statements and bank debits, with review/correction and an
explanation from purchase through settlement to source evidence. Event, leg,
allocation and settlement tables still need continuous population from the
supported transaction families. Matching two observations alone does not
produce the complete economic event or its balance effect.

## What is automatic and what is proposal-only

| Step                                                      | Who does it                                               |
| --------------------------------------------------------- | --------------------------------------------------------- |
| Producing candidates from published observations          | The rule job, whenever `RECONCILIATION_ENABLED` is on     |
| Accepting a candidate                                     | A decision in the decision log, through a guarded command |
| Accepting a candidate the provider itself linked          | The rule, **still** as a recorded `accept` decision       |
| Recognising an adopted card usage row as a purchase       | The rule job, **still** as a recorded `rule` decision     |
| Anything from amount + date closeness, a heuristic, or AI | Proposal only. Never accepted without a decision (INV07)  |

[Card purchase recognition](#card-purchase-recognition) runs only while
`PURCHASE_RECOGNITION_ENABLED` is on, and only for single-payment rows with an
exact amount and a stable card identity.

A confidence number is not produced anywhere. A candidate carries rationale
codes and rejection conditions, which is what a reviewer needs; a score is at
most an ordering aid and never evidence or authority (addendum 07 §3).

## Tables (migration `0032_economic_events.sql`)

Additive only. Every table has the `*_no_delete` / `*_no_replace` triggers of
0018 and 0029, and no column that carries a fact is ever updated. Exactly two
one-shot pointers may be written after insert, each guarded by a trigger:

- `superseded_by` on `economic_event_revisions`, `obligation_revisions`,
  `allocations` and `settlement_relations`;
- `(status, decision_revision_id)` on `reconciliation_proposals`, which records
  which decision resolved a candidate.

| Table                      | Role                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reconciliation_proposals` | One candidate: `kind`, `stage` (A/B/C), typed `target_refs_json` (`SourceFactRef`s), `method` (`rule`/`manual`/`ai`), `policy_release`, `rationale_codes_json`, `rejection_conditions_json`, `evidence_refs_json`, `status`, `proposal_digest`. |
| `economic_event_revisions` | One adopted event revision: `kind`, `state` (checked against its own kind family), `unknown_reason`, `effective_time_json` (a `TemporalValue`), `basis`, `evidence_support_json`, `decision_revision_id`, `superseded_by`.                      |
| `economic_legs`            | The legs of one event revision: `subject_ref`, `unit_ref`, decimal-v1 `value_status`/`coefficient`/`scale`, `role` (`increase`/`decrease`/`fee`/`unresolved`), `basis`.                                                                         |
| `allocations`              | How much of one source component is attributed to one effect: `source_component_ref`, `target_effect_ref`, `role`, `unit_ref`, `coefficient`, `scale`.                                                                                          |
| `obligation_revisions`     | Principal, `fee_components_json`, `schedule_json`, `state` with `state_evidence_refs_json`, creditor and debtor.                                                                                                                                |
| `settlement_relations`     | N-to-M settlement: allocated amount, `occurred_json`, and the `unresolved_*` difference kept beside it.                                                                                                                                         |

Views `current_economic_events`, `current_obligations`, `current_allocations`
and `current_settlement_relations` are the live revisions (`superseded_by IS
NULL`). A superseded revision is retained, so a report that cited
`event:<id>@<revision>` keeps resolving to the same numbers.

`allocations` has a partial unique index on
`(source_component_ref, target_effect_ref, role) WHERE superseded_by IS NULL`.
Citing an observation twice as supporting evidence stays possible; allocating
its amount twice into the same live set does not (INV06).

### Card purchase recognition (migration `0047_card_purchase_recognition.sql`)

The writer is the `purchase_recognition` lane
([below](#card-purchase-recognition)), on in production since 2026-09-24.
A recognised card purchase is an ordinary `purchase` or `refund` event
revision on the `purchase-recognition` basis with a `rule` decision; 0047 adds
the sidecar that says which policy wrote each revision and from which provider
rows. The contract is `packages/domain/src/card-purchase.ts`, and the guarded
batch that writes one revision is
`packages/storage-d1/src/atomic/card-purchase-recognition.ts`.

| Object                               | Role                                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `card_purchase_recognitions`         | One row per event revision: `policy_release`, `action` (`recognize`/`revise`/`reanchor`/`retire`/`merge`/`split`), `content_digest`, `account_id`, `source_id`, `statement_period`, and `facts_json` restricted to codes, amounts and dates (no merchant or provider text). |
| `card_purchase_recognition_keys`     | The revision's recognition keys, `json_array(source_id, producer_id, external_id_namespace, source_account, external_id)`, with `role` (`posted`/`pending`) and the pinned `observation_id`/`parse_run_id`.                                                                 |
| `current_card_purchase_recognitions` | Sidecar rows of live revisions, with their `kind`, `state` and `unknown_reason`.                                                                                                                                                                                            |
| `current_card_purchase_keys`         | Keys of live revisions.                                                                                                                                                                                                                                                     |
| `card_purchase_scan_cursor`          | Operational singleton `(1, last_observation_id)`; outside the source-revision ledger.                                                                                                                                                                                       |

Both sidecar tables are append-only. Their insert guards require the event's
only live revision, a `purchase`/`refund` on the `purchase-recognition` basis
(so a batch writes revision → legs → supersede → sidecar → keys); a `retire`
row is exactly the `unknown` state with no leg, and every other row has exactly
one exact, positive `purchase-recognition` leg on `account:<account_id>`, equal
to the magnitude of the displayed row's amount, and no cash-movement leg. Legs
are sealed once the sidecar exists; that trigger on `economic_legs` fires only
for a revision with a sidecar, so card settlements and every other existing
writer are unaffected. `facts_json` is checked value by value (closed code
sets, a calendar date, an exact decimal), not only by key. A key must be the
cited row's own key and match its parse run and provider status, and **at most
one live revision may hold a key**: the one-live-holder trigger is the
no-double-count invariant. A superseded revision holds nothing, so a
supersession releases its keys to the revision that replaced it.

What the contract reads from the parsers: Vpass `1回払い` and MyJCB `一回払い`
are single payments; MyJCB's usage and payment texts (`1,200円`, `-500円`) are
read with the MyJCB ledger parser's own amount grammar and must agree; the
statement period is stored as `YYYY-MM`, the key `card_statement_facts.period`
uses, from Vpass `statementMonth` and from MyJCB's `YYYY年M月お支払い分` label
(any other label is stored as `NULL`, never guessed). One known gap is left
alone on purpose: the reconciliation job's MyJCB installment guard, moved
unchanged to `comparableCardPayment`, still reads only plain digits, so no
real MyJCB confirmed row (`1,200円`) takes part in pending-to-posted matching.
Widening it would start new production proposals and is a separate reviewed
change; recognition does not depend on it.

### Where the decisions live

Judgements are recorded in `decision_revisions` (migration 0029). Its
`subject_kind` CHECK admits only `account_mapping`, `instrument_mapping` and
`relation`, and 0029 cannot be edited, so every A10 judgement uses
`subject_kind='relation'` with a prefixed `subject_ref`: `proposal:`, `event:`,
`obligation:`, `allocation:` or `settlement:`. The prefixes keep those subject
namespaces disjoint from the `entity_relations` ids, which use the bare form.

`RELATION_STATUSES` in `packages/domain` diverged from the stored
`entity_relations.status` CHECK (`proposed|accepted|rejected|released`). The
domain type is now the union of both wordings and `RELATION_STATUS_STORAGE` maps
a domain value to the stored one (`adopted → accepted`, `superseded →
released`). The DB CHECK is unchanged.

## Domain contracts (`packages/domain`)

- `src/events.ts` — `SourceFactRef`, `EconomicEventRevision`, `EconomicLeg`,
  `ObligationRevision`, `SettlementRelation`, the per-kind state families and
  `eventTransition`, plus the pure checks:
  - `conservationCheck` — `source decrease = destination increase + explicit fee
    - unresolved difference`, **per unit**. Legs in more than one unit are
returned side by side with `cross_unit_requires_fx_model`; signed amounts in
      different units are never added and never forced to zero (SC05: 1,005 AUD
      against 95,000 JPY). A single-unit event must balance, and any gap is
      reported rather than absorbed into a fee.
  - `splitFillCheck` — `sum(fills) ≤ executed quantity`.
  - `settlementCheck` — `sum(allocations) ≤ eligible outstanding`, and the
    resulting obligation state comes from what was actually allocated.
  - `refundAllocation` — refunds with an unknown counterpart stay unallocated
    and visible; an over-refund is reported as an `over_refund` exception with
    the excess, never absorbed into the purchase (SC03, UC17).
  - `effectiveRate` and `referenceQuoteDifference` — the second returns
    `kind: "estimate"`, deliberately not a fee (UC21).
  - `legTotal` — a total for one basis and unit; two bases are never summed.
- `src/reconcile.ts` — the stage A/B/C candidate matcher. It returns proposals
  with rationale codes only, always `status: "proposed"`, and
  `autoAcceptable: true` only when the provider itself linked the pair inside
  one verified namespace (source + credential epoch + account namespace).

## Matching stages

- **Stage A — the same provider row observed twice.** Provider-identifier
  equality inside one identifier namespace. A collector fingerprint is not a
  provider identifier: such a pair is proposed and reviewed.
- **Stage B — a revision or a second display inside one provider.** Pending
  against posted. Amount and date closeness alone yields a candidate, never an
  acceptance: two purchases of the same amount on the same day must not be
  collapsed (UC13, UC23, SC03). More than one heuristic candidate for one
  pending row marks all of them `multiple_candidates` / `candidate_not_unique`.
- **Stage C — a correspondence across sources.** Equal opposite amounts on
  nearby days never establish ownership; without an established owner on both
  sides the candidate carries `owner_not_established`, and cross-source
  correspondences are reviewed at this stage whatever else agrees.

`RECONCILIATION_KINDS` is a strict subset of the `entity_relations` kinds of
0029, so an accepted proposal can always be written as a relation without
widening that closed list. Settlement is not one of them: it is a first-class
`settlement_relations` row with its own allocated amount, not a bare edge.

## The vertical slice that runs

`services/processor/src/reconciliation-job.ts` runs stage A and
stage B over **one** source pair: **pending against posted inside the Vpass
statement page**. That parser emits two provider displays of the same card and
statement month — the `customized` family with provider status `unconfirmed`
(a pending authorisation) and the `web` family with `posted` — under one
`vpass:<card>` source account. It is the only pair in the deployed parser set
where both sides of a pending/posted revision exist in one identifier
namespace, so no cross-source ownership has to be established first. MyJCB's
credit ledger has the same shape (`unconfirmed` / `confirmed` for one connection
and period) and is the documented next entry in `RECONCILIATION_SLICES`.

Stage C is not run yet: it needs an established owner on both sides and a second
source in the slice.

### Which sources supply a provider link id

Auto-acceptance needs an identifier the provider issued **for the pair**,
surfaced by a parser as `extra_json.$._kogane.providerLinkId`. Surveying the
deployed parsers and `docs/sources/*.md`:

| Source                                                                                                                                        | What it exposes                                                               | Effect                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SBI Shinsei (`txnReferenceNo`), SMBC Direct, SBI VC Trade (`cashflowId`, `executionId`), PayPay (`transactionNumber`), V Point Pay (event id) | A provider row id                                                             | Identifies one row (stage A). Does not link pending to posted. |
| MyJCB                                                                                                                                         | A third-party column survey mentions an approval number on the debit sections | Not read by the deployed ledger parser.                        |
| Vpass, Sony Bank, MoneyForward, Mobile Suica, Global Pass, SBI Securities histories                                                           | External ids derived from a collector fingerprint                             | Not a provider identifier at all.                              |

So **no source currently supplies a pending-to-posted link id**, and every
proposal this job writes stays `proposed`. The automatic path exists, is
guarded, and is covered by a test with a synthetic source that does report one.

### Acceptance

`services/processor/src/reconciliation-commands.ts` exposes
`decideProposal` / `acceptProposal`, guarded exactly like `identity-commands.ts`:
a caller-chosen `operationId` makes a resend idempotent, the actor is the
principal the server verified, and `expectedStatus` is the state the caller saw.
All writes of one command are one D1 batch guarded on the ledger row, so a
failed guard writes nothing. An acceptance appends two decision revisions (one
for the proposal, one for the relation it creates), inserts the
`entity_relations` row, and resolves the proposal. A09 will expose this as an
authenticated command route; there is no public write route today.

Undoing an acceptance is never a DELETE: a later decision appends a new revision
and the old one stays readable.

## Card purchase recognition

`services/processor/src/card-purchase-job.ts` is the `purchase_recognition`
lane. It turns adopted Vpass and MyJCB usage rows into `purchase` and `refund`
events on the `purchase-recognition` basis, through the contract, the guarded
batch and the schema of
[migration 0047](#card-purchase-recognition-migration-0047_card_purchase_recognitionsql).
It is on in production since 2026-09-24: `PURCHASE_RECOGNITION_ENABLED` is
`"true"` in the committed configuration
([rollout record](rollout.md#production-enablement--2026-09-24-card-purchase-recognition)).

### What is automatic, and why

Recognising one posted usage row as a purchase asserts no correspondence
between two claims (INV07). The provider itself states that the charge was
posted to that card, inside one verified namespace (source + producer +
external id namespace + source account). A row is **adopted** when its parse
run is published and it belongs to the latest complete snapshot, the one
definition of "current" in `packages/read-model/src/card-usage.ts`
(`currentCardUsageSql`). Each revision is still a recorded decision: one
`decision_revisions` row with `subject_kind='relation'`,
`subject_ref='event:<id>'`, `method='rule'`,
`actor_id='rule:card-purchase-recognition-v1'`, no operation, `accept` for the
first revision and `supersede` for every later one, and the reason
`card-purchase-recognition-v1:<action>`. No provider text is stored in the
decision, the event or the sidecar.

The scope is deliberately narrow. Only a single-payment row (`1回払い`,
`一回払い`) with an exact, non-zero JPY amount, a usage date and a stable card
identity is recognised. Every other row is skipped with a code from a closed
set and never guessed (INV05): `account_not_resolved`,
`card_identity_unstable`, `amount_not_exact`, `amount_zero`,
`unit_unsupported`, `payment_type_unsupported`, `installment_amount_differs`,
`payment_split_unknown`, `refund_shape_unverified`, `status_unsupported` and
`date_absent`. Installment, revolving and bonus rows are never recognised, and
a MyJCB row needs its usage and payment amounts to agree. A Vpass row needs the
trusted importer card binding (identity family `vpass-card-binding`): a card
ordinal is not an identity. A mapping whose status is `unresolved` names a
placeholder, not a card, and counts as no account.

These stay reviewed decisions and are never automatic: linking a pending row to
its posted row as one purchase (until then they are separate events),
allocating a refund to a purchase, declaring an old row and a renamed row the
same purchase after an external id change, a card statement against a bank
debit ([card settlements](card-settlements.md)), and "this row is not a
purchase".

### Mapping

| Provider row                                                     | Event                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| Vpass `posted` (web family), MyJCB `confirmed`                   | state `captured`                                      |
| Vpass `unconfirmed` (customized family), MyJCB `unconfirmed`     | state `authorized`                                    |
| Amount below zero (an outflow)                                   | kind `purchase`, one `decrease` leg                   |
| Amount above zero (Vpass sale code 6, a positive web row, MyJCB) | kind `refund`, one `increase` leg, no allocation      |
| Row no longer current                                            | state `unknown`, `provider_status_absent`, **no leg** |

- **Event id**: `purchase_` or `refund_` and the sha256 of the policy and the
  recognition key that first recognised it. A key a live event holds keeps that
  event.
- **Effective time**: the provider usage date as an `Asia/Tokyo` local date,
  never the statement or payment date.
- **Evidence**: `SourceFactRef` objects,
  `{kind:"transaction",id:"transaction:<obs>",revision:"parse_run:<n>"}`.
- **Legs**: exactly one `purchase-recognition` leg on
  `account:<resolved card account>` with the exact magnitude. No cash-movement
  leg (the bank debit is the settlement's), no obligation-change leg and no
  allocation. Only `captured` counts as captured; `authorized` is shown apart
  and never added to it; `unknown` has no leg.
- `reconciliationSignals` derives a balance from `cash-movement` legs only, so
  a recognised purchase on `account:<card>` does not move a derived card
  balance.

### Revisions, retirement and idempotency

The content digest covers kind, state, effective time, basis, legs and keys,
and excludes observation ids, parse-run ids and the policy release, so a
re-fetch that shows the same row is not a revision. Per key the lane writes:

| Action      | When                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `recognize` | No live event holds the key                                                                                                         |
| `revise`    | The content changed: the account mapping, the amount or the date, or a retired row reappeared (`unknown → captured`, same event)    |
| `reanchor`  | Same content, but a parse run the live evidence cites is no longer published (a published replay): the key moves to the current row |
| `retire`    | A live `authorized` or `captured` event none of whose keys is current any more (`staleCardPurchaseKeysSql`)                         |

A different kind for a held key is never a revision; it is counted as a
conflict and left for review. Every revision is one guarded `db.batch`
(`cardPurchaseRecognitionWrites`), and its decision id is a digest of event,
revision, content digest and action. A replay, a stale plan or a concurrent
duplicate writes nothing in any table, and the 0047 trigger lets at most one
live revision hold a key.

A retired event keeps its keys, so no other event can take the row. Typical
retirements: a Vpass month's customized capture replaced by its web capture
(the pending events are retired, the posted rows become separate captured
events); a card ordinal change under one resolved account (old events retired,
new ones captured, the captured total unchanged); a parser change of external
ids (retire and recreate: churn, never a double count). The retire pass runs
before recognition in every tick, and when it fills its page and retires every
event on it, recognition waits a tick (bounded: see [Bounds](#bounds)), so the old
events of a changed key are retired before their replacements are recognised
and the captured total never counts one purchase twice. An event that still
holds one current key is not stale, and an event holding several keys (a
reviewed merge) is left to its reviewed flow and counted as a conflict. A row
that stays current but can no longer be recognised (its binding lost, say)
keeps its last revision: the provider still shows it.

Accepting a [card settlement](card-settlements.md) adds a cash-movement leg and
an unresolved obligation-change leg and never a `purchase-recognition` leg, so
a card charge is counted once as a purchase and its payment once as cash. No
purchase is allocated to a statement.

### Bounds

One tick (every five minutes) retires at most 100 events (`RETIRE_LIMIT`),
reads at most 500 current usage rows after the scan cursor (`SCAN_LIMIT`) and
writes at most 200 events (`WRITE_LIMIT`), each as its own batch. The
operational cursor `card_purchase_scan_cursor` stops at the last row handled
when the write budget runs out, and wraps to 0 after the last page (an exactly
full last page wraps on the next tick, whose page is empty) because a row below
it can become current again. The cursor moves only from the value the tick
read, so a tick that overlapped it never pulls it back. The current-usage query
runs twice per tick (stale keys, then the page).

Recognition waits for the retire pass only while that pass fills its page and
retires every event on it. The wait is bounded: each such tick takes 100 keys
out of the live `authorized` and `captured` set, and nothing refills that set
while recognition, its only writer, waits. So after a key change touching K
recognised rows, recognition runs again within ⌈K / 100⌉ ticks: a
2,000-row parser re-key waits at most 20 ticks (100 minutes), and 10,000 rows
all changing key at once at most 100 ticks (about 8 hours 20 minutes). A page
with any conflict or failed batch never defers, so keys the pass cannot
retire, however many, never hold recognition back. The log line carries
counts only:

```json
{
  "event": "purchase_recognition",
  "scanned": 500,
  "recognized": 0,
  "revised": 0,
  "reanchored": 0,
  "retired": 0,
  "skipped": { "payment_type_unsupported": 12 },
  "conflicts": 0,
  "failed": 0,
  "deferred": false
}
```

`conflicts` counts plans the stored state refused (a stale or replayed batch, a
held key, a refused transition, a multi-key event), `failed` counts batches D1
rejected with an error (nothing of them is written), and `deferred` marks a tick
whose recognition waited because the retire pass retired a whole full page.

### Flag, deploy and rollback

| Flag                           | Where                     | Default | Effect when on                                                                             |
| ------------------------------ | ------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `PURCHASE_RECOGNITION_ENABLED` | `services/processor` vars | `"0"`   | The `purchase_recognition` lane runs right after `reconciliation_sweep` and writes events. |

`"1"` or `"true"` turns it on; any other value leaves the lane unrun and silent.

1. The release applies CORE `0047` before the Workers.
2. Deploy `services/processor` with the flag `"0"`: the lane is skipped and
   logs nothing.
3. Set it to `"true"`: the backfill proceeds at most 200 events per tick.

Rollback: set the flag back to `"0"`. The lane stops and every row it wrote
stays. A wrong recognition is corrected by shipping a fixed policy whose sweep
appends revisions, never by a DELETE. Builds from before this change never
touch the 0047 tables.

### Verified locally (synthetic data only)

- `services/processor`: `test/card-purchase.test.ts`, over the deployed Vpass
  and MyJCB parsers, the publication gate and the identity store on Miniflare
  D1. The flag off runs nothing. A posted Vpass single payment is one captured
  purchase with its rule decision, and a second sweep writes nothing. A
  re-fetch is no revision. A customized month becomes authorized events; its
  web capture retires them (no legs) and captures the posted rows only. MyJCB
  usage equal to payment is captured and the installment slice is skipped. An
  unpublished parse, an unidentified parse and a Vpass identity without the
  binding recognise nothing. A refund is its own event with no allocation. An
  account mapping change supersedes revision 1, which stays readable. A
  published replay re-anchors. The trigger refuses a second live holder and a
  duplicate batch writes nothing. A card ordinal change keeps the captured
  total. An accepted card settlement adds no purchase leg, and purchases have
  no cash leg. The write budget, the cursor wrap and the retire deferral hold;
  an exactly full last page wraps on the next tick, a row that becomes current
  below the cursor is reached after the wrap, and an overlapping tick's cursor
  move is kept. Keys the retire pass cannot retire never defer recognition.
  External ids and namespaces with slashes, plus signs, full-width, escaped and
  control characters give the same key in SQLite and in the writer, so every
  holder is found again. The log line carries counts only.
  `test/lanes.test.ts` pins the lane order.
- `packages/read-model`: `test/card-purchase-keys.test.ts` (stale keys and the
  unrecognised count against current usage; a revision still holding one
  current key is not stale) and `test/events.test.ts` (a purchase-recognition
  leg does not move the derived balance).

## Read side

`packages/read-model/src/events.ts` provides `createEventsReader(sql)`:

- `activity({ basis, offset })` — current event revisions with at least one leg
  on the requested basis, their legs, their live allocations, one total per
  (basis, unit), and `explanationRefs` running event → legs → allocations →
  source facts → raw locators.
- `obligations({ offset })` — principal, live settlements, `settled`,
  `outstanding` (`principal − settled`, exact arithmetic), confirmed and
  projected fee totals kept apart, and the unresolved differences the
  settlements declared. When either side is not exact, `outstanding` is `null`
  with an `outstandingReasonCode`; it is never zero-filled (INV05).
- `reconciliationSignals({ subjectRefs })` — the latest published
  provider-reported balance beside the amount the adopted events'
  `cash-movement` legs imply, and their `difference` with reason codes (`snapshot_boundary_unknown`,
  `events_incomplete`, `timing_difference`, `fees_not_modelled`). It is a
  `difference` observation, never an adjustment entry, and nothing is written to
  make the two agree (root review 09 §4). Only `cash-movement` legs are read:
  until card purchase recognition, legs of every basis were summed together,
  which would have added a recognised purchase's `purchase-recognition` leg on
  `account:<card>` to that account's cash legs (two bases are never summed).

All arithmetic is done in `@kogane/domain` with exact decimals. No sum is
computed by casting a coefficient to a SQLite INTEGER.

### HTTP

`services/app/src/events-api.ts` serves, behind the existing Access
gate and the GET-only boundary:

- `GET /api/v2/activity?basis=cash-movement|purchase-recognition&offset=N`
- `GET /api/v2/obligations?offset=N`

Both return the `Page<T>` envelope (`items`, `nextCursor`, `dataCoverage`) plus
`apiVersion: 2`, and activity also echoes the `basis` it was read on. Values are
`Quantity`-shaped (`unitRef` plus a decimal-v1 value state).

The routes are served only when the `eventsV2` capability is true, which needs
**both** `EVENTS_V2_ENABLED=1` and the `economic_event_revisions` table present
in the store the Worker reads. Otherwise the paths 404 like any unknown route
and `/api/meta` reports `eventsV2: false`. `eventsV2` was added to
`ApiCapabilities`; both stored capability constants default it to `false` and
the server replaces it with what it can actually serve.

`services/app/src/card-purchases-api.ts` serves one more read, to an operator
only:

- `GET /api/v2/card-purchases?offset=N&period=YYYY-MM`, or
  `?eventId=<purchase_…|refund_…>` alone for one event.

It explains recognised card purchases
(`packages/application/src/query/card-purchases.ts`): per event, its state and
amount (an `unknown` event has none, and shows its last known amount beside
it), the provider rows behind it and whether the provider still displays them,
the statement it was posted to, the settlement review of that statement with
the bank debit it cites, the newest 20 revisions and `explanationRefs`. A
statement that cannot be shown is a reason, never a zero: `not_posted`,
`statement_not_collected` or `period_unrecognized`. The link from purchase to
statement is derived at read time from (resolved account, source, statement
period); no allocation is read or written for it
([card settlement review](card-settlements.md#purchase-explanation-chain)).

`summary` covers every live event the filter selects, not only the page:
captured, authorized, captured refunds and authorized refunds per unit, with
no combined field, and a count of unresolved events. A filter of more than
10,000 live events is refused with `413 result_limit_exceeded`, the reader's
answer for a set too large to return complete ([read model](read-model.md)),
rather than partly summed; a statement period narrows it. The provider
statement totals are listed beside the figures and are never subtracted from
or compared with them, and `settlementAddsPurchaseExpense` is `false`.
`coverage` says the list is not a complete transaction history, names the
excluded shapes, and counts the current provider rows no live event holds,
across every statement month whatever the filter. All figures are exact
decimals added in `@kogane/domain`.

Cost per request: one selection of the filter's live events that carries only
what the figures, the order and the statement links read (a few hundred bytes
per event; evidence, facts and history are read for the page's 50 events
only), one statement query and one settlement query over the (account,
source, period) keys of those events, and one pass of the shared current card
usage query (`packages/read-model/src/card-usage.ts`) for the `current` flags
and the unrecognised count. That pass reads every current Vpass/MyJCB capture
and dominates the cost: on a synthetic store of about 34,000 usage
observations (180 days of daily captures) and 8,200 live events, the
unfiltered first page took about 0.4 s in `bun:sqlite`, of which the usage
pass was about 0.3 s and the selection about 0.04 s.

The route needs a human principal with `interpretation.accept` (the card
settlement review's guard), is GET-only, and answers 404 unless
`EVENTS_V2_ENABLED` is on **and** the 0047 table and views exist. `/api/meta`
advertises the same fact as `cardPurchaseRecognition`, which both stored
capability constants default to `false`. It writes nothing.

## Flags

| Flag                     | Where                     | Default | Effect when on                                                        |
| ------------------------ | ------------------------- | ------- | --------------------------------------------------------------------- |
| `RECONCILIATION_ENABLED` | `services/processor` vars | `"0"`   | The scheduled `reconciliation_sweep` lane runs and writes candidates. |
| `EVENTS_V2_ENABLED`      | `services/app` vars       | `"0"`   | `/api/v2/*` is served if the projection exists.                       |

With both off, the scheduled worker logs no new event, writes nothing, and the
browser serves no new route.

## Deploy order and rollback

1. Apply migration `0032_economic_events.sql` (schema; additive, writes no rows).
2. Deploy `services/processor` with `RECONCILIATION_ENABLED="0"`;
   turn it on when the candidates should start being produced.
3. Deploy `services/app` with `EVENTS_V2_ENABLED="0"`; turn it on
   to expose the read routes.

Rollback: set the flags back to `"0"`. The lane stops and the routes disappear;
the tables stay. A build that predates this change never reads or writes the new
tables, so it rolls back cleanly with the schema in place. Rows are never
deleted to undo a decision — a new revision is appended instead.

## Bounds

One sweep reads at most 1,000 published rows per slice, pairs inside groups of
at most 200 facts (larger groups are counted and skipped), and writes at most
500 proposals. Its log line carries counts only: no amount, account label or
provider text. One API page is 200 rows.

## Verified locally (synthetic data only)

Every fixture publishes its successful parse runs through the projection the way
the writer does, because an unadopted `ok` run is current for no reader since
migration 0026.

- `packages/domain`: `test/events.test.ts` (SC02 net 97,000 and purchase cost
  3,000 with five observations; SC03 1,234 captured, 834 net, unknown-parent
  refund unallocated, over-refund exception, vanished pending inferring nothing;
  SC04 8,000 remaining with fee 100 confirmed against 200 planned; SC05
  cross-unit legs never zero-forced, effective rate 95, explicit fee 5 AUD,
  2,000 JPY reference difference as an estimate, unconfirmed arrival not a
  credited transfer; SC10 10,000 / 300 / 9,700 with payout and bank credit as
  two evidences of one settlement; conservation, fills and state machines) and
  `test/reconcile.test.ts` (stage A/B/C, UC23 candidate-only, ambiguity,
  namespace scoping, the auto-acceptance invariant).
- `packages/read-model`: `test/events.test.ts` (both bases, explanation chain to
  the raw locator, outstanding 8,000 from settlements, non-exact principal left
  unknown, provider-against-derived difference with reasons, a wrong merge
  undone by a new revision with the old revision retained, double allocation
  rejected, append-only triggers).
- `services/processor`: `test/reconciliation.test.ts` (the Vpass
  slice, idempotent re-runs, unpublished parses producing nothing, two
  same-amount candidates never merged, acceptance and rejection through the
  decision log with resend and conflicts, the provider-link auto-acceptance path
  on a synthetic source, the scheduled lane off by default, and migration 0032
  on 0017–0035 with seeded rows including its closed enums and append-only
  triggers).
- `services/app`: `test/events-api.test.ts` (capability gate, Access
  gate, GET-only, both routes, query validation) plus the pre-existing suites.

Not verified: production data, and the behaviour of concurrent acceptances from
several Workers (the operation ledger and the proposal-resolution trigger are the
arbiter; see the tests).

## Statement settlement review

[Card statement settlement review](card-settlements.md) implements the first
operator-approved Vpass/MyJCB-to-SMBC payment correspondence. Its append-only
candidate decisions pin published source revisions, ownership evidence and
exclusive payment allocation, with an approved withdrawal path. Acceptance
records the observed cash effect and keeps principal/fee decomposition unknown;
a statement total is not turned into an invented obligation principal.

The confirmation flow uses `card-settlement.accept`, `card-settlement.reject`
and `card-settlement.withdraw`. The last withdraws a judgement, not funds.
All effects, receipt reservation and approval consumption share one guarded
batch. Original source observations and historical decisions are preserved.
