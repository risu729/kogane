# ADR 0005: Decide the MyJCB statement state from the page, not export links

- Status: accepted
- Date: 2026-09-25
- Implemented by: #248
- Carried by:
  [observations](../observations.md#myjcb-statement-state-from-the-page-statement-parser-110),
  `creditStatementState` in `services/collector-myjcb/src/parsers.ts`,
  `readMyJcbStatementPage` in `packages/domain/src/myjcb-statement-page.ts`

## Context

The MyJCB collector treated `detailMonth` 0, and 1 without export links, as
`unconfirmed`. The surveyed connection offers no export links in any month, so
position 1, the newest closed statement, was always recorded as
`unconfirmed`, although every production capture of that page carries exactly
one `<h1>カードご利用代金明細(確定分)</h1>`. Statement parser 1.0.1 rejected
every position-1 page, and recognition treated its posted charges as
`authorized`.

## Options considered

1. Keep export links as the signal. Rejected: it is wrong on the surveyed
   connection.
2. Re-state the stored rows in a ledger parser release. Rejected: a ledger
   artifact holds no page evidence, the snapshot slot comes from append-only
   artifact metadata, and the state is part of each row's external id, so a
   re-stated row would be a new key.
3. Read the state from the page with a position-aware rule that the collector
   and the statement parser share. Chosen.

## Decision

- Only the `(確定分)` heading states that a page is closed. The ledger amount
  labels (`今回のお支払い金額` for confirmed, `ご利用金額` for unconfirmed)
  must agree with it.
- Position 0 is always `unconfirmed`. A page without the heading whose ledger
  is missing or has no rows is `unknown` and gets no ledger artifact. A page
  that contradicts itself stops the run with `credit-statement-state` at any
  position.
- Older positions do not stop the run: every production run captured
  positions 7 and 8 with empty ledgers and no heading.
- `readMyJcbStatementPage` is the one reader of headings, rows and labels.
  Statement parser 1.1.0 uses it, and the collector manifest's state becomes a
  cross-check only (`statement_state_differs_from_manifest`).

## Consequences

- Stored position-1 rows stay `unconfirmed` observations, the record of what
  the collector said at the time; they stop being current on the first run of
  the fixed collector.
- Position 0's pending rows are no longer displaced from the connection's one
  unconfirmed snapshot slot by position 1.
- The next position change of a statement (1 → 2) still changed its keys until
  [ADR 0007](0007-myjcb-statement-identity.md).

## Verification

Collector, parser and processor tests on synthetic pages. The production
evidence was read as counts only.
