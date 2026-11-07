# ADR 0079: Index pending parse runs so the sweep's maintenance reads only them

- Status: accepted (owner approved 2026-11-07 13:39 UTC)
- Date: 2026-11-06

## Context

Every sweep starts with `maintenance` (`services/processor/src/worker.ts`). Its
second statement marks a pending parse run `error` with `parse_interrupted`
once the job that started it failed for good:

```sql
UPDATE parse_runs SET status='error',error='parse_interrupted'
WHERE status='pending' AND EXISTS(SELECT 1 FROM observation_parse_jobs j WHERE ...)
```

No index of `parse_runs` serves `status='pending'` (its one partial index,
`idx_parse_runs_success`, holds the `ok` runs). D1 never runs `ANALYZE`, and
without statistics SQLite planned the statement as `SCAN parse_runs`: every
parse run ever written, on every sweep, to find the few still pending. Parse
runs are evidence and only grow (16,056 published parses in the scaled store
of [card settlements: cost](../card-settlements.md#cost)). The lanes are documented as bounded per
sweep (docs/observation-lanes.md); this statement was not.

The scan was found by the plan check of one whole scheduled tick
(`services/processor/test/tick-query-plan.test.ts`), which explains every
statement a tick prepares on the complete CORE schema without statistics.

## Options considered

1. Leave it and document the scan as a limit: rejected; it is the one
   statement of the sweep's fixed overhead that grows with the whole history.
2. Rewrite the statement (for example drive it from failed jobs): a query
   rewrite needs the proof process (frozen legacy SQL, differential tests,
   plan checks) for a statement whose text is correct; not needed when an
   index alone changes the plan.
3. A plain index on `parse_runs(status)`: one entry for every parse run,
   almost all of them `ok` or `error`, to serve a predicate that selects the
   pending few.
4. A partial index holding only pending runs: the planner reads it whole and
   probes the failed job per row, exactly as before; its size is the number of
   parses in flight.

## Decision

Migration 0083 adds
`parse_runs_pending ON parse_runs(fetch_artifact_id, parser_name, parser_version) WHERE status='pending'`.
The statement text is unchanged. Without statistics its plan becomes
`SCAN parse_runs USING COVERING INDEX parse_runs_pending`, then the same
`SEARCH j USING INDEX sqlite_autoindex_observation_parse_jobs_1` per pending
run.

## Consequences

- The maintenance repair reads the pending runs only. A parse run enters the
  index when it is written pending and leaves it when it becomes `ok` or
  `error`; no evidence row, view, trigger or statement changes.
- Each pending parse write and its completion also write the index entry: one
  index write per parse, against one fewer full read of the table per sweep.
- `tick-query-plan.test.ts` accepts the scan of the partial index by name; if
  the planner stops using it, the test fails.

## Verification

- `services/processor/test/tick-query-plan.test.ts`: the tick's statements,
  this one included, on every CORE migration without statistics.
- `mise run ledger:schema` regenerated `infra/schema/core-ledger.*` (one more
  explicit index, no new table); `services/processor/test/lanes.test.ts` pins
  the migration list through 0083.
- Not measured on remote D1: the rows read per sweep before and after.
