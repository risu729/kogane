# ADR 0011: Resolve settlement ownership through keyed CTEs, keep the 0044 views as the contract

- Status: accepted; the review list follows in an in-flight PR. The
  [2026-11-06 amendment](#amendment-2026-11-06-the-ctes-depart-from-the-views-in-one-rule)
  is proposed until the PR that carries it merges, then accepted
- Date: 2026-09-25; amended 2026-11-06
- Implemented by: #251; the `card_settlement_readiness` reads in #256 (open at
  the time of writing, branch `claude/settlement-readiness-cost-wr8pj4`)
- Carried by: [card settlements](../card-settlements.md),
  `packages/read-model/src/card-settlement-ownership.ts`,
  `packages/storage-d1/migrations/core/0050_statement_fact_indexes.sql`

## Context

The card purchases page and the settlement sweep resolved each statement's and
debit's owner through `card_settlement_fact_ownership` (0044). Its source,
`current_identity_observations`, materializes the candidate identity runs of
every published parse and groups every identity of the kind before any key
applies, and D1 never runs `ANALYZE`. On a synthetic two-year store the first
purchases page took 2,436 ms and the sweep's bank read 3,465 ms per statement.

## Options considered

1. Change the 0044 views. Rejected: they are the reviewed contract of
   ownership, read by review and commit paths too; changing them needs a
   migration and re-verification of every reader.
2. A materialized ownership table. Rejected: another writer and another
   source of staleness for a read that can be made exact by keys.
3. Keep the views as the contract, and have each read name its statements or
   debits first and resolve owners through CTEs that apply the view's own text
   to those observations' parses only. Chosen.

## Decision

- `cardSettlementOwnershipCtes` computes the same rows as the view for the
  observations a caller names (`observed`), through `owned_runs`,
  `owned_candidates`, `owned_latest`, `owned_identity` and `ownership`.
- **Exactness**, not approximation: an identity observation's run belongs to
  that observation's own parse run (the `identity_observation_provenance`
  trigger of 0018), and a parse's candidate identity runs and latest policy
  depend on that parse alone. Restricting both to the parses that can hold an
  identity of a named observation therefore leaves every row the view would
  give it unchanged.
- Migration 0050 indexes the settlement-key expressions
  (`card_settlement_candidates_statement_period`), so the settlement read's
  text is unchanged and each statement's reviews are found by key.

## Consequences

- Measured medians on that store: first purchases page 2,436 → 665 ms,
  statement read 590 → 83 ms, settlement read 1,346 → 21 ms, sweep statement
  page 562 → 97 ms, sweep bank read 3,465 → 53 ms per statement.
- The review and commit reads of `card_settlement_readiness` still use the
  whole view (42 s for the first page of the `カード照合` list on that store);
  moving them is #256, in flight.
- `card_statement_facts` and `card_bank_debit_facts` still rank all of their
  rows per request.

## Verification

`card-settlement-ownership.test.ts` compares the CTEs with the view on random
stores (including identity runs whose Vpass binding stops being trusted), and
each caller's differential test compares its read with the shipped text;
`card-statement-scale.test.ts` and `card-settlement-scale.test.ts` fail on a
plan that reads the whole store's owners. Synthetic data only.

## Amendment 2026-11-06: the CTEs depart from the views in one rule

- Status: proposed until the PR that carries it merges, then accepted
- Date: 2026-11-06
- Carried by: `cardSettlementOwnershipCtes` in
  `packages/read-model/src/card-settlement-ownership.ts`,
  [ADR 0017's amendment](0017-card-purchase-review-commands.md#amendment-2026-11-06-a-later-proposal-never-replaces-a-relation-decision),
  [card settlements](../card-settlements.md)

The decision above keeps the 0044 views as the contract and has the CTEs
apply the view's own text. Under the views any later row of an owner's
relation retires a claim, a `proposed` one included, so a proposal could
remove an accepted owner or lift a dated claim's veto against INV07.
[ADR 0017's amendment](0017-card-purchase-review-commands.md#amendment-2026-11-06-a-later-proposal-never-replaces-a-relation-decision)
changes the CTEs so that only a later decision does, and leaves the views as
they are.

The views are no longer the contract any reader runs: every reader of
ownership and readiness, the review and commit paths included, uses the keyed
CTEs (`card-settlement-ownership.ts`, `card-settlement-readiness.ts`), and
`services/app/src/card-settlements-api.ts` only checks that the views exist.
Option 1's reason for keeping them (they were read by review and commit
paths) no longer holds, and rebuilding two views that nothing reads would
add a migration for no reader. The CTEs and the views agree on every store
where no proposal follows a decision of the same owner, which
`card-settlement-ownership.test.ts` checks on the random stores; on stores
with such a proposal it checks the CTEs against the same store without it.
