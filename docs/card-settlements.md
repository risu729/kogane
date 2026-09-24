# Card statement settlement review

This slice connects an authoritative Vpass or MyJCB statement payment total to
an observed SMBC bank debit. It records a reviewable correspondence and its
correction history. It does not reconstruct all purchases, infer loan principal
from a statement, or calculate net assets.

## Source evidence

- Vpass uses the finalized Web statement header's `payTotal`, `shiharaiDate`
  and `seikyuYm`, on page zero only. A statement still being created is excluded.
  Customized/unconfirmed `shiharaiKin1/2/3` fields are not finalized bill totals.
- MyJCB uses the confirmed HTML heading and the exact dated
  `お支払い金額合計` definition/value pair. The page month must agree with the
  due date. Archived HTML lacking manifest statement metadata can establish
  these facts from the explicit page markers; contradictory metadata fails.
- Both emit `credit_statement_payment_amount` with an explicit `paymentDate`.
  These observations are statements, excluded from net-asset summation.
  Monthly MyJCB summaries without an exact due date remain useful evidence but
  cannot supply a guessed payment date to this matcher.
- The first bank adapter uses SMBC's canonical `smbc-bank` transactions with a
  provider identifier and explicitly signed debit direction. It preserves the
  provider's civil date. Other banks and aggregator copies are not implicitly
  interchangeable with this adapter.

The parsers preserve zero and refund totals as source values. The positive-debit
matcher excludes them; a refund or a partial/multiple settlement requires its
own supported model. No payment total is manufactured by summing purchase rows.

## Candidate and decision lifecycle

A bounded Processor sweep reads published observations, retaining provider
identity and acquisition namespace. Exact same-unit amounts and nearby dates
produce candidates only. They never cause automatic acceptance.

The sweep is the `card_settlement_sweep` lane, right after
`reconciliation_sweep` and under the same `RECONCILIATION_ENABLED` flag. It
logs `{"event":"card_settlement_sweep","scanned":…,"proposed":…,"written":…}`
(or `card_settlement_sweep_failed` with a safe code) and records each tick,
including a `skipped-by-flag` one, in `processor_lane_ticks`
([processor.md §6.1](processor.md#61-tick-records)).

The `カード照合` page shows the source facts, evidence links, candidate rationale,
current readiness blockers and decision history. An authenticated human operator
can plan an acceptance or rejection; the confirmation page then simulates,
approves and commits the pinned plan. Agents do not acquire acceptance rights.

Acceptance also requires explicit ownership evidence: the card account's
`liable_party` and bank account's `beneficial_owner` must identify the same
party through current accepted decisions. A login, matching account labels,
amounts or dates do not establish ownership.

From a proposed candidate, `口座の保有者と根拠を確認` opens an operator-only
review of both current account mappings and recorded ownership claims. Each
side starts without a selected owner. The operator supplies a stable identifier
(or explicitly selects a previously recorded one), confirms the source evidence
and account mapping, and explains the decision. The same identifier names the
same party; the identifier alone is not proof, and no party is derived from the
login. The UI adds the internal `party:` prefix; there is no new party registry.

The existing `relation.accept` / `relation.reject` lifecycle then plans,
simulates, obtains verified human approval and commits the decision. The
candidate marker, observation, parse revision and current account mapping are
mandatory evidence. The plan pins the candidate revision, mapping revision and
the count of all ownership claims for that account and role, so a competing
party claim also invalidates the plan. Commit checks these and both source facts
atomically. Missing, ambiguous or changed mappings require a fresh candidate;
the review does not silently repair them.

This review only records timeless ownership relations. Period-specific or
joint ownership is not inferred. A correction appends a rejection or a new
explicit claim and retains prior evidence. Saving ownership does **not** accept
a settlement: the next scheduled reconciliation pass (normally every five
minutes) creates a fresh immutable candidate with the new evidence. Refreshing
the page only reads that state. The operator must review and separately approve
the resulting settlement candidate. Agents cannot approve these financial
decisions.

The commit rechecks the source publication/currentness, ownership, allocation
availability and expected candidate revision in the same database batch that
reserves the receipt. Resolved card account and statement month also guard
against duplicates and older statements when a provider changes card ordinals. If any condition fails, it consumes no approval and writes
no partial receipt or decision. A resend returns the existing receipt.

An accepted decision can be withdrawn through a new approved plan. Withdrawal
retracts the interpretation, never the bank movement or original evidence.
Rejected and withdrawn candidates remain in history; a different correspondence
is reviewed as a different candidate. Historical citations keep resolving.

## Financial meaning and limits

Acceptance allocates the observed payment to a statement. It adds no new cash
movement and no new purchase expense: the bank debit is already in the source
evidence. Statement payment totals do not prove principal, fees or the unpaid
balance, so an obligation principal or exact liability reduction is not invented.
The screen keeps fee breakdown and net-asset impact unknown.

Card purchases now exist separately, recognised from the usage rows themselves
by the [card purchase recognition](economic-events.md#card-purchase-recognition)
lane (`PURCHASE_RECOGNITION_ENABLED`, on in production since 2026-09-24): each
is a `purchase` or `refund` event with one `purchase-recognition` leg and no
cash leg. Settlement still adds none. Its event carries the cash movement and
an unresolved obligation change, never a `purchase-recognition` leg, so a card
charge is counted once as a purchase and its payment once as cash. No purchase
is allocated to a statement: statement totals are not decomposed into
purchases.

A successful source collector, parser or candidate scan is not proof of complete
card history. Missing ownership, unavailable exact dates, unsupported bank
adapters and stale evidence remain visible limitations. This milestone does not
complete the broader [economic-event roadmap](roadmap.md).

## Purchase explanation chain

The operator-only `カード利用` page (`/purchases`, capability
`cardPurchaseRecognition`, `GET /api/v2/card-purchases`) reads the chain from a
recognised card purchase: 利用 → 請求 → 引落.

- A posted purchase joins the provider statement of the same resolved account,
  source and statement period (`YYYY-MM`): `card_statement_facts` whose
  `card_settlement_fact_ownership(kind='balance')` account is the purchase's
  account, the newest capture first. A card ordinal that changed under one
  account still joins; a statement whose account is not resolved joins nothing.
  A pending authorisation [linked to its posted row](economic-events.md#pending-to-posted-links)
  is one event carrying the posted row's facts, so it joins the posted row's
  statement exactly as the posted event did; a withdrawn link restores the
  posted event, which joins it again.
- The statement's settlement review is found by the (source, account, period)
  key an acceptance reserves: an accepted review first, then one still
  proposed, then a withdrawn and a rejected one, newest first within each, so
  a settlement withdrawn and later accepted again under a new candidate shows
  the new acceptance. While it is accepted, the page shows its
  `card_settlement` event, its `settlement` allocation and the bank debit its
  facts cite; a proposed, rejected or withdrawn review is named without a debit.
- A statement that cannot be shown is a reason, never a zero: `not_posted` for a
  pending row, `statement_not_collected`, or `period_unrecognized` when the
  provider period is in no recognised shape.

No allocation links a purchase to a statement, and none is written: a statement
total is not decomposable into purchases. The provider total is shown beside the
purchase figures, which keep captured, authorized, refunds and unresolved events
apart, and no difference between them is computed. Accepting a settlement
changes none of the purchase figures (引落は購入費用に加算しません). An empty
list does not prove there were no purchases: installment, revolving and bonus
rows and rows the recognition writer has not reached are counted as
unrecognised instead.

### Reviewing a pending-to-posted link

A pending row and the posted row that replaced it stay two recognised events
until an operator decides otherwise. Amount and date closeness never merge
anything by itself. When a stage-B reconciliation proposal names one of a
purchase's rows, the explanation lists the proposal after the 利用 → 請求 → 引落
chain. At most ten are listed for each row of the purchase, newest first; among
proposals written together, the pair with most in common comes first. The list
page shows each open candidate on the page once, between the coverage note and
利用の一覧.

Each candidate shows:

- both rows as the provider displayed them: usage date, the row's own signed
  amount, the state and revision of the event that holds the row, and a link to
  the record and its original;
- whether the provider itself linked the two rows;
- the rationale codes, the conditions that would make the rows two different
  purchases, and any blocker.

Only the actions the server offers appear. Each needs a written reason, and
each appears only where `commands` is advertised:

| Button               | Command           | Offered on                                                        |
| -------------------- | ----------------- | ----------------------------------------------------------------- |
| 同一の利用として統合 | `relation.accept` | an open candidate with no blocker                                 |
| 別の利用として扱う   | `relation.reject` | an open candidate                                                 |
| 統合を取り消す       | `relation.reject` | an accepted link; withdrawing it splits the merged purchase again |

The payload is the candidate's own `relation` plus the reason. The page builds
no relation end and no evidence ref. The confirmation screen opens only when the
plan does the chosen action (the proposal target's next status in the plan:
`accepted`, `rejected` or `withdrawn`) and pins these at exactly the revisions
shown:

- `proposal:<id>`;
- the `pending_to_posted` relation triple;
- `card-purchase:<event id>` for each side a live event holds, whatever the
  action (a merged link is one event, so one pin).

A withdrawal of a merged link also pins the posted event the merge absorbed at
revision 0. The page leaves that pin to the server and never reads the absorbed
event.

The confirmation screen reads back every purchase the plan pins at a live
revision and takes the candidate from the one that lists it: each side lists at
most ten candidates per row, so a busy month may list it on one side only. It
shows each pin beside the candidate's value. The action it
names is the one the server's simulation states, never inferred from the
candidate. It names the `review:card-purchase-link` invalidation and describes
the effect in words:

- A merge keeps the pending-origin event and absorbs the posted one, which
  takes that event from `authorized` (or `unknown`, once its row left the
  provider's display) to `captured`. An authorized pending row's amount leaves
  the authorized figure, since that purchase is now captured.
- A split of a merged link restores the posted event as captured and returns
  the pending-origin event to its pending row as `unknown`
  (`conflicting_evidence`), outside every figure. A withdrawal of a link that
  was never merged touches no event.
- A reject leaves both records as they are.

None of these adds or removes an amount, and the captured figure stays the same.
Approval is refused while any of these is missing or changed: a pin, the offered
action, or the candidate itself. The route is operator-only, so an agent sees
neither the candidates nor the actions.

## Verification

Synthetic tests cover authoritative totals, missing/ambiguous dates and totals,
refunds, unconfirmed pages, ownership blockers, stale plans, idempotent decisions,
allocation conflicts and withdrawal history. Browser tests exercise the explicit
review/approval flow and refuse a detail revision that changed after planning.
The pending-to-posted review is tested the same way. Its plans carry the
candidate's own relation, and its confirmation refuses a pin, action or
candidate that changed after planning.
Archived production samples were inspected read-only to verify provider field
shapes; private values are not test fixtures and no live financial decision is
accepted by those checks.
