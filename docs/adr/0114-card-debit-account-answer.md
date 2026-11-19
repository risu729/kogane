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

## Amendment 2026-11-19: a statement is settled by the acceptance guard's identity

- Status: proposed
- Date: 2026-11-19
- Owner approval: required before merge. No field or type changes, but for
  the cards it affects the published answer of
  `kogane.card-settlements.debit-accounts` lists fewer `proposed` entries and
  can change `answer.reason` from `only_unreviewed_candidates` to
  `no_debit_account_evidence`; a change to a published tool's answer is the
  owner's to approve ([ADR 0081](0081-ui-parity-through-mcp.md)'s `nextPage`
  amendment, and the 2026-11-18 amendment above).

### Context

Decision 2 lists as `proposed` the undecided candidates "of statements no
accepted candidate covers". The read took "covers" to mean an accepted
candidate with the same `statement_key`. That key is
`[source, producer, namespace, source account, period]`, so one card month
read through two producers or namespaces, or under a new card ordinal
(`vpass:card-00N`) that resolves to the same account, has two keys. The
acceptance guard reads it differently: `card_settlement_readiness.allocation_available`
(migration 0044) reserves a statement for every other candidate when an
accepted one has the same `statement_key` or the same
`statement.sourceId`, `statement.accountId` and `statement.period` in its
facts. A candidate on the second key of an accepted card month was listed
as `proposed`, although the guard refuses it (`allocation_already_used`)
and no decision can ever accept it; a card entry with only such candidates
read `unknown` / `only_unreviewed_candidates`. A reviewer's synthetic probe
showed it; nothing was written and no amount moved.

### Options considered

1. **Keep the statement key.** The section offers, as open work, proposals
   no one can accept. Rejected.
2. **Cover a statement as the guard reserves it (chosen).** One identity
   for "settled" on the page, the tool and the acceptance.
3. **Also hide candidates whose bank debit another statement's accepted
   candidate holds**, the guard's third term. Their statement is not
   settled, so `proposed` would no longer say which statements are open.
   Not taken: the review still shows them with `allocation_already_used`.

### Decision

`CARD_DEBIT_ACCOUNT_CANDIDATES_SQL` counts a statement as covered when an
accepted candidate has the same `statement_key` (as before) or the same
`$.statement.sourceId`, `$.statement.accountId` and `$.statement.period`,
each compared with `=` as the guard compares them, so a fact absent on
either side covers nothing beyond the key. Accepted candidates are listed as
before; only the `proposed` filter changes.

### Consequences

- A candidate of a card month already settled under another statement key
  is no longer listed. Under a new card ordinal it belongs to another card
  entry, which reads `no_debit_account_evidence` instead of
  `only_unreviewed_candidates` when it has no other evidence; the accepted
  settlement stays on the old ordinal's entry.
- Every other answer is unchanged: where no proposal's card month is
  accepted under another statement key, the rows are the shipped text's. `schemaVersion`, the wire contract,
  the page and the tool description are unchanged.
- Cost: the covered months are built once from the candidates already
  scanned, and each proposal probes them by an automatic index; no base table
  is read again.

### Verification

- `services/processor/test/card-debit-accounts.test.ts`: on the complete CORE
  schema with the real sweep, a Vpass month accepted under one ordinal and
  re-read under a new one resolving to the same account: the guard refuses
  the new candidate, the read writes nothing, and the new ordinal's entry
  lists no proposal and reads `no_debit_account_evidence` (it listed the
  proposal and read `only_unreviewed_candidates` before the change); the
  plan reaches the months by key without table statistics on D1.
- `packages/application/test/card-debit-account-candidates-differential.test.ts`:
  on random stores, the read returns the frozen shipped text's rows
  (`card-debit-account-candidates-legacy-sql.ts`) less exactly the
  proposals the guard's month term reserves, which equals the shipped rows
  on seeds without such a proposal; every proposal it drops has
  `allocation_available` 0 in the real view; dropping any of the three month
  terms fails some seed.
- `packages/application/test/card-settlement-review-scale.test.ts`: on the
  scaled store without statistics, the same equality (the store draws no
  such proposal, so the shipped rows too), and a plan whose only whole read of
  a base table is the one candidate scan.
