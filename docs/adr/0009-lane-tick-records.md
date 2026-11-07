# ADR 0009: Lane tick records are bounded operational state

- Status: accepted; the
  [2026-11-06 amendment](#amendment-2026-11-06-the-settlement-sweep-counts-its-unmatched-statements)
  is proposed until the PR that carries it merges
- Date: 2026-09-25
- Implemented by: #249
- Carried by: [processor §6.1](../processor.md#61-tick-records),
  [infra ledgers](../infra-ledgers.md),
  `packages/storage-d1/migrations/core/0049_processor_lane_ticks.sql`,
  `services/processor/src/lane-ticks.ts`,
  `REVISION_EXCLUDED_TABLES` in `packages/read-model/src/source-revision.ts`

## Context

The lanes that keep no state of their own (`purchase_recognition`,
`reconciliation_sweep`, `card_settlement_sweep`, `identity_sweep`,
`reward_claims_sweep`, `operation_dispatch`, `decision_outbox`) left only a
Workers Logs line per tick, so whether a lane had run could only be read from
logs. The card settlement sweep ran inside the reconcile stage, so a failure
of either sweep hid the other's counts.

## Options considered

1. Keep relying on Workers Logs. Rejected: the answer to "did it run?" was not
   queryable.
2. An append-only history table. Rejected: one row per lane per five minutes
   grows without bound and would make every tick a source-revision change.
3. A bounded, operational table of counts only. Chosen.

## Decision

- One row in `processor_lane_ticks` per tick of each of those lanes: start,
  end, outcome (`ran`, `skipped-by-flag`, `failed` with a safe code) and
  `counts_json`.
- `counts_json` holds counts, flags and closed reason codes only; a trigger
  refuses any text value, so no amount, label, key or provider wording fits.
- Bounded to the latest 288 rows per lane (one day of the five-minute cron),
  pruned in the same batch as each insert. A row is never updated, but deletes
  are allowed for pruning: the table is classified `operational-mutable`, with
  a `*_no_update` guard and no `*_no_delete` guard, so it is not append-only.
- It is excluded from the source-revision ledger: recording that a lane ran
  changes nothing a projection reads.
- `card_settlement_sweep` is its own lane under the same
  `RECONCILIATION_ENABLED` flag, with its own log line and tick rows.

## Consequences

- `/internal/health` and `/status` report the latest tick per lane
  (`laneTicks[]`); older ticks are read from D1 for one day.
- A tick that cannot be recorded logs `lane_tick_record_failed` and changes
  nothing the lane did.
- The migration was renumbered from 0048 to 0049 because #243 took 0048.

## Verification

Storage, read-model and processor tests on synthetic data, including the
refusal of text values and of repeated count keys.

## Amendment 2026-11-06: the settlement sweep counts its unmatched statements

- Status: accepted (merged 2026-11-06 in #947)
- Date: 2026-11-06
- Carried by: `CARD_SETTLEMENT_UNMATCHED_CODES` and `cardSettlementSweep` in
  `services/processor/src/card-settlement-job.ts`, `LANE_TICK_COUNTS` in
  `services/processor/src/lane-ticks.ts`,
  [card settlements: unmatched statements](../card-settlements.md#unmatched-statements),
  [processor §6.1](../processor.md#61-tick-records)

### Context

`card_settlement_sweep` proposes a candidate only for a single debit whose
exact amount equals the statement total within three days of its due date.
A statement that yielded none left no trace: its counts said how many rows
were scanned and how many candidates were written, not how many statements
had none or why. A statement settled by two debits, a partial payment, a
statement with no debit at all and one that could not be compared were the
same silence in the log line and in its tick row.

### Options considered

1. A table of unmatched statements. Rejected: it would be a new record per
   statement per pass, carry statement references into an operational table,
   and need a migration, a ledger classification and retention, for a
   question a count answers.
2. Name the shape (two debits, partial payment) by summing or comparing the
   window's debits. Rejected: that is an allocation the sweep does not make;
   it would sum amounts outside the reviewed planner and guess a meaning no
   rule states.
3. A closed code map in the existing result, kept by this ADR's tick record.
   Chosen.

### Decision

- The sweep's result carries `unmatched`, a map of three closed codes to the
  number of statements examined this tick that yielded no candidate:
  `statement_not_comparable` (no exact positive total, no valid due date or
  no period), `no_debit_in_window` (the window read returned no row) and
  `no_equal_amount_debit` (it returned rows, none of an exact equal amount).
  Every code is present, zero included.
- The codes are decided from the rows the sweep already reads, after it has
  compared them: no query is added, and the candidates, their digests and
  the existing counts are unchanged.
- `processor_lane_ticks` keeps the map like `purchase_recognition`'s
  `skipped`: by name, only the closed codes, and only safe non-negative
  integers. No amount, date, key or provider text is recorded.

### Consequences

- The log line, the tick row and `laneTicks` in `/status` and
  `/internal/health` (relayed by the App's ops health) carry the map with no
  further change and no migration.
- The counts are per tick: the sweep's cursor wraps, so a statement is
  counted again on every pass, and the numbers are not a store-wide total.
- The codes do not say why a statement is unmatched: a statement paid by two
  debits and a partially paid one are both `no_equal_amount_debit`, and a
  statement paid outside the three days or from a bank without an adapter is
  `no_debit_in_window` when no other debit falls in its window (and
  `no_equal_amount_debit` when one does). The bank read stops at 1,000 rows;
  a statement whose window holds more counts as `no_equal_amount_debit` when
  none of those rows matches.

### Verification

`services/processor/test/card-settlement-unmatched.test.ts` runs the sweep on
synthetic rows: a statement settled by two debits and a partial one are
`no_equal_amount_debit`, an equal debit four days late and no debit are
`no_debit_in_window`, a missing total, a missing due date, a zero total and a
total with no valid unit are `statement_not_comparable`, and an exact match
writes the candidate and digest the sweep wrote before the map existed. Its
tick row holds closed codes and integers only.
`services/processor/test/lane-ticks.test.ts` checks that a code outside the
closed set is dropped from the row and from `/status`.

## Amendment 2026-11-07: refund and zero totals get their own code

The settlement sweep's `unmatched` map gains a fourth closed code,
`statement_total_refund_or_zero`, for a statement whose exact total is zero
or below (a refund, or a month with nothing to pay). Before this, such a
statement counted as `statement_not_comparable`, which read like a parse
problem; refund allocation is in fact unsupported (ADR 0004, #548), and the
code now says so. The codes are checked in order: refund or zero, then not
comparable, then the two window codes. The classification moved to
`unmatchedStatementCode` (`packages/domain/src/card-settlement-unmatched.ts`)
so the review read of statements without a candidate
([card settlements](../card-settlements.md#statements-without-a-candidate))
names the same code the tick counts. Nothing else changes: no query is
added, candidates and digests are the same, and the tick row still keeps
only the closed codes and their counts (Phase 2 plan unit 2e, approved by
the owner 2026-11-07 03:58 UTC).

Verification: `services/processor/test/card-settlement-unmatched.test.ts`
counts a zero total, a refund and a refund without a due date as
`statement_total_refund_or_zero`, and the other shapes as before.
