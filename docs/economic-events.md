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

The implemented Vpass and MyJCB pending/posted slices below are the starting
point for phases 6–7, not completion of reconciliation or event generation. The
[next product milestone](roadmap.md#phases-67--reconciliation-and-economic-event-generation)
builds on them with card statements and bank debits, review/correction and an
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
| Pairing a recognised pending event with posted events     | The purchase lane's candidate pass: proposals only        |
| Merging a pending and a posted event into one purchase    | A reviewed `relation.accept` (change lifecycle)           |
| Merging a pair the provider itself linked                 | The purchase lane, **still** as recorded `rule` decisions |
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

A reviewed or provider-linked [pending-to-posted link](#pending-to-posted-links)
writes the `merge` and `split` actions through the same guards; 0047 needed no
change for them.

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
uses, from Vpass `statementMonth` and from MyJCB's `YYYY年M月お支払い分` label,
or, for the collector's relative `detailMonth-N` fallback, from the label and
the capture time of the ledger artifact that carries it
(`cardStatementPeriod`, rule `relative-statement-period-v1`,
[docs/observations.md](observations.md#relative-period-labels-are-resolved-from-the-capture-time)):
`detailMonth-0` is the payment month of the cycle the capture day's usage is
billed to, `detailMonth-1` the month before it, both payment months as the
statement parser derives them from the payment date. Any other label
(`detailMonth-2` and beyond, which the evidence does not place) is stored as
`NULL`, never guessed, and the stored label is never rewritten. The period is
not content: a sidecar period derived differently from the same row (a
recognition stored with `NULL` before the rule existed) is recorded as a
`revise` of its own, and the earlier revision keeps its period
(`nextCardPurchaseAction`). The reconciliation job's MyJCB installment guard,
`comparableCardPayment`, reads the same texts through the same rule
(`myjcbAgreedAmount`): a confirmed row takes part in pending-to-posted
matching only when its usage and payment agree and are positive, so an
installment slice is never compared with a purchase. The job also admits a
confirmed row only under a payment month read or resolved the same way, so a
row recognition stores as `NULL` never pairs rows there either.

### Where the decisions live

Judgements are recorded in `decision_revisions` (migration 0029). Its
`subject_kind` CHECK admits only `account_mapping`, `instrument_mapping` and
`relation`, and 0029 cannot be edited, so every A10 judgement uses
`subject_kind='relation'` with a prefixed `subject_ref`: `proposal:`, `event:`,
`obligation:`, `allocation:` or `settlement:`. The prefixes keep those subject
namespaces disjoint from the `entity_relations` ids, which use the bare form.
A proposal is resolved only together with a `proposal:<id>` decision: the
0032 update trigger refuses a `(status, decision_revision_id)` whose decision
is about another subject. The [pending-to-posted review](#pending-to-posted-links)
therefore appends that decision and resolves the proposal in the same batch.

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
  equality inside one identifier namespace, and **only for identifiers the
  provider issued** (`identifierOrigin: "provider"` on both sides, which the
  job reads from the parser's `_kogane.identityOrigin`); such a pair is
  auto-acceptable. A collector fingerprint, or an origin nobody recorded,
  pairs nothing: SBI Shinsei's `txnReferenceNo` and PayPay's
  `transactionNumber` are provider row ids, but their parsers record no
  origin and neither source is in a slice, so they pair nothing yet either. Vpass and MyJCB derive every external id from the row's
  content and occurrence, so each daily capture of a displayed row carries the
  same fingerprint: stage A over them was one more `provider_same` candidate
  per pair of captures, never auto-acceptable, and nothing for a reviewer to
  decide (no surface lists or reviews one), because which capture a reader
  sees is already decided by snapshot currentness
  ([publication gate](publication-gate.md)), not by a relation. The
  `provider_same` rows written before this rule (about 26,000 in production,
  all `proposed`, carrying `collector_fingerprint_identifier`) stay as they
  are: proposals are append-only and nothing resolves or deletes them. The
  candidate reads select stage B proposals by the `(kind, stage)` index of
  CORE `0048`, so those rows are never read by them.
- **Stage B — a revision or a second display inside one provider.** Pending
  against posted. Amount and date closeness alone yields a candidate, never an
  acceptance: two purchases of the same amount on the same day must not be
  collapsed (UC13, UC23, SC03). Without a provider link id a pair is a
  candidate only **inside the matching window**: the posted row's day is the
  pending row's day or at most `DEFAULT_MATCH_OPTIONS.dayWindow` (5) days
  after it (`postedInWindow`). A posted charge always follows its
  authorisation, and both Vpass displays and both MyJCB ledgers date a row by
  the provider's usage day, not by the day it posted, so the posting lag of up
  to about 60 days does not show between the two days; a later merchant sales
  day can, by a few days. A posted row dated before its pending row or past
  the window, or a row without a provider day, is not proposed at all, and a
  shared statement period alone never pairs two rows: before this rule every
  pending row of a month was paired with every posted row of it (40 pending ×
  60 posted rows made 2,400 candidates, nearly all ambiguous). Inside the
  window the amounts need not agree, because a posted amount can differ from
  its authorisation (a foreign-currency charge converted at posting, a fuel or
  hotel hold): `amount_equal` stays a rationale and `amount_differs` a
  rejection condition for the reviewer, and equal-amount pairs come first. More
  than one heuristic candidate for one pending row, or for one posted row (two
  same-amount purchases on one day, one of them posted so far), marks all of
  them `multiple_candidates` / `candidate_not_unique`. A pair the provider itself
  linked is proposed whatever its days. The window only removes pairs:
  `proposalIdentity` (kind, stage, method, policy release, targets) is
  unchanged, so every pair still proposed keeps its stored digest and a
  decided pair is never proposed again (pinned in `test/reconcile.test.ts`).
- **Stage C — a correspondence across sources.** Equal opposite amounts on
  nearby days never establish ownership; without an established owner on both
  sides the candidate carries `owner_not_established`, and cross-source
  correspondences are reviewed at this stage whatever else agrees.

`RECONCILIATION_KINDS` is a strict subset of the `entity_relations` kinds of
0029, so an accepted proposal can always be written as a relation without
widening that closed list. Settlement is not one of them: it is a first-class
`settlement_relations` row with its own allocated amount, not a bare edge.

## The vertical slice that runs

`services/processor/src/reconciliation-job.ts` runs stage A and stage B over
the two entries of `RECONCILIATION_SLICES`, each **pending against posted
inside one provider's own displays**:

- **The Vpass statement page.** That parser emits two provider displays of the
  same card and statement month — the `customized` family with provider status
  `unconfirmed` (a pending authorisation) and the `web` family with `posted` —
  under one `vpass:<card>` source account.
- **The MyJCB credit ledger.** The `unconfirmed` and `confirmed` ledgers of one
  connection and payment month, under one `myjcb:<connection>:root` source
  account. A confirmed row's amount can be one installment slice, so it takes
  part only when its usage and payment texts (`1,200円`) agree and are positive
  (`comparableCardPayment`, read with the rule card purchase recognition uses);
  an installment slice is never compared with a purchase. Rows are grouped
  by payment month: an absolute label (`2026年10月お支払い分`), or the
  collector's relative fallback `detailMonth-N` resolved from the capture time
  of the row's own artifact (`statementPeriodOf`, the rule recognition uses).
  The raw label is never a group: it is a position in the provider's list on
  the capture day and names a different payment month as months pass, so rows
  grouped under it would claim `same_statement_period` falsely. A pending
  `detailMonth-0` row therefore pairs with the `detailMonth-1` confirmed row
  the next cycle moves it to when both resolve to one month (and the posted
  day is inside the [matching window](#matching-stages)), and the same label
  captured in another cycle groups apart. That needs the collector to
  record `detailMonth=1` as confirmed; on the surveyed connection it records
  it as `unconfirmed` (no export link,
  [observations](observations.md#relative-period-labels-are-resolved-from-the-capture-time)),
  so its rows are pending rows there. A confirmed row whose month
  neither the label nor the rule places (`detailMonth-2` and beyond) stays out
  of this job; the recognition lane's candidate pass, which groups MyJCB by
  usage month, still pairs it.

Both sources' external ids are collector fingerprints, so stage A proposes
nothing for either; it runs for the day a slice carries provider row ids.

These are the only pairs in the deployed parser set where both sides of a
pending/posted revision exist in one identifier namespace, so no cross-source
ownership has to be established first.

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
`entity_relations` row, and resolves the proposal. The relation's ends are the
targets' own `SourceFactRef` ids, `transaction:<id>`, which already carry
their kind, never prefixed a second time; a proposal cites its rows the same
way in `evidence_refs_json`. There is no public write route to this command: the reviewed path is the
change lifecycle's `relation.accept` with a proposal marker
([pending-to-posted links](#pending-to-posted-links)).

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
its posted row as one purchase (until then they are separate events; see
[pending-to-posted links](#pending-to-posted-links), where only a pair the
provider itself linked is merged by the rule), allocating a refund to a
purchase, declaring an old row and a renamed row the same purchase after an
external id change, a card statement against a bank debit
([card settlements](card-settlements.md)), and "this row is not a purchase".

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
| `merge`     | A pending-to-posted link accepted by review, or linked by the provider ([below](#pending-to-posted-links))                          |
| `split`     | An accepted link withdrawn: the posted event's restored revision ([below](#pending-to-posted-links))                                |

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
holds one current key is not stale. A merged event (one posted key and its
pending key) is treated like any other: it is revised from its posted row when
that row's content changes, keeping its pending key; its pending row adds
nothing to it; and it is retired, keeping both keys, once none of its rows is
current. A row that stays current but can no longer be recognised (its binding
lost, say) keeps its last revision: the provider still shows it.

Accepting a [card settlement](card-settlements.md) adds a cash-movement leg and
an unresolved obligation-change leg and never a `purchase-recognition` leg, so
a card charge is counted once as a purchase and its payment once as cash. No
purchase is allocated to a statement.

### Pending-to-posted links

A pending authorisation and the posted charge it became are recognised as two
events, each holding its own key: an `authorized` event (retired to `unknown`
once a Vpass month's posted capture replaces its pending one) and a `captured`
event. Only a recorded decision makes them one purchase: amount and date
closeness never does (INV07), and two posted rows of one amount on one day are
two candidates, never a merge (SC03).

**Candidates.** After the recognition pass, the lane pairs the recognised
events of every group its page touched with `stageBProposals`. A Vpass group
is the resolved account, the source and the statement period, or, when the
sidecar has no recognised period, the usage month. A MyJCB group is always
the resolved account, the source and the usage month: a pending row's
relative label resolves to a payment month from its capture time, but the
confirmed row of the same purchase can sit at a later position the rule does
not place (`detailMonth-2` and beyond), so grouping by period would keep the
two apart. The usage date is the one key both displays of a purchase share.
Stage B then admits a pair only when the posted usage day falls inside the
[matching window](#matching-stages) after the pending one, whatever the
periods (`same_statement_period` is a rationale, claimed only when both sides
have the same one); the amount is a rationale code, never a filter. A pending
and posted row whose usage days straddle a month end are in two MyJCB groups
and are not paired by this pass. Within a
group it pairs each single-key pending-origin event (`authorized`, or
`unknown` after it left the display) against each single-key `captured`
posted event of the same card account namespace and kind, never a purchase
against a refund. Each candidate is a `reconciliation_proposals` row keyed by
the matcher's own `proposalIdentity` digest, so a pair is proposed once
whichever lane saw it first: kind `pending_to_posted`, stage `B`, method
`rule`, policy release `reconciliation-rules-v1`, targets `[pending, posted]`
as `transaction:<id>` pinned to `parse_run:<id>`, inserted only
`WHERE NOT EXISTS` a row with that digest (the 0032 no-replace trigger would
abort a second insert of an id). A pair already stored, proposed or decided, is
never written again and never takes the write budget, and the ambiguity codes
(`multiple_candidates`, `candidate_not_unique`) are kept. The recognition cursor cycles through every
current row, so a pair is reached however many rows a source has, as the
reconciliation lane's own [scan cursor](#bounds-1) reaches it over every
published row. The amount
and counterparty are read from the rows to compare and never stored.

**Merge.** A reviewed `relation.accept` of the candidate
([change lifecycle](change-lifecycle.md#pending-to-posted-link-review)), or,
for a pair whose rows carry the same provider link id (`autoAcceptable`), the
lane itself as `rule` decisions under `rule:card-purchase-recognition-v1`,
writes one guarded batch:

- the survivor is the **pending-origin event**: its revision n+1 (action
  `merge`) is `captured`, with the posted row's content, facts, usage date and
  single `purchase-recognition` leg, and holds the posted key and the pending
  key. Its evidence cites the posted row first, then the pending one. Its
  history reads `authorized → captured` (or `authorized → unknown → captured`),
  each step checked with `eventTransition`;
- the posted event's live revision m gets `superseded_by = '<survivor>@n+1'`,
  a cross-id supersession 0032 allows, so the posted key is free when the
  survivor claims it; the survivor's revision n is superseded as usual;
- the batch order is survivor n+1 → leg → supersede n and m → sidecar → keys.
  Statement 1 (the survivor's decision) carries every guard: both events still
  at the planned live revisions, holding exactly the keys being merged, which
  no other live event holds. Every later statement is `WHERE EXISTS(decision)
AND NOT EXISTS(own row)`, so a replay or a stale batch writes nothing.

The captured total is unchanged: the posted leg moves, it is not added, and
the authorisation is no longer held apart. The merged event's statement is the
posted row's (its sidecar is the posted row's), so it links to its statement
and settlement unchanged.

The rule never overrides a reviewer: it leaves a provider-linked pair to
review once any decision other than a rule's is recorded about either event
(a reviewed merge, or the split of a withdrawal), checked before the merge and
again inside its batch. Otherwise a withdrawn link would be merged again as
soon as either row is re-anchored, because the re-anchored pair is a new
proposal that the provider link makes `autoAcceptable`.

**Split.** Withdrawing an accepted link (`relation.reject` of an accepted
triple) retires the merged event first, holding its pending key alone, in
state `unknown` with `conflicting_evidence` and the pending row's own facts
and date: the reviewer said the authorisation is not this charge, and nothing
says what it became. Then the posted event gets revision m+1 (action `split`)
holding its posted key again, with the merged revision's posted content and
leg. It is restored rather than recognised anew: its id already has
revisions, so a first recognition could never be written for it, and the lane
would find its key held by nobody forever. A merged event already retired
splits into two retired events. The captured total is unchanged again, and
every earlier revision stays readable.

A withdrawn link is closed for good, a known limit: 0032 resolves a proposal
once, so the proposal row stays `accepted` (the withdrawal supersedes the
decision that accepted it), the triple's latest relation is `rejected`, and
the candidate offers no action again. The same two rows can only be linked
again through a new proposal, which the candidate pass writes when either
row's event is re-anchored or revised onto a new observation.

What stays proposal-only: every candidate without a provider link id, which
is every one the deployed parsers produce today (no source supplies a
pending-to-posted link id; see [above](#which-sources-supply-a-provider-link-id)).

### Bounds

One tick (every five minutes) retires at most 100 events (`RETIRE_LIMIT`),
reads at most 500 current usage rows after the scan cursor (`SCAN_LIMIT`) and
writes at most 200 events (`WRITE_LIMIT`), each as its own batch. The
operational cursor `card_purchase_scan_cursor` stops at the last row handled
when the write budget runs out, and wraps to 0 after the last page (an exactly
full last page wraps on the next tick, whose page is empty) because a row below
it can become current again. The cursor moves only from the value the tick
read, so a tick that overlapped it never pulls it back. The current-usage query
runs twice per tick (stale keys, then the page): about 0.5 s and 0.4 s on the
scaled store of [the read model's cost measurement](read-model.md#cost), since
both start from the current captures rather than the whole store and the stale
read looks up the revisions holding a current key once, not per live key.
Nothing in the tick is skipped when no evidence changed: every tick that writes
moves the CORE source revision itself (its decision revisions), and the cursor
still has to page through the current rows.

The candidate pass then reads the recognised events of the groups the page
touched, at most 2,000 in all (`CANDIDATE_READ_LIMIT`; a
larger read skips every group that tick) and at most 200 per group
(`CANDIDATE_GROUP_LIMIT`; a larger group is skipped and counted), writes at
most 100 new proposals in one batch (`CANDIDATE_WRITE_LIMIT`; a pair already
stored never takes that budget), and merges at most 20 provider-linked pairs
(`LINK_MERGE_LIMIT`), each its own batch. Stage B pairs a pending event only
with the posted events inside its matching window, but a group whose 200 events
all fall inside one window is still up to 10,000 pairs: the stored ones are
looked up 1,000 digests at a time
(`CANDIDATE_LOOKUP_CHUNK`, about 67 KB of bound JSON, far below D1's 2 MB value
limit) and only until the write budget is full. A tick therefore issues at most
about 320 guarded batches, and a deferred tick pairs nothing: the candidate
pass follows the page.

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
  "deferred": false,
  "proposed": 3,
  "merged": 0,
  "groupsSkipped": 0
}
```

`conflicts` counts plans the stored state refused (a stale or replayed batch, a
held key, a refused transition such as a different kind for a held key),
`failed` counts batches D1 rejected with an error (nothing of them is written),
`deferred` marks a tick whose recognition waited because the retire pass
retired a whole full page, `proposed` counts new pending-to-posted candidates,
`merged` provider-linked pairs merged as rule decisions, and `groupsSkipped`
the candidate groups too large to pair that tick.

The same counts, field for field, are recorded for every tick in
`processor_lane_ticks` (migration 0049) with the tick's start and end and its
outcome — `ran`, `skipped-by-flag` while the flag is off, or `failed` with a
safe code — for one day. `laneTicks` in the Processor's `/status` and
`/internal/health` shows the latest one, so whether the lane ran no longer has
to be read from Workers Logs ([operations.md](operations.md#lane-tick-records)).

### Flag, deploy and rollback

| Flag                           | Where                     | Default | Effect when on                                                                              |
| ------------------------------ | ------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `PURCHASE_RECOGNITION_ENABLED` | `services/processor` vars | `"0"`   | The `purchase_recognition` lane runs right after `card_settlement_sweep` and writes events. |

`"1"` or `"true"` turns it on; any other value leaves the lane unrun and silent
in the log; its only write is then the `skipped-by-flag` tick record above.

1. The release applies CORE `0047` before the Workers.
2. Deploy `services/processor` with the flag `"0"`: the lane is skipped and
   logs nothing.
3. Set it to `"true"` (done on 2026-09-24): the backfill proceeds within the
   [bounds](#bounds), at most 100 events retired and at most 200 recognition
   writes per tick, so at most 300 event mutations.

Rollback: set the flag back to `"0"`. The lane stops and every row it wrote
stays. A wrong recognition is corrected by shipping a fixed policy whose sweep
appends revisions, never by a DELETE. Builds from before this change never
touch the 0047 tables.

Resolving relative labels (`relative-statement-period-v1`) needs no migration
and no re-parse. A live MyJCB recognition stored with a `NULL` period while its
current row carries `detailMonth-0` or `detailMonth-1` gets one `revise`
revision with the resolved period the next time the recognition pass reaches
its row (the cursor cycles through every current row, within the write
bound); its content digest is unchanged, and revision 1 keeps its `NULL`. An
event already retired keeps the period it had.

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
- `services/processor`: `test/card-purchase-merge.test.ts`, on the same world
  (`test/card-purchase-world.ts`). The candidate pass writes each stage-B pair
  of recognised events once, cites rows canonically and stays within its
  budget, with stored pairs never taking it; two posted rows of one amount are
  two candidates and never merge; MyJCB pending and confirmed rows labelled
  only `detailMonth-N` meet by usage month, giving exactly one proposal for the
  matching pair and two `multiple_candidates` proposals for twins; a pair with
  a provider link id is accepted
  and merged as rule decisions (`authorized → unknown → captured`, the posted
  event superseded across ids, the captured total unchanged); a merged event
  is revised on an account correction, retired holding both keys when its
  posted row is gone and captured again when it reappears; a reviewed accept
  through the lifecycle on D1 merges, the lane then leaves the merged event
  alone, and a withdrawal splits it without a new proposal. The reconciliation
  lane and the purchase lane propose one Vpass pair and one MyJCB pair (an
  absolute payment month) once, under the same `rp_<digest>`, whichever runs
  first; a provider-linked pair the reconciliation lane accepted is merged
  once, with no second acceptance; the rule does not merge again a pair a
  reviewer split, even after a re-anchor makes it a new provider-linked
  proposal; and the stored pairs are looked up a bounded chunk at a time.
  `test/reconciliation.test.ts` checks the canonical relation ends and
  proposal evidence.
- `packages/storage-d1`: `test/card-purchase-links.test.ts` (merge and split
  batches on the full CORE: order, cross-id supersession, replay and stale
  batches writing nothing, a key held elsewhere, the one-live-holder trigger
  refusing a merge without its pointer, a split restoring both holders and a
  merge again after it, a merged event already retired splitting into two
  retired events, and the `proposal:` and `card-purchase:` revision
  subjects).
- `packages/domain`: `test/pending-posted-review.test.ts` (merge and split
  drafts, transitions, `conflicting_evidence`, the linked revision, what a
  review may do, the marker and canonical ends) and `test/reconcile.test.ts`
  (the stored digest of a known pair pinned, unchanged by the evidence no
  longer double-prefixing its refs).
- `packages/application`: `test/pending-posted-plan.test.ts` (plan, simulate,
  approve and commit of an accept, a reject and a withdrawal; pins; stale
  event revisions and proposals decided elsewhere writing nothing; agents
  refused; resends replaying the receipt; concurrent commit batches of one
  plan writing the review once, a resend of the operation and another
  operation both writing nothing; a bare `pending_to_posted` plan stored
  before the review existed refused at commit; every event of a page listing
  its own candidates next to a busy one) and
  `packages/observation-shared/test/card-purchase-candidates.test.ts` (the
  `candidates` wire shape, and the agent's shape without `actions` and
  `relation`).
- The agent read of the same page: `packages/application`
  `test/purchases-explain.test.ts` (the query's page with exactly the review
  affordances removed, the grant, scope and bound refusals reading nothing, no
  path writing) and `services/app` `test/purchases-explain.test.ts` (the same
  page over HTTP and MCP, the authorization order, absent while the capability
  is, every table and the source revision unchanged).
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

Each event also lists its `candidates` (at most 10, newest first): the
[pending-to-posted](#pending-to-posted-links) proposals that name one of its
provider rows, matched through the rows' recognition keys, with `proposal:<id>`
added to its `explanationRefs`. Proposals are selected per key (10 each), so a
busy month's pairs never crowd another event of the page out; among proposals
written in the same tick (a whole group's pairs usually are), the pair with a
provider link id, then with a date within the window, an equal amount and an
equal counterparty comes first, so the likely pair is not hidden behind
similar rows. A candidate carries the proposal's status and
decision count, the relation triple's latest status and row count, the rows'
own amounts and dates with the live event each is held by (and its revision),
the rationale and rejection codes, the review `actions` it allows now
(`accept`, `reject`, `withdraw`) with the `blockers` that prevent the others,
and the exact `relation` payload a review plans
(`packages/domain/src/pending-posted-review.ts` `pendingPostedReview` is the one
definition the page and the plan share).

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
pass was about 0.3 s and the selection about 0.04 s. The candidates add two
queries: one pass over the stage-B `pending_to_posted` proposals, re-deriving
each target's recognition key by primary-key lookups
(`packages/application/src/query/card-purchase-candidates.ts`), and one lookup
of the page's relation triples.

The route needs a human principal with `interpretation.accept` (the card
settlement review's guard), is GET-only, and answers 404 unless
`EVENTS_V2_ENABLED` is on **and** the 0047 table and views exist. `/api/meta`
advertises the same fact as `cardPurchaseRecognition`, which both stored
capability constants default to `false`. It writes nothing.

An agent reads the same page through the agent API instead:
`POST /api/agent/v1/purchases.explain`, or the MCP tool
`kogane.purchases.explain`, with `{period?, eventId?, offset?}`
([agent API](agent-api.md#card-purchase-explanation)). It is served exactly
while `cardPurchaseRecognition` is, calls the same `queryCardPurchases`, and
returns its page as `data`, figures, coverage, chain and `explanationRefs`
unchanged, with each candidate's `actions` and `relation` removed: an agent
sees which links are proposed and why, and every review stays with the
operator. It needs an `AGENT_API_GRANTS` grant with `records.read` over
`"*"` sources and accounts (the page cannot yet be recomputed inside a
narrower scope, so a listed grant is refused rather than answered), the
10,000-event bound is `413 budget_exceeded` there, and it writes nothing
either.

## Flags

| Flag                     | Where                     | Default | Effect when on                                                        |
| ------------------------ | ------------------------- | ------- | --------------------------------------------------------------------- |
| `RECONCILIATION_ENABLED` | `services/processor` vars | `"0"`   | The scheduled `reconciliation_sweep` lane runs and writes candidates. |
| `EVENTS_V2_ENABLED`      | `services/app` vars       | `"0"`   | `/api/v2/*` is served if the projection exists.                       |

With both off, the scheduled worker logs no new event, writes nothing but the
`skipped-by-flag` tick records of `reconciliation_sweep` and
`card_settlement_sweep` (`processor_lane_ticks`, one day kept;
[processor.md §6.1](processor.md#61-tick-records)), and the browser serves no
new route.

## Deploy order and rollback

1. Apply migration `0032_economic_events.sql` (schema; additive, writes no rows)
   and `0048_reconciliation_scan_cursor.sql` (the sweep's scan cursor and the
   `(kind, stage)` proposal index; additive, writes no rows).
2. Deploy `services/processor` with `RECONCILIATION_ENABLED="0"`;
   turn it on when the candidates should start being produced.
3. Deploy `services/app` with `EVENTS_V2_ENABLED="0"`; turn it on
   to expose the read routes.

Rollback: set the flags back to `"0"`. The lane stops and the routes disappear;
the tables stay. A build that predates this change never reads or writes the new
tables, so it rolls back cleanly with the schema in place. Rows are never
deleted to undo a decision — a new revision is appended instead.

## Bounds

The sweep pages through each slice with a scan cursor, one row per slice in
`reconciliation_scan_cursor` (CORE `0048`, operational progress and not
evidence), so every published row is visited however large a slice grows.
Before the cursor it re-read the same first 1,000 rows of each slice (by source
account, then observation id) every tick, and rows past them were never paired.
Per slice, one tick:

1. reads at most 1,000 published rows after the cursor, by observation id
   (`SCAN_LIMIT`);
2. counts the published rows of every group (source account, statement
   period; for MyJCB the payment month its label resolves to) those rows
   belong to, in one pass that also names the rows of each
   group of at most 200 rows; skips a larger group (`GROUP_LIMIT`, counted in
   `groupsSkipped`), and reads the others whole by row id, at most 2,000 rows
   in all (`GROUP_READ_LIMIT`; the page's first group to pair is always read,
   so a deferred group never keeps the cursor where it is), so a pair is found
   whichever pages its two rows fall on. A group that does not fit waits for the next tick
   (`groupsDeferred`) and the cursor stops before its first row;
3. runs stage A and stage B over each group read, looks the candidates'
   digests up 1,000 at a time (`LOOKUP_CHUNK`, about 67 KB of bound JSON) and
   writes only the proposals not stored yet, in batches of 100
   (`WRITE_BATCH`), at most 500 new proposals per tick over every slice
   (`WRITE_LIMIT`). A stored proposal, open or decided, is never sent again and
   takes no write budget; before, every sweep re-sent an insert for every
   candidate it computed;
4. moves the cursor past the page, and back to 0 after the last page (an
   exactly full last page wraps on the next tick, whose page is empty). While
   new proposals of the page are left for the write budget the cursor stays on
   the page, and the next tick writes the rest. The update is conditional on
   the value this tick read, so an overlapping tick never pulls it back.

A batch D1 rejects writes nothing and is counted in `failed`. While the page
is held, the next tick sends its pairs again; a tick in which D1 rejected every
batch it sent does not hold the page, so a rejection that repeats cannot keep
the slice on one page, and those pairs are retried on the next cycle, as are
the rejected pairs of a page the cursor has left. The log line carries counts only, no amount,
account label, provider text or row id:

```json
{
  "event": "reconciliation_sweep",
  "slices": 2,
  "scanned": 1000,
  "groups": 4,
  "groupsSkipped": 0,
  "groupsDeferred": 0,
  "proposed": 12,
  "known": 11,
  "written": 1,
  "failed": 0,
  "autoAccepted": 0
}
```

`proposed` counts the candidates the matcher produced for the groups read,
`known` those already stored. One API page is 200 rows.

Cost, on the scaled store of [the read model's measurement](read-model.md#cost)
(268,575 observations, 220,309 published Vpass pending and posted rows after
180 daily captures; `bun:sqlite`, no table statistics): one tick of both
slices took 1.5–3.2 s, about 0.5 s choosing the pages (the ids first, then
only the page's rows with their JSON columns: 0.3 s against 2 s for Vpass)
and 1–1.8 s finding the members of the groups the pages touched, which reads
each published row's statement period once. The first-1,000-rows read it
replaces took about 1 s and paired only those rows. What still grows with
history is that pass: the lane reads every published capture, not only the
current ones, so a Vpass statement month captured daily holds thousands of
rows there and is counted in `groupsSkipped` rather than paired, as it was
skipped or read in part before. On the smaller store the CI scale test builds
(2,070 published Vpass rows after 21 daily captures, near production's
3,300) a tick's reads take tens of milliseconds, and several of its Vpass
months already hold more than 200 rows.

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
  namespace scoping, the auto-acceptance invariant, collector fingerprints
  pairing nothing, the stage B window with UC13/SC03/UC23 cases, and the
  proposal identity pinned for the pairs still proposed).
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
  triggers; MyJCB ledgers seeded through the deployed parser: a `1,200円` pair,
  an installment slice never compared, same-amount twins, re-runs and a decided
  proposal writing nothing, a `detailMonth-0` row pairing with the
  `detailMonth-1` row its months resolve to, the same label in another cycle
  and an unplaced `detailMonth-2` row pairing nothing, and a re-captured
  confirmed row kept out of stage A; two captures of the synthetic Vpass
  fixture parsed by the deployed 1.2.0 parser writing no stage A proposal and
  a synthetic provider row id still paired; a slice of several pages visited
  in full and wrapped, an overlapping tick never pulling the cursor back, a
  deferred group, the write budget holding the cursor on its page and a tick
  whose every batch D1 rejected not holding it, the digest lookup's chunk
  boundary, a stored proposal sending no statement and a decided one never
  proposed again, and only the in-window posted row proposed),
  `test/card-purchase-relative-period.test.ts` (a `detailMonth-1` row's stored
  period is its statement's from the same capture and the explanation links
  them; `detailMonth-0` stores its resolved month and `detailMonth-2` stays
  `period_unrecognized`; a recognition stored without a period is revised with
  the resolved one, append-only; a pending row pairs with its posted row by
  usage month and claims one statement only when both resolve to it) and
  `test/card-purchase-parser-shapes.test.ts` (recognition and the matching
  guard never disagree on a parsed MyJCB row).
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
