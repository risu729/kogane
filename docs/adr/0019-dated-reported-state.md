# ADR 0019: Reported state on a date from the latest complete capture before it

- Status: proposed
- Date: 2026-09-26
- Implemented by: P2-1 of the
  [next-milestone plan](../plans/2026-09-next-milestone.md)
- Carried by: [reported state](../reported-state.md),
  `packages/parsers/src/snapshot-query.ts` (`cutoffParam`),
  `packages/read-model/src/dated-state.ts`,
  `packages/domain/src/reported-state.ts`,
  `packages/application/src/query/dated-state.ts`

## Context

Phase 8 asks what each provider reported at a point in time, including
positions, provider valuations and card payables, not only today's cash
balances ([roadmap](../roadmap.md#phases-8--11--dated-reported-and-reconstructed-state)).
The current-state reads already choose one complete container snapshot per
partition (policy table, coverage claims, published parses), but only the
newest one. The plan's binding decisions 4.1 (what "reported state on D"
means), 4.2 (perimeter) and 4.5 (reproducibility) were proposed there and are
recorded here as they apply to this first slice; 4.3 and 4.4 (price promotion
and valuation) belong to P2-2 and P2-3.

## Options considered

1. Filter observations by their own `as_of`. Rejected: `as_of` is optional,
   provider-shaped and says nothing about container completeness; a position
   missing from a later capture would still look held.
2. A stored daily projection. Rejected for now: it needs a new table, rebuild
   triggers and a migration, and the per-request read measures under the
   one-second target (below).
3. The latest complete snapshot per container partition captured before
   `(D+1) 00:00` Asia/Tokyo, chosen by the existing snapshot rules through a
   `cutoffParam` option. Chosen.

## Decision

1. **Reported state on D** (4.1) is, per container partition, the latest
   complete snapshot with `observation_fetch_artifacts.fetched_at` before
   `(D+1) 00:00` Asia/Tokyo, compared as the UTC text the column stores. A
   dataset snapshot counts when its newest artifact is before the cutoff, so a
   run that crossed midnight is never split. Without `cutoffParam` the snapshot
   SQL is byte-identical to the shipped text.
   - Freshness `dated-state-freshness-v1`: `same-day` (captured on D in Tokyo),
     `recent` (1–3 days before), `stale` (more).
   - A container without a snapshot is a named coverage entry, never a zero.
2. **Perimeter** (4.2), `dated-state-perimeter-v1`: every selecting policy row
   and the artifact containers, except `sbi-account-assets-current` and
   `sony-bank-gross-balance` (provider aggregates over listed accounts).
   MoneyForward, balances restated after each transaction (registry
   `event-reported`) and reward units are excluded and named. Card payables
   come only from the Vpass and MyJCB statement parsers (`card_statement_facts`
   restated with the cutoff; the view is unchanged). A payable is settled on D
   only by an accepted settlement review whose bank debit is on or before D.
3. **Reproducibility** (4.5): every answer carries a manifest (date, cutoff,
   policy ids, snapshot artifacts, statement observations, settlement reviews)
   and `contextId = canonicalDigest(manifest)`. Nothing is stored yet; fixed
   reports reuse the existing report tables when P2-4 needs them.
4. **No sums.** The answer lists provider figures per provider account with
   their registry metric and aggregation rule; it has no total, subtotal or net
   worth, `liabilitiesCoverage` is always `partial` with the missing kinds
   named, and the wire contract refuses anything else.

## Consequences

- The current-state reads are untouched; the dated reads compose their own
  `dated_`-prefixed CTEs.
- Identity, mappings and settlement reviews are today's: correcting a mapping
  changes an earlier date's answer and its `contextId`. Dated identity is not
  modelled.
- Adoption across sources is not applied, so two providers reporting one
  holding both appear; P2-3 applies `selectAdoptedSet` before valuing anything.
- No migration: measured without an index (below).

## Verification

`packages/parsers/test/snapshot-cutoff.test.ts` (unchanged text without the
option), `packages/read-model/test/dated-state.test.ts` (cutoff, incomplete,
complete-empty, vanished position, artifact containers, identity, statements
as of the cutoff equal to the view past every capture),
`packages/application/test/dated-state-query.test.ts` (freshness, missing
values, exclusions, coverage, payable transitions, bounds),
`packages/application/test/dated-state-scale.test.ts` (plan checks without
statistics; 398 ms today and 346 ms a year back at `STATEMENT_SCALE` on
`bun:sqlite`), `services/app/test/reported-state-api.test.ts`, and the web
contract and browser tests, all on synthetic data.
