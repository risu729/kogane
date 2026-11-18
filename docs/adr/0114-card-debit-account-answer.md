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
