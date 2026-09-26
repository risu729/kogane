# ADR 0003: Relative period labels are evidence; the month is derived afterwards

- Status: accepted
- Date: 2026-09-25
- Implemented by: #242
- Carried by:
  [observations](../observations.md#relative-period-labels-are-resolved-from-the-capture-time),
  `packages/domain/src/relative-period.ts`,
  `cardStatementPeriod` in `packages/domain/src/card-purchase.ts`

## Context

MyJCB's credit menu links `detailMonth=0..8`, and its past-months API labels
only months 9–17 with an absolute `settlementYM`, so the collector stores
`detailMonth-N` as the period of every other month. Recognition, the
settlement join and pending-to-posted matching need the payment month
`YYYY-MM`, the key `card_statement_facts.period` uses.

## Options considered

1. Resolve the label at collection time and store the month. Rejected: the
   stored evidence would no longer be what the provider showed, and a wrong
   rule could not be corrected by deriving again from the same captures.
2. Read `detailMonth-N` as "N months before the capture month". Rejected: the
   production captures, read as aggregates, show that the index follows the
   provider's billing cycle, so that reading is off by one or two months.
3. Keep the label as raw evidence and derive the month afterwards with a
   versioned rule from the capture time. Chosen.

## Decision

Rule `relative-statement-period-v1`: let `d` be the civil date in Asia/Tokyo
of the `fetched_at` of the artifact that carries the label. `P0` is the month
of `d` plus 1 on days 1–15, and plus 2 from the 16th.

- `detailMonth-0` is `P0`, the statement still accumulating;
- `detailMonth-1` is `P0 − 1`, the newest closed statement;
- `detailMonth-N` for N ≥ 2 is not resolved (null, never a guess).

A label is never resolved at collection time and never rewritten. A derivation
changes no stored label, parser version or observation digest, and a corrected
rule is a new version derived from the same captures.

## Consequences

- The switch from `+1` to `+2` on the 16th is **not verified**. It follows
  JCB's published schedule (closing on the 15th); no capture yet falls on days
  12–30 to show when the provider's position 0 moves to the next cycle. A
  capture that contradicts it is corrected by a new rule version, never by
  editing v1.
- Rows at positions 2 and later have no period (`NULL` in the recognition
  sidecar), so the purchase lane groups MyJCB candidates by usage month.
- A confirmed page that names its own payment month is a different case, the
  page's own statement and not a resolution of a position:
  [ADR 0007](0007-myjcb-statement-identity.md).

## Verification

Synthetic data only; the rule is unit-tested in `packages/domain`. The
production evidence behind it was read as aggregates, with no date, amount or
merchant recorded.
