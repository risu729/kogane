# ADR 0009: Lane tick records are bounded operational state

- Status: accepted
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
