# Card statement settlement review

This slice connects an authoritative Vpass or MyJCB statement payment total to
an observed bank debit from one of the [bank adapters](#bank-adapters) (SMBC,
SBI Shinsei). It records a reviewable correspondence and its
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
- Bank debits come from `card_bank_debit_facts`, a union of per-bank
  adapters (migration 0052, [ADR 0018](adr/0018-sbi-shinsei-bank-debit-adapter.md)).
  Each admits only rows with a provider row id and a debit direction the
  provider itself states, ranks each provider id's captures so the newest one
  is the only payment, and states the provider's civil date as `debit_date`.
  Other banks and aggregator copies are not implicitly interchangeable with
  these adapters; see [Bank adapters](#bank-adapters).

### Bank adapters

| Adapter                                | Rows admitted                                                                                                                                                                                                                       | Provider key          | `debit_date`                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| SMBC (`smbc-bank`, since 0044)         | any `smbc-bank` parse; non-empty provider id; newest capture `status='posted'`, `_kogane.direction='outflow'`, `_kogane.amountSignSource='direction'`, negative amount                                                              | the row's provider id | `as_of` of the form `YYYY-MM-DDT00:00:00+09:00`, its date; else none |
| SBI Shinsei (`sbi-shinsei-bank`, 0052) | parser `sbi-shinsei-top-balances-and-activity`; non-empty `txnReferenceNo`; newest capture with no status, `JPY`, `_kogane.amountSignSource='debit'` (the provider's debit column), negative amount (a zero debit is stored as `0`) | `txnReferenceNo`      | the posting date, `YYYY-MM-DD`                                       |

Both adapters propose candidates. Since ADR 0054 G1b a debit can be accepted
only when its row records the id's origin. SMBC rows do. SBI Shinsei rows do
from parser 0.1.3 (2026-10-09,
[ADR 0018](adr/0018-sbi-shinsei-bank-debit-adapter.md#2026-10-09-release-013-records-the-provider-id-origin)),
which records `_kogane.identityOrigin: provider-id` beside the unchanged
`txnReferenceNo`; a row a 0.1.2 run stored has no recorded origin, so its
acceptance is refused (`identity_origin_unrecorded`,
[lifecycle](#candidate-and-decision-lifecycle)). Rows of 0.1.2 runs stay
refused until the repair lane has re-parsed them under 0.1.3; the candidates
the sweep then proposes cite the 0.1.3 rows, and the earlier candidates stay
listed with the blocker `bank_debit_changed`. The rule-exception route, treating
ADR 0018's reviewed adapter evidence as the declared origin, was not taken.

The currency, status, direction and sign are judged on the newest capture of a
provider id, so a newer capture that fails them withdraws the row instead of
letting an older capture stand. Credits, zero debits, foreign-currency rows,
rows without a provider id and rows of other parsers are never debits.

The sweep reads the debits whose `debit_date` is within three days of a due
date (at most 1,000 per due date). Before 0052 it read SMBC rows by the first
ten characters of `as_of` and skipped, after reading them, those not of the
midnight-JST form; such rows no longer take a place in that limit or count in
the sweep's `scanned`, and the SMBC pairs it proposes are otherwise the same.

Mizuho and Sony Bank are not adapters. Their history ids are fingerprints of
the row's fields and its position (`mizuho:<fingerprint>:<occurrence>`,
`sony-bank-history:<date+signed amount+after-balance+currency>:<n>`), so one
payment re-observed after the page changed could carry another id and count
twice. They need a stable row identity first.

Which card pays from which bank: the code does not know, and no setting names
a card's debit account. A card and a bank are paired only as a candidate
(equal amount, due date ±3 days) and only an accepted review with shared
ownership makes the pairing a decision. In production at the time of writing
(2026-09-26), every proposed review pairs a Vpass or MyJCB statement with an
SMBC debit, none is accepted, and there is no published SBI Shinsei
transaction: every stored capture of the SBI Shinsei activity page was
rejected by its parser (closed code `parser_rejected`), so the SBI Shinsei
adapter admits nothing until the parser accepts them. A card provider's own
statement of the debit account is recorded beside each MyJCB candidate as
evidence for this pairing, never as a decision
([Provider-stated debit accounts](#provider-stated-debit-accounts)).

A debit posted more than three days from the due date, for example after a
long run of bank holidays, produces no candidate. That is a limit of the
matcher, not evidence that the bill was unpaid.

The parsers preserve zero and refund totals as source values. The positive-debit
matcher excludes them; a refund or a partial/multiple settlement requires its
own supported model. No payment total is manufactured by summing purchase rows.

### Provider-stated debit accounts

Design: [ADR 0032](adr/0032-provider-stated-debit-accounts.md) and its
2026-09-27 amendment (proposed). What the code does today:

**The page.** Every MyJCB credit detail page observed in round 4 (the
confirmed statement and the ショッピングスキップ払い page, live and in the
stored redacted HTML) has an `h3.hdg-H3` heading 「カード情報」 after the
ledger, followed by a `table.table-data` of th/td rows: カード名称, カード発行会社,
金融機関名 (bank name), 支店名 (branch name, no branch code), 科目・口座番号
(「普通 ####\*\*\*」 in shape: the account type, a space, the FIRST four digits,
the rest masked with `*`) and 口座名義 (the holder's name, partly masked).
`readMyJcbCardInformation` (`packages/domain/src/myjcb-card-information.ts`)
finds the table by text, not by class names: the one heading element (h1-h6)
whose text is 「カード情報」, then the first table after it, whose every row
must be one th with a known label and one td. It reads the bank name, branch
name, account type, the four leading digits and the mask length, checks the
other rows' labels, and never reads the card name or the holder name:
nothing uses them. The stored page keeps the holder name as displayed
([ADR 0029 amendment 2](adr/0029-data-classification-and-unkeyed-identity.md#amendment-2-2026-09-27-person-names-are-kept-in-stored-evidence)). Any other shape is a closed
refusal code: `card_information_absent`, `card_information_ambiguous`,
`card_information_table_missing`, `card_information_table_invalid`,
`card_information_name_invalid`, `card_information_account_invalid`.

**The observation.** The `card_debit_account_sweep` lane
(`services/processor/src/card-debit-account-job.ts`) reads pages whose
`myjcb-credit-statement-total` parse is published, re-reading the bytes from R2
and checking their digest, at most 20 a tick. Each becomes one
`card_debit_account_statement` row (migration 0060) per card
(`myjcb:<connection>:root`), raw object and reader version: `read` with the
displayed values, or `refused` with a closed code (also `page_not_utf8`,
`raw_object_unreadable`, for bytes that are missing, of another size or fail
their digest) and no value, so a page is not read again under the same reader
version. The same bytes stored by several runs are one row. Only artifact keys
whose connection segment is `[a-z0-9][a-z0-9-]{0,63}` are selected, the shape
the table accepts; any other key is never read. The table is append-only; a corrected reader is a new version and
new rows. The lane runs under `RECONCILIATION_ENABLED`, right before
`card_settlement_sweep`, and logs `scanned`, `read`, `refused`, `written`.

**The rule** (`proposeCardDebitAccount`, policy
`card-debit-account-statement-v3`). The displayed bank name resolves to a CORE
source id only through a table of the banks Kogane models (みずほ銀行,
三井住友銀行, SBI新生銀行, ソニー銀行, compared after NFKC and whitespace
removal); any other name is `bank_not_resolved`. 普通 is `ordinary` and 当座 is
`current`. A card → bank account relation is proposed when exactly one known
account at that bank has the same account type and an account number that
starts with the four leading digits, and every known account at that bank is
comparable. The branch name is carried as displayed and never compared: no
bank reference carries one (Mizuho's parser records a branch name in its
observation `extra`, but its rendering next to MyJCB's is unobserved). Other
outcomes are closed reasons: `statement_invalid`, `bank_not_resolved`,
`account_type_not_resolved`, `account_digits_not_shown`,
`no_comparable_bank_account`, `no_matching_account`, `ambiguous_accounts`,
`uncomparable_account_at_bank`. Known accounts are the distinct source
accounts the identity rules recorded for that bank (`source_accounts`, at most
100; beyond that nothing is recorded).

**In the settlement sweep.** For each MyJCB candidate, the sweep reads the
debit-account row of the page the candidate's statement total was parsed from
(same raw object, same card, current reader version) and appends to
`card_settlement_debit_account_evidence` what it says: `supports` (the
proposal names the candidate's card and bank account), `names_other_account`,
or `not_proposed` with the reason. A row is appended only when the outcome
differs from the candidate's latest row for that statement and policy. The
candidate's facts, digest and eligibility are unchanged: the evidence sets no
owner and no ownership evidence, and ownership and acceptance stay operator
decisions (INV07). The sweep's log line adds `debitAccountEvidence`, the
number of evidence rows appended.

Limits:

- **Not on the review page.** The evidence rows are not read by the
  `カード照合` review or its API: showing them needs a new field in the review
  contract (`packages/observation-shared/src/card-settlement-contract.ts`) and
  the web page, which this change does not make.
- **Historical SMBC and SBI Shinsei references remain uncomparable.**
  SMBC's legacy reference carries no account digits. New captures retain the
  successful request's branch, ordinary account type and number in normalized
  artifacts; parser 1.1.0 preserves this context. Policy v3 compares only the
  candidate debit's own published transaction/parse context and cites that
  observation. A later balance or another capture never supplies missing
  historical digits (ADR 0034). Unenriched account lists are cached once per
  bank per sweep; enrichment creates candidate-local copies.
  SBI Shinsei's accountNo layout next to a displayed account number remains
  unverified. Mizuho is comparable but has no bank debit adapter.
- **Branch names are not compared** (above), so two known accounts at one bank
  with the same four leading digits are `ambiguous_accounts`.
- **Vpass**: none of the statement APIs (`web_meisai_top/v1`,
  `dropdownlist_init/v1`, `meisai_ans/v1`, `xt_seikyu/v1`) carries a bank,
  branch or debit-account field, for any of the seven cards observed in
  round 4; the only account-looking keys (`webMeisaiTopK3Vo.accountNo`, fully
  masked, and `accountOvly`) are card-side identifiers. Vpass has no reader.
- A unique match among the accounts Kogane knows can still be wrong (an
  uncollected account at the same bank with the same leading digits), which
  is why acceptance stays with the operator.
- The mask length is recorded but not compared with the bank account's length.

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
availability, claim availability and expected candidate revision in the same
database batch that reserves the receipt. Resolved card account and statement
month also guard against duplicates and older statements when a provider
changes card ordinals. If any condition fails, it consumes no approval and
writes no partial receipt or decision. A resend returns the existing receipt.

Since ADR 0054 G1b the acceptance and the withdrawal write the rows of the
[common consumption guard](economic-events.md#common-consumption-guard-migration-0070)
(migration 0070) in the same batch:

- **Identity first.** An acceptance is planned only for a debit whose identity
  a human-adopted writer may consume (`humanAdoptedRowIdentity`): the bank row
  must carry an id the parser records as provider-issued
  (`_kogane.identityOrigin: provider-id`) under a provider identity function
  the transaction-family registry declares. SMBC debits qualify (`id`, from the
  provider's `meisaiId`); SBI Shinsei debits qualify when parser 0.1.3 or later
  stored them (`txnReferenceNo`, alias class
  `["sbi-shinsei-bank",[<txnReferenceNo>],<resolved account>,"sbi-shinsei-txn-reference-no-v1"]`).
  An SBI Shinsei debit a 0.1.2 run stored records no origin, so its acceptance
  is refused with `unsupported_semantics` and the closed code
  `identity_origin_unrecorded` until the repair lane has re-parsed it under
  0.1.3. Fingerprint, digest and unrecorded ids are refused the same way,
  with their own codes. Nothing is adopted automatically.
- **The claim.** The acceptance writes, after its legs and allocation, an
  `economic_claims` row in book `cash-movement` for the debit: the candidate's
  `bank_key` (the 5-tuple, re-derived by the 0070 trigger from the cited
  observation and parse run) and its alias class
  `["smbc-bank",[<provider id>],<resolved account>,"smbc-meisai-id-v1"]`; then
  the accepted decision row, the event revision's seal (two legs, one claim,
  the current identity epoch, no identity pin) and the commit row
  (`card-settlement.accept`, the operation, the principal and the receipt's
  payload digest). The claim is held while the event revision is live; another
  writer's claim on the same key (`economic_claim_held`) or alias class
  (`alias_conflict`) refuses the batch, in either order.
- **The withdrawal** seals its `unknown` revision (no legs, no claims) and logs
  a commit row that supersedes the accepted revision and releases its claim,
  and still writes `card_settlement_allocation_withdrawals` as before. A
  release whose key another live holder also holds is refused
  (`economic_claim_conflict_unresolved`): a double holder is never washed. The
  withdrawal plan already refuses it (`needs_scope_resolution` with that code),
  reading the key half of `claim_available` by the candidate's id; a plan made
  before the second holder appeared is refused by the commit row
  (`commit_failed` with that code).
- The plan pins the event's head, `economic-event:<event id>` (0 before an
  acceptance, the accepted revision before a withdrawal), beside
  `card-settlement:<id>`.
- A refusal is answered with the closed code as the second ref: at plan time
  `stale_context` with `economic_claim_held` or `alias_conflict` when
  `claim_available` is 0, and at commit time the trigger's code when a batch
  is refused (`stale_context` for the conflicts, `commit_failed` otherwise).

The event revision's evidence is the statement and bank rows as `SourceFactRef`
objects (`{kind, id, revision}`); the decisions keep citing their ids. The cash
leg's subject stays the bare account id the 0044 readers tolerate.

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
recognised card purchase: 利用 → 請求 → 引落. An agent with a whole-store
`records.read` grant reads the same chain through `kogane.purchases.explain`
([agent API](agent-api.md#card-purchase-explanation)).

- A posted purchase joins the provider statement of the same resolved account,
  source and statement period (`YYYY-MM`): `card_statement_facts` whose
  `card_settlement_fact_ownership(kind='balance')` account is the purchase's
  account, the newest capture first. Both sides mean the payment month: the
  statement's period comes from its payment date, and a MyJCB purchase's from
  its ledger label: the payment month a confirmed page names, which the
  collector records as the period
  ([observations](observations.md#myjcb-statements-keep-their-identity-when-their-position-moves-collector-no-parser-release)),
  or, for captures stored before that, a relative `detailMonth-0` or
  `detailMonth-1` resolved from the capture time of the ledger artifact
  (rule `relative-statement-period-v1`,
  [observations](observations.md#relative-period-labels-are-resolved-from-the-capture-time)),
  so a MyJCB purchase joins the statement the same capture's page names. A
  card ordinal that changed under one account still joins; a statement
  whose account is not resolved joins nothing.
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
  provider period is in no recognised shape. A MyJCB confirmed capture stored
  under `detailMonth-2` or later, which the rule does not place, is not current
  at all, so it is never recognised.

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
action, or the candidate itself. The route is operator-only. An agent reads the
same candidates through the agent API's `kogane.purchases.explain`
([agent API](agent-api.md#card-purchase-explanation)) with every fact and
blocker but without `actions` or `relation`, so it can report a candidate and
never review one: the decision stays on this page.

## Cost

D1 never runs `ANALYZE`, so its planner has no table statistics. Measured on
that basis (every CORE migration, no `sqlite_stat*` table) on `bun:sqlite`
and on workerd's SQLite through Miniflare, over the synthetic store of
`packages/read-model/test/card-usage-scale-fixture.ts` at `STATEMENT_SCALE`:
three Vpass cards, a MyJCB connection, SMBC and St.George captured daily for
730 days through the deployed parsers, each capture restating the bills of the
two posted months, the SMBC debit of every bill on its due date, and the
settlement reviews the sweep proposes after each capture (one per recapture
of a bill once its debit is in), most months accepted. That is 628,173
transaction and 16,790 balance observations (5,840 of them statement totals),
16,056 published parses, 104 current statements, 3,763 candidates (77
accepted, 9 rejected) and 5,337 live purchase events. Median wall time of the
shipped reads and of the current ones:

| Read                                           | Shipped  | Now    | Shipped, workerd | Now, workerd |
| ---------------------------------------------- | -------- | ------ | ---------------- | ------------ |
| `queryCardPurchases`, first unfiltered page    | 2,436 ms | 665 ms | 3,356 ms         | 1,037 ms     |
| `queryCardPurchases`, first page of one period | 1,284 ms | 560 ms | 1,368 ms         | 803 ms       |
| `queryCardPurchases`, one event                | 1,128 ms | 540 ms | 1,237 ms         | 741 ms       |
| its statement read (104 statements)            | 590 ms   | 83 ms  | —                | 121 ms       |
| its settlement read (104 statements)           | 1,346 ms | 21 ms  | —                | 38 ms        |
| sweep: a page of 100 statements with owners    | 562 ms   | 97 ms  | 623 ms           | 112 ms       |
| sweep: debits around one due date, with owners | 3,465 ms | 53 ms  | 3,612 ms         | 67 ms        |

These figures were measured before migration 0052. Since then the fixture
debits each MyJCB bill from SBI Shinsei instead of SMBC, through the deployed
SBI Shinsei parser, and captures SBI Shinsei's activity page daily over a
three-day window (so every row is re-observed twice), which adds rows and one
branch to the bank debit view; the timings have not been measured again.

The shipped reads resolved owners through `card_settlement_fact_ownership`,
whose `current_identity_observations` source materializes the candidate
identity runs of every published parse (`SCAN pub`) and which groups every
identity of the kind before any key applies: once per request for the
statements, and for the sweep once per tick for the statements plus once per
statement for the debits, over every transaction identity of the store (up to
100 bank reads a tick: about six minutes of reading at this size). The reads
now name their statements or debits first and resolve owners through
`packages/read-model/src/card-settlement-ownership.ts`, the same view text
applied to the parses of those observations only; the view is unchanged. They
reach identities through `identity_observation_lookup (kind, observation_id)`
and the identity runs' keys, and the rest through the primary keys and
`published_parse_runs_run`. The settlement read matched each statement's
reviews by three `json_extract` terms over every candidate, for every
statement asked for; migration `0050_statement_fact_indexes.sql` indexes
exactly those expressions (`card_settlement_candidates_statement_period`), so
its text is unchanged and each statement's reviews are found by key.

What still grows with history: `card_statement_facts` ranks every captured
statement total once per request and once per sweep tick (74 ms here; the
scan of every balance observation is 4 ms of it, and neither a partial index
on the statement metric nor an index on `metric` changed the time), and
`card_bank_debit_facts` ranks every adapter's rows once per statement of the sweep's
page (51 ms here, so a full page of 100 is about 5 s of D1 time a tick).
Candidates accrue one per recapture of a paid bill, reached by the index. The
rest of the purchases page is the current card usage pass
([read model](read-model.md#cost)).

### Readiness

Every read of `card_settlement_readiness` used to join the whole view: the
`カード照合` list and one review (`queryCardSettlements`), the ownership
review's candidate (`queryCardOwnership`), the settlement plan
(`cardSettlementPlan`), the ownership review's plan read and commit guard
(`prepareOwnershipReview`) and the settlement commit guard
(`services/processor/src/card-settlement-commands.ts`). The view ranks every
statement total and bank debit row and owns them through
`card_settlement_fact_ownership`. Each read now chooses its candidates first
(the page, or the one proposal) and judges only those through
`packages/read-model/src/card-settlement-readiness.ts`. That file holds the
view's own select over the facts of those candidates only: the statement
totals of each candidate statement's source and period, the bank debit rows (both adapter branches) sharing
each candidate debit's source account and provider id (whole ranking
partitions, so the newest capture is the same), and their owners through the
keyed ownership CTEs. The allocation check keeps the view's text and reaches the
debit's rows by the account index. The view is unchanged, and so is each guard's
place: the commit guards still run inside the statement that reserves the
receipt, so a statement, debit, owner or allocation that changed after the plan
still writes nothing. Median wall time on the store above (bun:sqlite; the
container was shared with other jobs, so treat these as orders of magnitude):

| Read                                       | Shipped   | Now    |
| ------------------------------------------ | --------- | ------ |
| `カード照合` list, first page (50 reviews) | 37,072 ms | 143 ms |
| one review (`proposalId`)                  | 6,581 ms  | 63 ms  |
| settlement plan read                       | 6,257 ms  | 38 ms  |
| settlement acceptance commit guard         | 120 ms    | 31 ms  |
| ownership review guard, candidate term     | 113 ms    | 33 ms  |

The shipped guards were cheaper than the plan reads because SQLite evaluated
the view's flags for the one row the guard names. The reads by id joined the
view and evaluated them for every candidate. A rejection or withdrawal guard reads no flag.

`claim_available` (ADR 0054 G1b) is a fifth column the view does not have:
1 when no live holder other than the candidate's own accepted event holds the
candidate's `bank_key` in book `cash-movement` (an `economic_claims` row of a
live revision, or an accepted settlement decision of a live revision), nor the
alias class the registry's provider identity function computes for the
candidate's debit row and the facts' bank account
(`providerAliasClassSql`). Each holder source is looked up through its own
index (`economic_claims_key`, `card_settlement_candidates_bank`,
`economic_claims_alias`). The plan read and the acceptance guard require it;
the `カード照合` list does not show it (its review contract has no field for
it), so a review the list shows as ready can still be refused at plan time.
The four other columns kept their text: it is frozen before the change
(`packages/read-model/test/card-settlement-readiness-ctes-legacy-sql.ts`,
digest-pinned) and compared column for column on the random stores and the
scaled store.

What still grows with history: each judged set of candidates ranks the
statement totals of its periods after reading every balance observation once
(the `b` scan the plan checks allow in `ready_statements`, as in
`card_statement_facts`). The allocation check walks the debit account's bank
rows through `idx_txn_obs_account` for each candidate. The list orders every
candidate to choose its page (4 ms for 3,763 candidates here; no index).
Not changed here, and not measured: the ownership review's account mapping
reads (`queryCardOwnership`'s mappings, `prepareOwnershipReview`'s mapping read
and the two mapping terms of its commit guard) still read
`current_identity_observations`, so the guard's row above times only its
candidate term.
`card-settlement-readiness.test.ts` compares the CTEs with the view on random
stores whose reviews draw every flag both ways. It also shows that ten
inexactness mutations (a cut partition, a reversed order, a dropped owner,
evidence or reservation condition) each fail that comparison. Since G1b it
also compares the four flags with the frozen pre-G1b text, and
`claim_available` with its definition over `live_consumption_claims` and the
registry's alias classes on stores that draw cash-movement holders (live,
released and refused economic claims, with and without an alias class, a
review's own claim, and legacy settlement events), where six mutations (a
released or withdrawn holder kept, the candidate's own event counted, legacy
holders or alias classes ignored, the account left out of the class) each fail
it, and checks that its plan searches the holder indexes without table
statistics; `packages/application/test/card-settlement-review-scale.test.ts`
compares the same on the scaled store.
`card-settlement-review-differential.test.ts`,
`card-settlement-review-scale.test.ts` and the processor's
`card-settlement-scale.test.ts` compare every reader and guard with the shipped
text (`card-settlement-readiness-legacy-sql.ts`,
`card-settlement-legacy-sql.ts`) and fail on a plan that reads the store's
owners, scans a base table or builds an automatic index on one.

`packages/application/test/card-statement-scale.test.ts` and
`services/processor/test/card-settlement-scale.test.ts` compare the purchases
pages and the sweep's reads with the shipped text on a smaller store of the
same shape, fail on a plan that reads the owners of the whole store or scans
the candidates, and check that the sweep itself, run over that store, proposes
nothing the fixture has not written; `KOGANE_CARD_STATEMENT_SCALE=full` builds
the store above and prints the timings. The same comparisons run on small
random stores that draw every identity, mapping and ownership-claim state the
views distinguish (`card-settlement-ownership.test.ts`,
`card-statement-differential.test.ts`).

## Verification

Synthetic tests cover authoritative totals, missing/ambiguous dates and totals,
refunds, unconfirmed pages, ownership blockers, stale plans, idempotent decisions,
allocation conflicts and withdrawal history. Browser tests exercise the explicit
review/approval flow and refuse a detail revision that changed after planning.
The pending-to-posted review is tested the same way. Its plans carry the
candidate's own relation, and its confirmation refuses a pin, action or
candidate that changed after planning.
The SBI Shinsei adapter is tested through the processor's parse lane and the
deployed parser on the synthetic parser-boundary fixture and variants of it
(`services/processor/test/card-settlement-sbi-shinsei.test.ts`): an
equal-amount statement yields a candidate; credit, zero and foreign-currency
rows do not; a re-observed `txnReferenceNo` is one payment; unknown ownership
blocks acceptance; an owned SBI Shinsei candidate's debit, parsed by 0.1.3, is
admitted under its declared alias class, and an accepted SMBC debit reserves
the statement against it until it is withdrawn.
`services/processor/test/card-settlement-sbi-shinsei-origin.test.ts` walks a
capture a 0.1.2 run stored: its candidate's acceptance is refused with
`identity_origin_unrecorded` and writes nothing; the repair lane re-parses the
capture under 0.1.3 beside the 0.1.2 run (rows unchanged, pointer moved by an
appended publication event, nothing adopted); the sweep proposes the 0.1.3 row
under the same `bank_key`, which an acceptance made before G1b still reserves;
after its withdrawal a human acceptance claims the debit under its alias class;
and a later capture reusing the reference is refused against that holder.
`services/processor/test/economic-card-settlement.test.ts` covers what an
acceptance and a withdrawal write to the consumption guard, and its refusals
([economic events](economic-events.md#common-consumption-guard-migration-0070)). `packages/read-model/test/card-bank-debit-facts.test.ts`
shows the SMBC branch returns exactly the 0044 view's rows.
`packages/domain/test/card-debit-account.test.ts` covers the provider-stated
debit-account rule on synthetic inputs: bank names resolve only through the
table, a unique account starting with the leading digits is proposed, an
account ending in them is not, the account type must agree, every other case
is a closed reason, and a proposal never makes a candidate eligible.
`services/processor/test/card-debit-account.test.ts` covers the MyJCB reader on
synthetic 「カード情報」 tables (the read values, every refusal shape, the holder
and card names never read), the lane (one row per card and raw object, no
second row on a re-run or for the same bytes of another run, refusals stored
without values, append-only guards), and the settlement sweep (evidence
attached, a changed outcome appended, the candidate's facts and eligibility
unchanged).
Archived production samples were inspected read-only to verify provider field
shapes; private values are not test fixtures and no live financial decision is
accepted by those checks.

## Automation prerequisites (ADR 0034)

The pure assessSettlementAutomation function is a separately tested rule
evaluator. It checks explicit account/period authorization, current ownership
and facts, candidate-local bank evidence, complete acquisition and candidate
sets, two-sided uniqueness, allocation availability, and previous decisions.
Its would_accept result is a simulation verdict only; no production writer
or policy loader calls it yet.

The processor's settlement:shadow task (with --remote) performs one read-only
D1 query and emits aggregate prerequisite counts. It inspects at most 1,001
newest candidate rows and marks truncation above 1,000. These counts describe
the sampled current candidate graph; they are not auto-acceptance counts and
do not establish full acquisition coverage or authorization.
The debit_context_present count measures presence only, not validity.
The command does not run the domain evaluator, configure policy, call AI,
or accept anything.

Remaining rollout: obtain a new authenticated SMBC capture through its existing
Safety Pass flow, verify retained account context, configure initial ownership
and effective account scope, connect the evaluator to a complete read-only
candidate adapter, then add the versioned authorized atomic acceptance lane.
Workers AI is deferred until unresolved deterministic cases are measured.

### Sharing bank reads for repeated due dates

Within a sweep invocation, bank rows for the same due date are reused only
while CORE's source revision, visibility revision and epoch match. A miss is
cached only if the tuple is stable across its query. Source, publication,
identity, mapping, ownership or visibility changes therefore cause a fresh
bank read. No cache survives a tick. Retention is bounded to 32 dates and
2,000 rows; results are evicted rather than truncated. The original keyed SQL,
adapter behavior, row order, 1,000-row query limit and candidate semantics are
unchanged. The scanned counter continues to count logical candidate rows,
including reused rows, rather than claiming to measure D1 rows_read.
