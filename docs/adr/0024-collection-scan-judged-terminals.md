# ADR 0024: The collection scan does not spend registrations on terminals already judged

- Status: proposed
- Date: 2026-09-26
- Amends: [ADR 0010](0010-terminal-registration-budget.md) (how the scan's
  per-tick registration count is spent; the operation budget is unchanged)
- Carried by:
  [processor §2](../processor.md#2-two-ways-in-one-use-case),
  [observation lanes](../observation-lanes.md),
  `services/processor/src/collection/index.ts`,
  `packages/application/src/collection/register-terminal.ts`,
  `packages/storage-d1/src/core/collection-runs.ts`,
  `services/processor/test/collection-scan-convergence.test.ts`

## Context

The Processor's `collection_scan` lane runs every five minutes. It lists one
R2 page of 25 terminals from its stored cursor and makes at most five
registration attempts per tick. Before this ADR, a `blocked` or `retryable`
answer counted against those five exactly like a registration, and the cursor
advanced only when the whole page had been dealt with.

Since 2026-09-12 most sources' terminals are refused: a terminal whose
producer has no route is `retryable` `inactive_ingest_route`
([ADR 0014](0014-collector-producer-ids.md) records why), and others are
blocked (`artifact_lineage_unstated`, `provider_run_failed`). A block is
write-once, and a retryable run is refused again on every attempt. With more
than five such terminals on one page, every tick spent its five attempts on
them and listed the same page again next time. Production aggregates on
2026-09-26 showed `pages_completed` = `cycles_completed` (4,371), cursor null,
`last_seen` 25: the scan had never left its first page, and only the R2
notification path registered new terminals. The two counters were equal
because every tick counted a page, and a held tick on the first page, whose
cursor is null, also counted a cycle.

The same stall reproduces on synthetic data with the code before this ADR:
30 terminals, the first three blocked and the next three retryable, 40 ticks
leave the cursor null, `pages_completed` and `cycles_completed` both at 40,
and none of the 24 routable runs sealed.

## Options considered

1. **Raise the attempt budget** (say, to 25, the page size). Rejected. It
   only moves the threshold: a page with more refused terminals than the
   budget stalls again, and with the page size as the budget every tick
   re-attempts every refused terminal, which for a retryable run means
   verifying its objects and calling the route check again, every five
   minutes, for nothing. Each such attempt costs operations of the shared
   invocation budget of 500 (ADR 0010), so enough refused terminals on one
   page would exhaust that budget instead and hold the page just the same.
   It also spends the budget `operation_dispatch` shares.
2. **Remember a position inside the page** (an R2 `startAfter` key instead of
   the list cursor). Rejected. It changes the cursor's meaning and the state
   table, and it does not stop the scan re-attempting the refused terminals
   on the next cycle; it only stops it re-attempting them on the same tick.
3. **Skip terminals that already have a row, whatever their state.** Rejected.
   A retryable refusal is about the deployment, not the evidence; a
   configuration fix must be able to take effect, which is why it is not a
   block in the first place.
4. **Answer a terminal CORE has already judged from its row, spend nothing
   on it, and retry a retryable one on a fixed interval.** Chosen.

## Decision

- **What counts as judged.** A listed terminal whose `collection_runs` row
  under the current `registration_contract_version` and the same terminal
  digest is
  - registered (unchanged: `already_registered`),
  - blocked (`blocked_code` set, or an unreadable terminal already recorded
    under the digest of the same bytes), or
  - `retryable`, with its newest `registered` stage recorded less than
    `RETRYABLE_RETRY_INTERVAL_MS` (24 hours) ago,

  is answered from CORE: `registerTerminal` returns the recorded verdict with
  `recorded: true`, attempts nothing and appends nothing. The scan counts it
  in `alreadyJudged` (a subset of its `blocked` and `retryable` counts) and
  it spends none of the tick's five registrations. Answering it costs the
  terminal read, the conditional insert, the row read and one or two stage
  reads (none for a blocked run): 81 operations for a page of 25 judged terminals in the test.

- **A terminal with no row is never skipped.** It is attempted, and its first
  verdict spends one of the five.
- **Retry schedule.** A retryable run is attempted again when the walk reaches
  it and its last attempt is 24 hours old or more. An attempt refused again
  appends one `registered` `retryable` row (before this ADR only a change of
  state or code appended one), so the newest row's `recorded_at` is the last
  attempt and the interval is measured from it. A retry spends one of the
  five, like any real attempt. So the scan attempts a retryable run at most once
  a day and at most once per walk, and appends at most one stage row a day
  for it.
- **Blocked runs are never attempted again** under the same registration
  contract version. The block is write-once; a new contract version is a new
  identity, so a new row, and the terminal is judged again then.
- **The queue consumer is unchanged.** It passes no interval, so every
  delivery is a real attempt; the queue's `max_retries` bounds it.
- **The cursor advances past a page that is wholly judged**, even when nothing
  on it registered, because nothing on it spent the budget.
- **Counters count what they say.** `advanceCollectionScan` takes
  `pageFinished`: a tick held by its budget leaves the cursor,
  `pages_completed` and `cycles_completed` as they were, and records only
  `last_scan_at_ms` and its `last_*` counts. A cycle is counted only when a
  finished page ends the walk. No column changes, so no migration:
  `collection_scan_state` stays `operational-mutable`.
- **Bounds kept.** 25 keys per list, at most five continuations and five
  attempts per tick, the invocation's 500 operations (ADR 0010). The log line
  gains one count, `alreadyJudged`; `collection_scan` keeps no
  `processor_lane_ticks` row (ADR 0009), and that is unchanged.

## Consequences

- **Right after deploy.** The first page holds terminals from 2026-09-12 to
  2026-09-26. Its blocked terminals already have rows and are answered from
  them on the first tick. Its retryable terminals' newest `registered` rows
  are older than 24 hours, so each is attempted once more, five per tick, and
  refused again; each such attempt appends one row and starts its interval.
  The page is finished within a few ticks and the scan moves on to the rest
  of the prefix, registering the terminals with no row that it finds there,
  five per tick.
- **The producer-mismatch terminals never register.** A terminal is immutable
  and keeps the producer it was written with (ADR 0014), so those runs stay
  `retryable` `inactive_ingest_route` and are attempted about once a day each,
  appending one stage row per attempt. That growth is bounded by the number
  of such terminals per day; stopping it would need the operator to route
  that producer, a contract version change, or a decision to block them,
  none of which this ADR makes.
- **A configuration fix takes up to a day** (plus one walk) to reach a
  retryable run through the scan; a fresh delivery through the queue is still
  attempted at once.
- A page with more than five terminals that have no row still takes more than
  one tick, and the new ones are still registered in listing order; nothing
  about that is changed.
- `pages_completed` and `cycles_completed` read before this deploy counted
  ticks; from this deploy on they count finished pages and walks.
  `last_scan_at_ms` moving while `pages_completed` does not is a page the scan
  keeps listing again ([operations](../operations.md)).

## Verification

`services/processor/test/collection-scan-convergence.test.ts`, on synthetic
terminals (a failed run with no provider bytes for `provider_run_failed`, a
producer without a route for `inactive_ingest_route`):

- a page of 25 with the six refused terminals first finishes in five ticks,
  the cursor advances, the next page registers, and a second walk over the
  judged page appends nothing and moves on in one tick; held ticks count no
  page and no cycle;
- a judged page costs at most five operations per terminal;
- new terminals on a judged page register five per tick until done;
- a blocked run is never attempted again; a retryable run is not attempted
  within 24 hours however often it is listed, is attempted once after, and a
  route added by the operator registers it at that attempt;
- the queue path still attempts every delivery and answers a blocked run with
  `recorded: true`.

The existing collection and registration-budget suites pass unchanged.
