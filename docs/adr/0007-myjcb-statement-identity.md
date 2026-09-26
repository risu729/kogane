# ADR 0007: Key MyJCB confirmed statements by the payment month the page names

- Status: accepted (implementation in flight)
- Date: 2026-09-26
- Implemented by: #255 (open at the time of writing, branch
  `claude/myjcb-stable-statement-identity-wr8pj4`)
- Carried by (in that PR): `docs/observations.md` ("MyJCB statements keep
  their identity when their position moves"), `creditStatementPeriod` in
  `services/collector-myjcb/src/parsers.ts`, `myjcbStatementMonth` in
  `packages/read-model/src/sql.ts`

## Context

The MyJCB collector records every credit month the past-months API does not
label under its position, `detailMonth-N`. That period is the artifact's
metadata, the snapshot slot of confirmed captures, and an input of
`myjcb-credit-ledger`'s row fingerprint, so of each row's external id and
recognition key. When the next statement closes, the newest closed one moves
from position 1 to position 2 and its rows get new keys: the purchase lane
retires every event of the statement and recognises the same purchases again
every month. One slot per position could also keep a statement current twice,
once from its position-1 capture and once from its position-2 capture.

## Options considered

1. **A stable statement key in the read model only.** Recognition keys cannot
   leave the external id: 0047's key guard requires each key to equal the row's
   own five-element `json_array`. A new key shape needs a schema migration and
   gives every existing MyJCB event a new key; carrying events over to new keys
   instead needs a revision per row per month, and the month for position 2
   from a different artifact published on its own schedule. Rejected.
2. **A parser release deriving the external id from a stable key.** A parser
   sees one artifact, and the ledger artifact names no month: it could resolve
   positions 0 and 1 from `fetched_at` ([ADR 0003](0003-relative-period-labels.md)),
   fixing an interpretation into an identity, but not position 2, where the
   churn is. It would also re-key every existing MyJCB event. Rejected.
3. **The collector records the month a confirmed page names.** A closed page
   carries the `(確定分)` heading ([ADR 0005](0005-myjcb-statement-state-from-page.md))
   and names its payment month in `<h2>YYYY年M月お支払い分のカードご利用明細</h2>`.
   Chosen.

## Decision

- The collector records that month, `YYYY-MM`, as the period of the page, its
  ledger and its exports. The ledger parser is unchanged, so a statement's
  rows hash to the same external ids at every position. The position stays
  recorded beside it. This is the page's own statement, not a relative label
  resolved at collection time. Unconfirmed and `unknown` pages keep
  `detailMonth-N`. A confirmed page naming no month, or more than one, stops
  the collection (`credit-statement-period`).
- The read model gives each confirmed statement one snapshot slot, its payment
  month: an absolute period, or `detailMonth-0`/`detailMonth-1` resolved by
  `relative-statement-period-v1`. A confirmed `detailMonth-N` with N ≥ 2 names
  a position, not a statement, and is never current.
- **Deploy order**: the processor (read model) with or before the collector.
  The collector alone would put a statement's named capture in a slot beside
  its `detailMonth-1` capture.

## Consequences

- Nothing stored is re-parsed or rewritten. A statement recorded as confirmed
  under `detailMonth-1` is superseded once by its first capture under the
  named month (one statement per connection, two if a month boundary passes
  between the deploys): its events retire once and are recognised once, and
  the captured total counts them once throughout.
- A current confirmed `detailMonth-N` (N ≥ 2) capture with rows stops being
  current and its events retire; where the same statement is current from its
  position-1 capture, that removes a double count.
- Rolling back the collector restores the relative labels and the churn; the
  read model's slots hold either way.

## Verification

In the PR, on synthetic data: `services/collector-myjcb/test/credit-statement-state.test.ts`
(the recorded period), `packages/read-model/test/card-usage.test.ts` and
`card-purchase-keys.test.ts` (the slot), and
`services/processor/test/myjcb-statement-identity.test.ts` (a closed statement's
events untouched from position 1 to 3, and each pending row retired and
recognised as captured once).
