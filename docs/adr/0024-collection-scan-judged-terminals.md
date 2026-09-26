# ADR 0024: The collection scan does not spend registrations on terminals already judged

- Status: accepted (#267); the
  [amendment of 2026-09-26](#amendment-2026-09-26-a-seal-core-refuses-is-a-verdict)
  is proposed
- Date: 2026-09-26
- Amends: [ADR 0010](0010-terminal-registration-budget.md) (how the scan's
  per-tick registration count is spent; the operation budget is unchanged)
- Carried by:
  [processor §2](../processor.md#2-two-ways-in-one-use-case),
  [observation lanes](../observation-lanes.md),
  `services/processor/src/collection/index.ts`,
  `packages/application/src/collection/register-terminal.ts`,
  `packages/storage-d1/src/core/collection-runs.ts`,
  `packages/application/src/collection/seal-refusal.ts` (amendment),
  `services/processor/test/collection-scan-convergence.test.ts`

## Context

The Processor's `collection_scan` lane runs every five minutes. It lists one
R2 page of 25 terminals from its stored cursor and makes at most five
registration attempts per tick. Before this ADR, a `blocked` or `retryable`
answer counted against those five exactly like a registration, and the cursor
advanced only when the whole page had been dealt with.

Since the collectors changed their producer ids, most sources' terminals are
refused: a terminal whose
producer has no route is `retryable` `inactive_ingest_route`
([ADR 0014](0014-collector-producer-ids.md) records why), and others are
blocked (`artifact_lineage_unstated`, `provider_run_failed`). A block is
write-once, and a retryable run is refused again on every attempt. With more
than five such terminals on one page, every tick spent its five attempts on
them and listed the same page again next time. Production aggregates on
the date of this ADR showed `pages_completed` = `cycles_completed` (4,371), cursor null,
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

- **Right after deploy.** The first page is the one the scan has been
  listing since the stall began. Its registered terminals (the R2
  notification path registered them) and its blocked ones already have rows
  and are answered from them on the first tick, spending nothing. Its
  retryable terminals (the producer-mismatch runs) have one `registered`
  `retryable` row each, written at their first refusal, because before this
  ADR a repeat refusal appended nothing; every one of them first refused 24
  hours or more before the deploy is due, and is attempted once more, five
  per tick, and refused again, each attempt appending one row that starts its
  interval. With R such due terminals on the page, the page is finished on
  tick ⌊R/5⌋ + 1 at the latest: six ticks (half an hour) for a page of 25.
  One refused within the last day before the deploy is answered from its row
  and waits for a later walk. The scan then moves on to the rest of the
  prefix and attempts the terminals with no row that it finds there, five per
  tick.
- **The R2 notification path is unchanged.** The queue consumer still
  attempts every delivery with no interval, so a new terminal still registers
  as soon as its notification arrives; the scan remains the path that finds a
  terminal whose notification was lost.
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
- a judged terminal costs three operations (registered or blocked) or five
  (retryable within its interval) and writes nothing; a judged page of 25
  costs 81 inside the registration budget, 85 with the scan's own list and
  state reads and write, measured with the invocation probe's meter;
- a terminal re-persisted with other bytes (a new digest) is attempted, not
  answered from the earlier row;
- rows under another registration contract version do not count as judged:
  every terminal is attempted again, including a retryable one minutes after
  its last refusal;
- new terminals on a judged page register five per tick until done;
- a blocked run is never attempted again; a retryable run is not attempted
  within 24 hours however often it is listed, is attempted once after, and a
  route added by the operator registers it at that attempt;
- the queue path still attempts every delivery and answers a blocked run with
  `recorded: true`.

The existing collection and registration-budget suites pass unchanged.

## Amendment 2026-09-26: a seal CORE refuses is a verdict

- Status: proposed
- Date: 2026-09-26

### Context

`registerTerminal` turns what it knows to be a verdict about a terminal into
a `blocked` or `retryable` row: a `TerminalRegistrationError`, a
`ContractError`, an `IngestError`. A refusal by CORE's own seal trigger was not
one of them. When `fetch_run_seal_requires_complete_inventory` refused the
seal (`RAISE(ABORT, 'run_inventory_incomplete')`, which D1 reports as
`D1_ERROR: run_inventory_incomplete: SQLITE_CONSTRAINT (extended:
SQLITE_CONSTRAINT_TRIGGER)`), the error was rethrown. The run's structure,
catalogue and reports were in CORE, unsealed; no `registered` stage and no
`blocked_code` were written; the scan counted the terminal in `failed`; and,
because its row was neither registered nor blocked, the next walk attempted
it again. The decision above ("a terminal CORE has already judged is
answered from its row") could not apply: nothing was judged.

The terminal is immutable and the derivation is fixed for a contract
version, so every later attempt is refused in the same way. Production on
2026-09-26 (aggregates only): 14 sbi-vc-trade terminals whose unit declares a
different artifact count than the run holds, and the collector-vpass
terminals the [roadmap](../roadmap.md) lists, hit this on every walk.

### Options considered

1. **Keep rethrowing.** Rejected: each such terminal spends one of the tick's
   five registrations and its operations on every walk, forever, and is
   reported as an infrastructure failure when it is a verdict about the
   evidence.
2. **Record it as `retryable`.** Rejected: `retryable` is for refusals about
   the deployment that a configuration fix can change. Nothing an operator
   does changes this answer for this terminal and this contract version.
3. **Classify every error the seal statement raises.** Rejected. The seal
   batch's other triggers are not verdicts about the terminal:
   `inactive_ingest_route` is configuration (registration already meets it
   earlier, as `retryable`), and `immutable_duplicate_insert` is a race the
   seal's own reconciliation reads back. A D1 or platform error is not a
   verdict at all.
4. **A new `seal_refused` code with the trigger mapped to a sub-code.**
   Rejected: the trigger's RAISE text is already a closed machine code that
   fits `blocked_code`'s CHECK (`[a-z0-9_]{1,64}`), and a second name for it
   would only need its own mapping table.
5. **Link the unsealed fetch run from `collection_runs.fetch_run_id`.** Not
   possible without a migration: the 0039 CHECK ties `fetch_run_id` to
   `registered_at`, and a blocked run is not registered.
6. **Block with the trigger's code, only for a closed list of trigger codes,
   and name the unsealed fetch run on the blocked stage.** Chosen.

### Decision

- **What is classified.** Only an error from the seal call itself
  (`seal` or `sealStagedInventory`), only when it is a trigger refusal
  (`SQLITE_CONSTRAINT_TRIGGER`: the D1 message above, or SQLite's own error
  with that extended code), and only when its code is in
  `SEAL_REFUSAL_CODES`, which today holds `run_inventory_incomplete` alone
  (`packages/application/src/collection/seal-refusal.ts`). Everything else the
  seal raises is rethrown exactly as before.
- **What is recorded.** The run is blocked with the trigger's code as
  `blocked_code`, and one `registered` `blocked` stage is appended with
  `failure_code` = the same code and `evidence_ref` = the id of the fetch
  run the attempt left behind. The block is write-once as every block is, so
  the scan answers the terminal from its row from then on (`alreadyJudged`)
  and never attempts it again under this contract version.
- **What stays in CORE.** The fetch run, its units, ranges, catalogued
  artifacts, reports and (for a staged run) its inventory stay as they are:
  evidence is append-only, and an unsealed run is invisible to every normal
  reader. The blocked stage is the record that names it.
- **A later contract version.** A new version is a new identity (ADR 0022),
  so the terminal gets one fresh attempt under it. That attempt makes its own
  fetch run, because the version is part of the run key
  (`<runId>:<version>`) and derivations of two versions are never mixed; the
  seal is refused again and the new row is blocked naming that run. So each
  contract version leaves at most one unsealed fetch run per run id, and each
  is named by its version's blocked stage. The earlier row is not carried
  over (only a registered row is) and it counts in the cross-version digest
  conflict check like any earlier record: a different manifest under the
  same run id is blocked `terminal_digest_conflict` before any fetch run is
  made for it.
- **Cost.** The path that seals is unchanged: the classification is a
  `try` around the seal and adds no operation (a two-artifact registration
  spends 74 statements, 3 batches and 5 R2 operations before and after).

### Consequences

- **Right after deploy.** Each of these terminals is attempted once more by
  the walk that reaches it. Under the current version its fetch run already
  exists (the run key is idempotent), so the attempt re-verifies its objects
  unless a `pending` stage names that run, skips what CORE holds, is refused
  at the seal and blocks. From then on it
  costs the three operations of a judged terminal per walk.
- **Rows of an earlier version stay as they are.** A version CORE no longer
  registers under is never worked again (ADR 0022), so a `v1` row whose seal
  was refused before this amendment keeps no `registered` verdict, and its
  unsealed `v1` fetch run is named only if a `pending` stage names it.
- **These terminals still never register.** Registering them needs a
  terminal whose counts agree (a new capture) or a contract version whose
  derivation seals them; this amendment decides neither.
- The seal's other trigger codes stay unclassified; one that turns out to be
  a verdict is added to `SEAL_REFUSAL_CODES` by a later amendment.

### Verification

- `packages/application/test/seal-refusal.test.ts`: the D1 message (with and
  without the `D1_ERROR:` prefix) and a real SQLite trigger error classify as
  `run_inventory_incomplete`; another trigger code, a CHECK constraint, a
  schema error and a platform limit do not.
- `services/processor/test/collection-scan-convergence.test.ts`, on a
  synthetic run whose unit declares two artifacts and holds one: the first
  tick blocks it with the code and one `registered` `blocked` stage naming
  its unsealed fetch run, while the other terminals on the page register;
  later ticks (to two days on) answer it `alreadyJudged` with no new stage
  and no second fetch run; a staged run (51 artifacts) refused by
  `sealStagedInventory` blocks the same way; blocked under `v1`, it gets one
  fresh attempt under `v2` with its own fetch run and blocks again, and a
  different manifest under the same run id is then a digest conflict with no
  new fetch run; a non-trigger D1 error and an unlisted trigger code still
  throw, are counted `failed` and record nothing; a normal registration's
  operation counts are the ones measured before the change.
- `services/processor/test/registration-datasets.test.ts`: through
  Miniflare's D1 (workerd), a collector-vpass-shaped run with the same
  mismatch blocks `run_inventory_incomplete` from the real `D1_ERROR`
  message and is answered `recorded: true` on the next call.
