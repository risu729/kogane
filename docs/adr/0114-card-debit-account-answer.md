# ADR 0114: Answer each card's debit account from stated evidence first, then accepted settlements

- Status: proposed
- Date: 2026-11-18
- Tracking: [issue 1357](https://github.com/risu729/kogane/issues/1357)
- Related: [ADR 0032](0032-provider-stated-debit-accounts.md) (provider-stated
  debit accounts), [ADR 0081](0081-ui-parity-through-mcp.md) (UI/MCP parity),
  [ADR 0001](0001-domain-axes.md) (INV05, INV07)

## Context

The owner asked (issue 1357, 2026-11-17) which bank account each credit card
is debited from. The answer existed only per settlement candidate on the
`カード照合` page: each MyJCB candidate carries the provider-stated debit
account evidence of ADR 0032 (`supports`, `names_other_account`,
`not_proposed`), and each accepted candidate names the bank debit it was
matched to. Nothing answered per card, so:

- a card whose newest statement is zero has no candidate to look at, and the
  last known account was hidden among older candidates;
- a Vpass card has no stated account at all (its statement APIs carry none,
  ADR 0032), so the only evidence is a match someone accepted;
- an undecided candidate looks like an answer although it is an amount and
  date proposal (INV07).

Collecting new provider data (Vpass card names, MyJCB's other cards, other
card providers) is out of scope: it needs provider observation and is
tracked by the collector issues the issue lists.

## Options considered

1. **A per-card read over the evidence already stored, with a closed basis
   (chosen).** The stated evidence comes first, an accepted settlement second,
   and undecided candidates are listed but never answer.
2. **Re-run the ADR 0032 rule per card at read time** over the newest reading
   and the known bank accounts. Policy v3 compares a reading with the
   candidate debit's own transaction context, so a per-card run would need a
   second notion of "known accounts" and could disagree with the evidence the
   review page shows. Rejected: one rule, one record.
3. **Store a per-card answer in a table written by a lane.** It would go
   stale between ticks and add a writer for what is a projection of
   append-only evidence and decisions. Rejected.
4. **Let the newest undecided candidate answer when nothing else does.**
   Rejected: a candidate is a heuristic proposal; adopting it would break
   INV07.

## Decision

`reviewCardDebitAccounts` (`packages/application/src/query/card-debit-accounts.ts`)
answers, for every card with a current statement total, a stated reading with
evidence or a settlement candidate (at most 100, `cardsTruncated` beyond), under
rule `card-debit-account-answer-v1`
(`packages/domain/src/card-debit-account-answer.ts`):

1. **Stated side.** The readings are the `card_debit_account_statement` rows
   made under the current reader version that the settlement sweep cited in
   `card_settlement_debit_account_evidence` under the current policy. The
   newest reading (capture time, then id) decides the status from its
   current rows, the newest one per candidate (the sweep appends a row each
   time a candidate's outcome changes): `named` (they name exactly one
   account), `conflicting` (more than one), `not_named` (none, with the
   rule's closed reasons); `absent` when no reading has
   evidence (`source_has_no_debit_account_statement` for Vpass,
   `evidence_not_recorded` otherwise). The newest reading that names exactly
   one account is kept as `lastNamed`, even when older.
2. **Candidate side.** Per card and bank account: the candidates whose latest
   decision is `accepted` (`settled`), and the candidates still `proposed` of
   statements no accepted candidate covers (`proposed`), each with the number
   of distinct statements and the one with the latest debit date.
3. **Answer.** `provider-stated` from `lastNamed` when there is one; else
   `accepted-settlement` from the newest accepted settlement, labelled weaker
   (an amount match a person accepted, not what the provider names); else
   `unknown` with `stated_reading_conflicting`, `only_unreviewed_candidates`
   or `no_debit_account_evidence`. Closed notes say what disagrees:
   `settled_account_differs`, `newer_reading_unresolved`,
   `settled_accounts_differ`, `stated_reading_conflicting`.

The `カード照合` page's `カードの引落口座` section
(`GET /api/v2/reconciliation/card-debit-accounts`, operator-only) and the MCP
read `kogane.card-settlements.debit-accounts` (catalogue
`card-settlements.debit-accounts`, R0, `records.read` on the whole store) are
adapters over that one function (ADR 0081). It reads only: no table, lane,
writer or command is added, and no candidate's eligibility changes.

## Consequences

- A card whose newest statement is zero keeps its last known account and the
  date it was seen (the reading's capture time, or the accepted debit date).
- A stated answer kept from an older reading while a newer one names no
  account (`newer_reading_unresolved`) is the last account the provider was
  seen to state, not the one it states now: the newer reading may show an
  account Kogane cannot name (`bank_not_resolved`, `no_matching_account`).
  The page shows it as a warning saying the account may have changed, with
  the newer reading's reasons beside it; the wire and MCP answer carry the
  code and the capture time.
- Only the statement read is bounded by the card count; the reading and
  candidate reads return every card's rows (proportional to the cards the
  store holds, not bounded by the grant's `maxRows`), and cards past the
  bound are dropped after reading, with `cardsTruncated` set.
- Vpass cards are answered only by accepted settlements; until one is
  accepted they read `unknown` (`only_unreviewed_candidates` when candidates
  exist). Card product names are not shown: Vpass accounts stay
  `vpass:card-00N`.
- An account Kogane does not know (an uncollected account at the same bank)
  cannot be named, as in ADR 0032; a stated answer is still the rule's
  proposal over the known accounts.
- A newer `refused` reading of a page is not considered: only readings the
  sweep cited carry evidence.
- Cost: one ranking of `card_statement_facts` (as the sweep's page), one scan
  of `card_settlement_debit_account_evidence` with each reading by key, and
  one scan of the candidates with each latest decision by key
  ([card settlements: cost](../card-settlements.md#cost)).
- The catalogue gains a read operation; its addition is an owner approval
  item before merge.

## Verification

- `packages/domain/test/card-debit-account-answer.test.ts`: the status of the
  stated side, the basis order, every note and unknown reason.
- `services/processor/test/card-debit-accounts.test.ts`: on the complete CORE
  schema, a stated MyJCB account whose newer reading names none or two
  accounts, a Vpass card answered by an accepted settlement and unanswered
  again after its withdrawal, undecided candidates that never answer, a read
  that writes nothing, refusal before reading, more cards than the bound
  flagged `cardsTruncated` and never listed past the cut, and keyed lookups of
  readings and decisions without table statistics.
- `packages/observation-shared/test/card-debit-accounts-contract.test.ts`: the
  wire contract refuses an answer, a note or an unknown reason its evidence
  does not carry.
- `packages/application/test/card-debit-accounts-contract.test.ts`: every
  answer the service makes from random synthetic evidence rows passes that
  contract, so it refuses no answer the server can give.
- `services/app/test/card-debit-accounts-api.test.ts` and
  `services/app/test/ui-mcp-parity.test.ts`: the route and the MCP tool give
  the same answer, are graded alike and are mapped.
- `apps/web/test/card-settlement.browser.test.ts`: the section names each
  basis and offers no action, warns that an older stated account may have
  changed, and says when the list is cut.

## Amendment 2026-11-18: a statement total that is not exact keeps its reason

- Status: proposed
- Date: 2026-11-18
- Owner approval: required before merge. The published answer of
  `kogane.card-settlements.debit-accounts` changes for a non-exact total, and
  a change to a published tool's answer is the owner's to approve
  ([ADR 0081](0081-ui-parity-through-mcp.md)'s `nextPage` amendment,
  [ADR 0088](0088-collection-quality-per-account.md)).

### Context

Each card's `latestStatement.amount` was the statement total when its
decimal-v1 value was exact and `null` otherwise. A total the decimal-v1
projection recorded as `missing`, `unparsed` or `conflict`, or one with no
decimal-v1 value at all, lost its status and reason: the wire, the MCP tool
result and the `カードの引落口座` section showed it only as absent, which the
section rendered as a bare `不明`. INV05 asks that a value that is not exact
be a reason, and the card purchase read already answers the same view's total
(`providerTotal`) as a quantity with its status and reason.

### Options considered

1. **Keep `null` and add a sibling reason field.** A second shape for the
   same fact, different from every other quantity on the wire. Rejected.
2. **Always a quantity, with the reasons `providerTotal` gives (chosen).**
   The domain's `Quantity` already carries `{status, reasonCode}`; the page's
   `SettlementQuantity` already shows it as unknown with its reason.
3. **Drop a card whose newest total is not exact.** It hides how old the
   answer is, which is why the statement is listed. Rejected.

### Decision

`latestStatement.amount` is always a `Quantity` (`latestStatement` itself is
still `null` for a card without a current statement). An exact total is
unchanged. A total that is not exact is `missing`, `unparsed` or `conflict`
with the reason `stored:<status>`, or `missing` with `decimal_not_projected`
when `card_statement_facts` found no decimal-v1 value for the observation.
An `exact` status without both decimal-v1 columns, or a status outside
decimal-v1, is what CORE 0024's CHECK never stores; the read fails
(`card_debit_accounts_row_invalid`) rather than answer it. The wire contract
(`validCardDebitAccountsReview`) requires a quantity and refuses `null`, and
the page renders the total through `SettlementQuantity` only.

### Consequences

- The route body and the `kogane.card-settlements.debit-accounts` result
  change shape for a non-exact total (`null` becomes a quantity with its
  status and reason); every answer whose totals are exact is unchanged byte
  for byte, and a row CORE 0024 never stores fails the read where it
  answered `null`. The tool's name, description and input schema are
  unchanged, and the catalogue is not touched.
- `schemaVersion` stays `kogane-card-debit-accounts-v1`. The v1 wire
  contract already admitted any quantity there, a non-exact one included
  (`amount === null || validQuantity(amount)`), so the new answers are v1
  answers; what is withdrawn is `null`, which the new contract refuses. An
  older browser client accepts the new shape, and client and Worker deploy
  together, so no client meets `null` from a newer Worker.
- An MCP client that relied on `amount === null` to mean "not exact" (what
  the service type's comment said; the tool description,
  `docs/agent-api.md` and `docs/card-settlements.md` did not) now reads
  `amount.value.status`. One that read `amount.value.value` without checking
  the status was already wrong against the v1 contract, which admitted a
  non-exact quantity.

### Verification

- `packages/application/test/card-debit-accounts-contract.test.ts`: each
  non-exact status and the missing decimal value give their quantity and
  reason and pass the wire contract; an `exact` status without its columns,
  or an unknown status, fails the read; the random stores now use the view's
  real shapes, non-exact totals included.
- `services/processor/test/card-debit-accounts.test.ts`: on the complete CORE
  schema, a Vpass total that is not a number is `unparsed` /
  `stored:unparsed`.
- `services/app/test/card-debit-accounts-api.test.ts`: the route and the MCP
  tool give the same answer for that total.
- `packages/observation-shared/test/card-debit-accounts-contract.test.ts`:
  the contract accepts a non-exact quantity and refuses `null`, a missing
  amount and an `exact` status with a reason.
- `apps/web/test/card-settlement.browser.test.ts`: the section shows
  `不明（stored:unparsed） · JPY` and refuses a `null` total before it renders.

## Amendment 2026-11-19: the `upcoming` view answers each card's next bill and whether its account covers it

- Status: proposed. It changes the published input schema and answers of
  `kogane.card-settlements.debit-accounts`, so it needs the owner's approval
  before merge (decision D3 of the 2026-11-19 MCP proposal v2). No catalogue
  operation is added.
- Date: 2026-11-19
- Tracking: [issue 1414](https://github.com/risu729/kogane/issues/1414)
  (task-level answers in one or two MCP calls),
  [issue 1415](https://github.com/risu729/kogane/issues/1415) (next debit
  date, amount and account), [issue 1357](https://github.com/risu729/kogane/issues/1357)
- Related: [ADR 0019](0019-dated-reported-state.md) (reported state on a
  date), [ADR 0081](0081-ui-parity-through-mcp.md) (UI/MCP parity),
  [ADR 0004](0004-payment-type-shapes-from-evidence.md), INV03, INV05,
  INV06, INV07

### Context

The owner asked (issue 1414, 2026-11-19) for answers to everyday questions in
one or two MCP calls, each under the 8 KB an MCP client shows. "How much is my
next card bill, from which account, and will that account cover it?" took
`card-settlements.debit-accounts` (about 1 KB of evidence per card),
`reported-state.read` (every account's figures) and arithmetic in the client.
The debit-account read already carries each card's newest current statement
(`latestStatement {period, paymentDate, amount}`) and its answer. What was
missing: which statements are still to be paid, readable labels, the debit
account's balance, and a comparison done with exact decimals on the server.

What the stored data proves, and what it does not:

- Both card sources store the statement month (`period`), the provider's due
  date (`_kogane.paymentDate`: Vpass `shiharaiDate`, the MyJCB
  `お支払い金額合計` heading) and the total. Neither stores a closing date,
  so the answer names the statement month and never a closing date
  (ADR 0004).
- Vpass statements without a readable due date exist in the store (the
  importer era). Whether such a statement is still to be paid is unknown.
- Bank balances are provider figures in the reported state (ADR 0019). The
  reported state is keyed by source account, the debit-account answer by
  bank source account, and an account entity can have several references.
- Nothing models a bank account's other debits and credits (salary,
  utilities, transfers).

### Options considered

1. **A view of the existing read, over the services that already answer each
   part (chosen).** `kogane.card-settlements.debit-accounts` with
   `view: "upcoming"` (route `?view=upcoming`): one application service that
   calls `reviewCardDebitAccounts` and `queryDatedState` and adds one keyed
   read of account labels.
2. **A new tool `kogane.cards.upcoming-bills`.** Rejected in the review of
   proposal v2: a second catalogue operation for a projection of an existing
   read, and one more tool for a client to choose between.
3. **Store each card's next bill in a table written by a lane.** Rejected for
   the reason of this ADR's option 3: a writer for a projection of
   append-only evidence, stale between ticks.
4. **Compare each bill alone with the balance.** Rejected: two bills from one
   account due on nearby days would each fit a balance that cannot pay both.

### Decision

`reviewUpcomingCardBills` (`packages/application/src/query/card-upcoming-bills.ts`)
answers for today's date in Asia/Tokyo, under rule `card-upcoming-bills-v1`
(`packages/domain/src/card-upcoming-bills.ts`, pure):

1. **Bills.** A bill is a card's newest current statement (this ADR's
   `latestStatement`) whose provider due date is on or after the date and
   whose total is not an exact zero or below. Every other card is in
   `notListed` with its last statement and a closed reason: `no_statement`,
   `payment_date_not_published`, `no_statement_due`, `statement_settled` (an
   accepted settlement of the card already covers that statement month), or
   `statement_total_refund_or_zero` (an exact total of zero or below: a
   refund, or nothing to pay; the code and predicate `refundOrZeroTotal` of
   the [unmatched statements](../card-settlements.md#unmatched-statements),
   reused rather than restated). Nothing is debited for such a statement, and
   whether a refund reaches the bank account is not observed (ADR 0004), so
   it is never summed into a line. A total that is not exact has no known
   sign: it keeps its status and reason (the 2026-11-18 amendment), stays a
   bill, never zero (INV05), and makes its lines `unknown`
   (`bill_not_exact`).
2. **Debit account.** Each bill carries the card's answer: `answer` (the
   basis, or `unknown`), the bank `sourceAccount` it names, the account
   entity and its label, `since` (the stated page's capture date or the
   accepted debit date) and the answer's codes (its notes, or its unknown
   reason). The entity is the one the reported state maps that bank source
   account to, when it maps it to exactly one; its references are the
   reported-state entries of that entity. Labels are `accounts.label`. Vpass
   card product names are not shown yet (proposal v2, Unit F).
3. **Lines.** `byDebitAccount` has one line per debit account (the entity,
   else the bank source account; bills with no known account share a line
   whose `account` and `sourceAccount` are null) and debit date. A line counts
   every bill to that account due on or before its date, and `cardBills` is
   their sum through `sumQuantities` (INV03). A bill that is not exact makes
   the sum `missing` with `bill_not_exact`.
4. **Balance.** The `deposit.balance` of the entity's references in the
   reported state for the date (ADR 0019), in the bills' unit, from the
   newest capture. References are one account, so balances are never summed
   (INV06). Two references captured together that disagree are `conflict` /
   `balances_disagree`; no balance is `missing` / `balance_not_reported`; a
   reported-state read past its row bound makes every balance `missing` /
   `reported_state_limit_exceeded` rather than refusing the view.
5. **`covers`** (closed): `yes` (balance at least `cardBills`) or `no`,
   compared with `compareQuantities`, only when both are exact and no reason
   holds. Otherwise `unknown` with its reasons, in this order:
   `debit_account_unknown`, `bill_not_exact`, `balance_not_exact`,
   `balance_before_previous_debit` (the balance was captured on or before the
   Asia/Tokyo date of the latest card debit from the account due on or before
   the date: an accepted settlement's debit, or the due date of a statement
   already due of a card the account answers for, so the balance may not show
   it), `cards_with_unknown_account` (a bill due on or before the line's
   date has no known account and might be debited from this one) and
   `cards_with_unknown_due_date` (a card debited from this account, or from
   an unknown one, has a newest statement with no readable due date that no
   accepted settlement pays: whether and when it is debited is unknown, so
   its total is never left out of the comparison as if it were zero,
   INV05). Every line carries the note `other_debits_not_modelled`: only
   known card bills are compared with the provider's balance.

The `カード照合` page's `次回の引落` section
(`GET /api/v2/reconciliation/card-debit-accounts?view=upcoming`, operator-only)
and the MCP tool with `view: "upcoming"` are adapters over that one function
(ADR 0081). The route takes `view=upcoming` and no other parameter; the tool
takes `{ view?: "upcoming" }`. Both grade the grant through
`reviewCardDebitAccounts` (`records.read` over the whole store, the card
bound) before anything is read. The view only reads: no table, lane, writer,
command or catalogue operation is added.

### Consequences

- One call answers "next debit date, amount, debit account, does it cover".
  Ten cards with labels measured 5.7 KB in the synthetic test, which asserts
  under 8 KB.
- Until proposal v2's Unit A ships, the Vpass collector's finalized
  statements are not parsed (every unit is `partial`), so a Vpass card whose
  newest parsed statement is already due reads `no_statement_due` with that
  statement. The answer says so instead of listing no card.
- `covers: yes` is not a forecast: other debits from the account, deposits
  before the debit date and unbilled card usage are not modelled, as the note
  on every line says.
- A Vpass card without an accepted settlement is on the unknown line, and its
  bill makes the account lines due on or after it `unknown`
  (`cards_with_unknown_account`).
- A card whose newest statement has no readable due date (an importer-era
  Vpass row) and no accepted settlement makes every line of its account, or
  every line when its account is unknown, `unknown`
  (`cards_with_unknown_due_date`). Added in review: before it, such a
  statement was left out of the comparison, so its account could read `yes`.
  Only the card's newest statement counts, so it lasts until the card has a
  newer statement with a due date or a settlement paying that statement is
  accepted. A card with no newer statement (a closed one) keeps it until the
  settlement is accepted, and no age bound applies (unlike ADR 0019's
  `UNDATED_STATEMENT_WINDOW_DAYS` for payables): a statement with no due date
  is never taken as paid. Until Unit A ships, a Vpass card whose newest parsed
  statement is an importer-era row with no due date does this, and a Vpass
  card with no accepted settlement has no known account, so every line reads
  `unknown`.
- A refund or zero statement is not a bill (`statement_total_refund_or_zero`).
  Fixed in review: before it, a negative exact total was summed into
  `cardBills` and offset the other cards' bills to the same account, so a
  refund of 5,000 beside a bill of 30,000 read 25,000 and `yes` against a
  balance of 26,000, though the bank debits the 30,000. Leaving the credit
  out can only raise a line's `cardBills`, so it never makes a `yes` the
  figures do not carry. The page's wire contract
  (`validUpcomingCardBills`) refuses a bill with an exact total of zero or
  below. A line that read `unknown` only because a refund
  with no known account was a bill due by its date
  (`cards_with_unknown_account`) can now read `yes` or `no`: nothing is
  debited for the refund. If a provider were seen to credit a
  refund to the bank account, the balance would understate what pays the
  bills and a line could read `no` where the bank pays: conservative, and
  unmodelled until observed. A refund statement whose due date is not
  readable still counts as `payment_date_not_published` and makes its lines
  `unknown` (`cards_with_unknown_due_date`), as any undated statement does.
- A bank source account is joined to its entity only through the reported
  state; one with no balance or position there keeps its own line, so an
  entity's line does not count bills named through it. A statement due
  before the date is taken as debited on its due date; a later debit (the
  next business day) is not modelled.
- Cost: the debit-account read (this ADR's cost), the reported state for the
  date (ADR 0019's reads, each bounded by `DATED_STATE_ROW_BOUND`) with its
  settlement read, and `ACCOUNT_LABELS_SQL` (one primary-key lookup per entity
  named). The reported state reads every account, not only the debit
  accounts: the price of reusing its snapshot rules rather than restating
  them.
- The published schema of `kogane.card-settlements.debit-accounts` gains an
  optional `view` and its description a paragraph. This is an owner approval
  item before merge (D3); no catalogue entry changes.

### Verification

- `packages/domain/test/card-upcoming-bills.test.ts`: which statements are
  bills, and each `notListed` reason; a refund beside a bill on one account
  (the bill alone is summed and the line reads `no`, the refund is in
  `notListed`), a zero total that is not a bill beside a positive one that
  is, a total that is not exact staying a bill beside a refund that does
  not, and a refund with no known debit account leaving no line `unknown`
  while an undated one keeps `cards_with_unknown_due_date`; `yes` and `no` on exact figures, with an equal balance covering; a
  later line counting the earlier bills; each `unknown` reason and their
  order; the unknown-account line; a statement with no due date that no
  settlement pays, on its own account and on an unknown one.
- `packages/application/test/card-upcoming-bills.test.ts`: on a synthetic
  store with the CORE migrations, an exact bill its account covers, one it
  does not, one with no known account, one not exact, a provider that
  published no due date (paid by a settlement, and not), a card with no
  statement due, a refund statement beside another card's bill to an account
  that does not cover the bill, a balance captured before the previous debit
  and one not reported, and an entity with two references: the newest
  capture is taken, never the sum, and two disagreeing captures at once are
  a conflict. The answer passes the wire contract through the route's
  dispatch, and a contradicting `covers`, a silent `unknown` or a bill with
  an exact total of zero or below is refused; ten cards stay under 8 KB; the read writes nothing, issues only the reads it composes, is
  refused before reading under a narrowed grant, and reaches labels by key
  without table statistics.
- `services/app/test/card-debit-accounts-api.test.ts`: the route, the agent
  route and the MCP tool give the same answer; other views and parameters
  are refused on both; the audit record counts the bills and the cards not
  listed.
- `services/app/test/ui-mcp-parity.test.ts`: the mapped route's view is the
  tool's one view, and the published description names it.
- `apps/web/test/card-settlement.browser.test.ts`: the `次回の引落` section
  shows the bills, lines and reasons, offers no action, passes the
  accessibility audit, and refuses a `covers` its figures do not carry.
