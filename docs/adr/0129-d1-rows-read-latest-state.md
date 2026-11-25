# ADR 0129: Make the tick's latest-state reads cost what changed, not the history

- Status: accepted 2026-11-23 by the owner (the combined design under
  [Decision](#decision), which replaced this ADR's first draft of
  2026-11-21). `processor-tick` stays disabled until slices 1 and 2 are
  deployed and measured.
- Date: 2026-11-21 (draft), 2026-11-23 (accepted)
- Tracking: [issue 1491](https://github.com/risu729/kogane/issues/1491);
  follow-up of [issue 1464](https://github.com/risu729/kogane/issues/1464)
  (the tick paused for its D1 rows read; the cadence-only fix was dropped, because a slower tick only divides a cost that keeps growing)
- Related: [read model: rows read by the latest-state reads](../read-model.md#rows-read-by-the-latest-state-reads),
  [projection input](../projection-input.md) (the CORE revision and the fixed
  input), [ADR 0037](0037-reconciliation-purchase-cost.md) (the latched
  retirement proof), [ADR 0023](0023-vpass-collector-card-binding.md) and
  [ADR 0029](0029-data-classification-and-unkeyed-identity.md) (the trusted
  Vpass binding view), [ADR 0072](0072-report-artifact-pages.md) (stored
  reports), [design: mutation policy](../design.md#mutation-policy),
  [infra ledgers](../infra-ledgers.md#reading-the-classification)

## Context

D1 bills rows read. Issue #1491 measured the Processor tick at about 20M rows
per five-minute tick, the whole billing overage of the period, and attributed
it per statement (Cloudflare GraphQL, rows read per day):

| Statement                              | Executions | Rows read | Per execution | Caller                                                 |
| -------------------------------------- | ---------: | --------: | ------------: | ------------------------------------------------------ |
| latest-state reads over `snapshotCtes` |        843 |     3.96B |          4.7M | balance projection capture (3 per capture), report job |
| Vpass binding insert                   |        209 |     1.26B |          6.0M | `identitySweep`, empty-parse batch                     |
| `CURRENT_REWARD_BUCKETS_SQL`           |        286 |     0.74B |          2.6M | reward read projection capture                         |
| `STALE_CARD_PURCHASE_KEYS_SQL`         |        215 |     0.32B |          1.5M | purchase lane, retirement pass                         |
| current card usage page                |        204 |     0.26B |          1.3M | purchase lane, recognition pass                        |
| card settlement debits                 |      5,934 |     0.20B |           34k | settlement sweep                                       |

The six sum to 6.74B a day (the issue gives 5.75B for the whole tick that
day from another query, so only the proportions are used here). Splitting the
first row with the harness's ratio of a positions read to a latest-balances
read (39,791 to 74,943 rows, below) gives 555 latest-balances reads of about
5.6M rows (3.1B) and 288 positions reads of about 3.0M (0.86B), which matches
the issue's report job that "reads about 2.9M rows per tick today only to find
the same report".

Why each costs that much, from the plans without table statistics (as D1
plans them) and from `meta.rows_read` measured on workerd
([read model](../read-model.md#rows-read-by-the-latest-state-reads)):

- **The current-snapshot selections are recomputed from the whole history in
  every read that needs them.** A latest-balances read scans `fetch_artifacts`
  three times (its active chain, `eligible_snapshots`,
  `eligible_artifact_containers`) and walks every terminal fetch-run report
  twice more through an automatic index (MyJCB past months, V Point runs),
  probing each artifact's run, units, parse, publication, claim and warnings.
  A positions read makes three passes, its valuation pairs two, the reward
  bucket read one (V Point runs), the card usage page two, the stale-key read
  two. `tick-query-plan.test.ts` and `docs/read-model.md` said these CTEs read
  each artifact once; they do not, and the plan check, which looks at `SCAN`
  steps only, could not see the rest.
- **The Vpass binding insert is quadratic.** It joins
  `trusted_vpass_card_bindings` by artifact, but its plan starts from every
  binding artifact and searches every Vpass artifact for each; the batch's
  candidates are the innermost loop. It runs whenever the batch holds an empty
  parse of any source.
- **The report job rebuilds its whole input to find the report it already
  stored.** It reads positions, valuations, decimals and prices on every tick
  and only then compares the manifest digest; it has no gate.
- **The revision gates that exist hold on a minority of ticks.** The balance
  and reward projections skip a capture when the CORE revision has not moved
  (the reward one also when the UTC day changed). On 11-19 the balance
  capture ran on about 185 of 288 ticks (its three latest-balances reads are
  555 of the first row's 843 executions), so its gate held on about a third
  of the ticks; the reward bucket read behind the reward gate ran 286 times,
  so that gate held on almost none, for a reason not measured (both counts are
  upper bounds on capturing ticks: a capture that sees the revision move
  retries). The revision moves with every identity run, reward claim, balance
  row and parse, not only with collections; how often it moves per day is not
  measured (open question 5).

What makes an artifact the current snapshot of its container changes only with
the snapshot inputs: parse runs and their status or supersession,
`published_parse_runs`, `publication_events`, coverage claims, snapshot
policies, fetch run seals and annotations, unit outcomes, and code-owned
constants (`ARTIFACT_SNAPSHOT_CONTAINERS`, the parser lists, the policy ids).
These change with collections, a few hundred writes a day, and with deploys.

### Measured baseline

`services/processor/test/tick-rows-read.test.ts` builds two synthetic CORE
stores with the same current state over 30 and 60 capture days (972 and 1,942
artifacts; Vpass with its trusted binding runs, MyJCB, SMBC, St.George, SBI
Shinsei, V Point with reward claims, SBI Securities positions), copies each
into Miniflare D1, and runs each statement through its real caller on a
binding that records `rows_read` per statement:

| Statement                      | Caller               | Rows read per call, 30 days | 60 days | Growth |
| ------------------------------ | -------------------- | --------------------------: | ------: | -----: |
| `listLatestBalances`           | `captureFixedInput`  |                      37,693 |  74,943 |   1.99 |
| `listPositions`                | `runReportJob`       |                      20,041 |  39,791 |   1.99 |
| `POSITION_VALUATIONS_SQL`      | `runReportJob`       |                      12,371 |  24,401 |   1.97 |
| `CURRENT_REWARD_BUCKETS_SQL`   | `captureRewardInput` |                       8,571 |  17,101 |   2.00 |
| `STALE_CARD_PURCHASE_KEYS_SQL` | `cardPurchaseSweep`  |                      17,755 |  32,588 |   1.84 |
| `currentCardUsageSql` page     | `cardPurchaseSweep`  |                      15,010 |  27,702 |   1.85 |
| Vpass binding insert           | `identitySweep`      |                      75,890 | 283,740 |   3.74 |

What each statement returns is the same at both sizes (10 balance candidates,
3 positions, 2 reward buckets), except the card usage page, which returns the
older statement months a longer history still holds as current. Three more
measurements on the same stores, at 60 days:

- the report job's second run over unchanged inputs reads 64,231 rows to find
  its stored report; the CORE revision row it would compare is 1 row;
- the current-snapshot selections alone (container snapshots 24,335, MyJCB past
  months 2,784, V Point runs 18,384) are 45,503 of the 74,943 rows of one
  latest-balances read; the rest is the read's own active chain over every
  artifact;
- the Vpass binding join over all 502 identified Vpass parses reads 2,486,343
  rows in the shipped join order and 19,132 started from the candidate (38 per
  candidate at both sizes), returning the same rows.

## Options considered

### 1. The current snapshot set as data

Every latest-state read composes the selections whole. The options keep the
set somewhere it is computed less often than it is read, and make the readers
start from the set's member artifacts instead of from every artifact.

**1a. A maintained member table, updated as its inputs change.** A CORE table
of (selection, source, parser family, dataset, partition unit, fetch run,
artifact), updated in the same tick as a write to a snapshot input, by
recomputing only the partitions the write touched (a partition's own history,
through `idx_fetch_artifacts_source_dataset_time (source_id=? AND dataset=?)`).

- Correctness: the table must equal `snapshotCtes` at every revision a reader
  sees. A write the updater does not see (a new input table, a code constant, a
  re-parse of an old capture, a restriction) leaves a partition silently
  stale, and nothing in the read shows it.
- Cost: per change, the changed partitions' history; per read, the members and
  their rows.
- Migration: a new table and either triggers on every snapshot input (each
  writer pays the recomputation inside its own transaction) or a change log the
  Processor walks.
- Mutation policy: the rows are replaced as partitions move, so the table is
  mutable by design; it is derived and rebuildable from evidence, never
  evidence, so it fits `operational-mutable` (or a new derived class, open
  question 2), and an append-only guard does not apply.
- Failure modes: drift (above), and an updater that fails half-way.

**1b. A memo keyed by a snapshot-input revision.** A new counter, bumped by
trigger by every write of a snapshot input only (the issue's list above, as a
declared ledger the way `SOURCE_REVISION_LEDGER` is, with a test that the
triggers are exactly the ledger). A memo table holds the member set computed
once per (snapshot revision, `core_epoch`, selection digest), by one
`INSERT ... SELECT` over the existing `snapshotCtes` text. The selection
digest is the SHA-256 of the selection's own SQL text: the code-owned
constants (`ARTIFACT_SNAPSHOT_CONTAINERS`, the parser lists, the policy ids)
are interpolated into that text, so it moves with them. The projections'
build digest cannot stand in for it: `projectionBuildDigest` hashes a list
of release strings (`BALANCE_PROJECTION_RELEASE` and its siblings), none of
which a change of those constants moves. Only the Processor writes the memo,
in its own step of the tick; a reader joins the memo rows of the current key
when they exist and otherwise runs the shipped selection inline, as today.
The app's reads (`services/app/src/observation-api.ts`, the application query
path that MCP tools and the web UI share) run the same readers and so never
write: an MCP read stays a read.

- Correctness: the memo is the shipped selection evaluated at that key, so it
  is the same rows by construction as long as the key covers every input. The
  key is read before and after the read, as the fixed-input capture does, and
  a moved key retries.
- Cost: one selection per key move (45,503 rows at 60 days here; about 3.4M in
  production, 61% of one latest-balances read) instead of one per read (the
  container snapshots alone are computed five times in a tick that runs the
  balance capture and the report job); per read, the members and their rows.
- Migration: the counter row, its triggers, the memo table; old keys pruned.
- Mutation policy: the memo rows are written once per key and pruned when the
  key is superseded, so the table is `operational-mutable` like the scan
  cursors and `processor_lane_ticks`. The counter is a sibling of
  `core_source_revision`. Both go into `REVISION_EXCLUDED_TABLES`
  (`packages/read-model/src/source-revision.ts`): a memo write that moved the
  CORE revision would make every build stale the moment it wrote, the reason
  that list exists. The memo holds ids only (selection code, fetch run,
  artifact), never a dataset label, unit key or other provider text, under
  the rule that stored operational records carry counts and closed codes.
- Visibility: the selection reads `fetch_run_annotations` (a run an operator
  hides) and the run seals. Both must be in the snapshot-input ledger; a memo
  that missed an annotation would keep serving a hidden run as current
  evidence until the next key move, so the trigger ledger test covers the
  visibility inputs by name.
- Failure modes: an input table missing from the ledger (guarded by the
  trigger ledger test and by a test that a write of each input moves the key);
  a write between computing the memo and recording its key (avoided by writing
  the memo rows and their key in one statement, which D1 runs atomically).

**1c. A memo keyed by the existing CORE revision**, as `runReadProjection`
keys its builds (source and visibility revision, `core_epoch`), plus the
selection digest of 1b. No new counter. But that revision moves with identity
runs, reward claims, balance rows and decisions too: the balance capture's
gate held on about a third of the 11-19 ticks. The memo would be recomputed
on about two thirds of the ticks, saving the repeated computations within a
tick (five to one for the container snapshots) but little of the per-tick
cost.

The readers' rewrite is the same for 1a and 1b: start from the member
artifacts, reach parses and observations by key (`idx_parse_runs_artifact`,
the observation `parse_run_id` indexes), and rank only the current rows. Each
rewritten read is proven equal to the shipped text as AGENTS.md requires: the
shipped text frozen as legacy SQL, row-for-row equality on the existing
read-model and processor fixtures, on the scaled stores and on random stores
(the generators of `card-usage-random-store.ts` and
`collection-quality-differential.test.ts`), and plan checks without table
statistics; for 1b, also a test that every write of a ledger table moves the
key and that the memo at a key equals the shipped selection at that key.

### 2. The Vpass binding lookup keyed by artifact

**2a. Rewrite the insert to start from its candidate.** The three joins become
`CROSS JOIN`s, which SQLite never reorders: the candidate list is the only
scan, each candidate reaches its identity run, parse, artifact and binding by
key, and the view is unchanged. The harness measures 38 rows per candidate at
both sizes against 2,486,343 rows for the shipped order; at most 40 candidates
a batch, about 1,500 rows a call. No migration. Proof: the shipped text frozen,
row equality on `vpass-binding-view.test.ts`'s random and scaled stores, and a
plan check that the candidate is the first and only scan.

**2b. A binding table written when the binding run is sealed.** A table keyed
by financial artifact, written at seal. It needs a migration, a write on the
ingest path, a backfill of every existing binding, and a proof that it stays
equal to the view (the view's rules include later facts, such as a second
binding run of the same key, that a seal-time write must also see). It buys
nothing over 2a for this insert.

### 3. The report job skips when its key has not moved

The job stores, in an operational row, the key it last built or reused under,
and on the next tick compares it before reading any position. The key must
cover every input of the report manifest (`INPUT_MANIFEST_VERSION`): the CORE
revision covers parse runs, publication, decimals and (through the visibility
revision) restrictions, but price observations and promoted price claims are
not in `SOURCE_REVISION_LEDGER`, so the key also needs the price inputs (for
example the newest promoted price claim, `price_observation_claims` being
append-only), plus `core_epoch`, the build releases (`reportBuildReleases`),
the caller's options (unit, perimeter, decimal policy release) and the row
bound. The inputs also depend on the clock, which no write moves: the tick
passes its own `now` as the knowledge cutoff, and `SNAPSHOT_PRICE_SQL` admits
a price only when its effective time and its recorded time are at or before
the cutoff, as `recordedAfterCutoff` does for a position's artifact. A price
stored with a later effective time becomes the chosen one when the clock
passes it, with no write. The key therefore also keeps the earliest such
time among the held instruments' stored prices, and the skip holds only while
the clock is before it. The saving depends on how often that key stays put:
with the CORE revision in it, a tick saves only when nothing in the whole
revision ledger moved (on 11-19, about a third of the ticks at the balance
gate; open question 5). With 1b's snapshot revision in place of the CORE
revision for the position inputs, the key moves only with collections, price
promotions and the inputs above. A skipped tick saves the valuation read too
(`POSITION_VALUATIONS_SQL`, 24,401 rows beside the positions read's 39,791
at 60 days), which is not in the issue's table.

### 4. A cost budget in tests

`tick-query-plan.test.ts` checks `SCAN` steps on a one-artifact store, so it
does not reach the Vpass insert and does not see nested searches, automatic
indexes or per-row probes. Options: a production-size fixture (none exists; the
app's opt-in load test builds its own); or the growth ratio between two store
sizes at the same current state, measured with `meta.rows_read` on workerd.

## Decision

Rows read by a scheduled statement are proportional to what changed or to
what it returns, never to the stored history. Concretely:

1. **The current snapshot set is data (option 1b's structure).** A
   _snapshot-input revision_ (a one-row counter beside
   `core_source_revision`) is bumped by triggers on exactly the tables that
   decide currentness: parse runs and their status or supersession,
   `published_parse_runs`, `publication_events`, coverage claims, snapshot
   policies, fetch run seals and annotations, unit outcomes. A declared ledger
   lists them, and tests check that the triggers are exactly the ledger and
   that a write of each table moves the counter. A memo table holds the member
   set (selection code, container key, fetch run, artifact; ids only) for one
   key: (snapshot-input revision, `core_epoch`, selection digest), where the
   digest is the SHA-256 of the selection's own SQL text, so it moves with the
   code-owned constants interpolated into it. Only the Processor writes the
   memo, in its own step of the tick, with the rows and their key in one
   statement. A reader joins the memo rows of the current key when they exist
   and otherwise runs the shipped selection inline, so the app never writes
   and an MCP read stays a read. Both new tables are `operational-mutable` and
   go into `REVISION_EXCLUDED_TABLES`.
2. **The memo is computed by a per-container walk, not by the shipped CTEs.**
   A container registry (source, dataset, unit; append-only, filled by a
   trigger on `fetch_artifacts` insert and backfilled by the migration) lists
   the containers, and for each one a correlated `LIMIT 1` walks its artifacts
   newest first over an index on `fetch_artifacts (source_id, dataset,
   fetched_at_ms DESC, id DESC)`, stopping at the first eligible capture. The
   eligibility checks are the shipped ones, evaluated only for the candidates
   walked. In production one walk over the 37 snapshot containers reads
   thousands of rows; the shipped selection reads about 3.4M (measured
   2026-11-21 through the D1 query API: `current_snapshots` 0.31M,
   `eligible_vpoint_runs` 2.24M, a whole latest-balances read 5.92M). The
   V Point runs and MyJCB past months are walked from their own source's
   artifacts: their parsers accept their own source only (the parser
   registry), which a test pins.
3. **Readers start from the members** and reach parses and observations by
   key, ranking only the current rows. Each rewritten read carries the shipped
   text frozen as legacy SQL and differential tests (the read-model and
   processor fixtures, the scaled stores of `tick-rows-read.test.ts`, random
   stores), as AGENTS.md requires of a rewrite. The memo at a key equals the
   shipped selection at that key on the same stores.
4. **The Vpass binding insert starts from its candidate (option 2a).**
   `CROSS JOIN`s fix the order; the view is unchanged; no migration.
5. **The report job skips when its key has not moved (option 3)**, with the
   full key: the snapshot-input revision for the position inputs, the newest
   promoted price claim, `core_epoch`, the build releases, the caller's options
   and the row bound, and the earliest stored price time after the last cutoff
   among the held instruments (the skip ends when the clock passes it). The
   key is kept in an operational singleton.
6. **The balance capture reads the latest balances once**, not three times:
   the three reads differ only by the measure view, which the job splits in
   code.
7. **History-derived reads are maintained from a high-water mark** (later
   slices): the card purchase and settlement sweeps and the history parsers'
   latest balance per key read what was published since their last run and
   rebuild a container only when something they used was withdrawn. A sweep
   that reaches the end waits for new rows instead of wrapping around.
8. **Guards so it does not come back.**
   - Rule (AGENTS.md, `docs/read-model.md` Cost): a scheduled statement reads
     rows in proportion to what changed or what it returns. History-wide
     scans, rankings over every row, or per-row correlated subqueries over a
     growing table are allowed only in on-demand reads with a stated bound.
   - Growth test: `tick-rows-read.test.ts` (landed in #1510) is the budget.
     Each slice lowers its statements' ceilings to the measured value; the
     target "doubling the history at the same current state adds at most a
     small constant" replaces each `test.todo` as a slice reaches it.
   - Plan lint: the scheduled lanes' statements are recorded on a store that
     reaches every lane, and their plans fail on a `SCAN` of a growing table
     or a correlated subquery that scans one. The `ACCEPTED` list goes away;
     an exception names an issue and an expiry date, and fails after it.
   - Production guard: the Processor sums the lanes' `d1RowsRead` per hour in
     an operational table. Above 300M rows in 24 hours it logs an error
     (Workers Issues reports it) and runs the derived lanes at most once an
     hour until the sum falls back.

Slices, each its own pull request, in this order: (1) guard, report skip, one
capture read, rule text; (2) snapshot-input revision, memo, registry and walk,
readers switched, differential tests, plan lint; then `processor-tick` is
re-enabled and measured for an hour; (3) the Vpass insert and the card sweeps
from the high-water mark; (4) the history parsers' latest balances. Option 1a
(a table updated in place) is not chosen: a missed update is silent and
permanent, where a memo key that misses an input is guarded by the ledger
tests and repaired by the next move of the key. Option 1c (the CORE revision
as key) is not chosen: it moves on about two thirds of the ticks.

## Consequences

- Production paths change slice by slice; the tick is re-enabled after slice
  2 with the guard already deployed.
- New CORE tables: the snapshot-input revision, the memo, the container
  registry, the report key singleton and the hourly cost sums, each
  classified in the schema ledger and pinned in
  `services/processor/test/lanes.test.ts` in its own slice. They are derived
  and rebuildable; none is evidence.
- Every reader rewrite carries frozen legacy SQL and differential tests.
- Limits: the harness's stores are synthetic and small; only growth ratios
  and shares are claimed from it. Production numbers come from the D1 query
  API and Workers Logs, read through the Cloudflare API connector the owner
  set up, aggregate counts only.
- Security and permissions: no slice changes what an MCP client or the
  operator can read, adds an operation, a binding, a secret or an Access
  policy, or changes a confirmation class. The memo is written by the
  Processor only and holds ids only.

## Owner decisions (2026-11-23)

The draft's open questions, as the accepted design answers them:

1. Slice order: as above, with the guard first.
2. The memo is a derived CORE table classified `operational-mutable`.
3. A snapshot-input revision counter beside `core_source_revision`, with its
   own trigger ledger: yes.
4. The report key is the one in decision 5, kept in an operational singleton.
5. Measurement: per-lane `d1RowsRead` from Workers Logs and per-statement rows
   from D1 analytics, read by agents through the owner's Cloudflare API
   connector; the capture-or-skip outcome also becomes a closed count in the
   lane's tick record.
6. No floor: a read made cheaper passes, and its slice lowers the ceiling.
7. The V Point and MyJCB selections start from their own source's artifacts,
   pinned by a parser-registry test.
8. The identity sweep's candidate page stays an accepted open limit, outside
   issue #1491.

## Slice 1 as built (2026-11-23)

- One capture read: `LATEST_BALANCE_CANDIDATES_SQL` returns the summaries
  view's rows flagged `latest_in_group` and `is_summary`;
  `readLatestBalanceCandidates` splits the unfiltered list and both views from
  it with the same 5,000-row bound per set. `tick-rows-read.test.ts` checks on
  both stores that the split equals the reader's three lists.
- Report skip: `report_job_gates` (migration 0107) holds one row per set of
  options and releases rather than a single row, so a caller with other
  options (a test, a later on-demand build) does not evict the tick's gate.
  Until slice 2 adds the snapshot-input revision, the key's revision part is
  the CORE revision row (`source_revision`, `visibility_revision`,
  `core_epoch`); slice 2 swaps it and bumps `REPORT_GATE_VERSION`. Beside
  decision 5's inputs, the gate also requires the cutoff to be at or after the
  stored build's (an earlier cutoff can exclude what the build included), and
  a report cut at its row bound or one whose cutoff dropped a later-recorded
  position is never gated. The gate id also digests the text of every
  statement that decides what the job reads (positions, valuations, the cut
  check, decimals, the cutoff and boundary lookups, the two price queries and
  the gate read), so a deploy that changes one builds again without a
  release bump. A gated run reads 3 rows on either harness store.
- Guard: `processor_read_budget_hours` (migration 0107) sums every metered
  invocation's reported rows read per hour. "At most once an hour" is the
  first scheduled tick of each hour, which also logs the error line once.
  `first()` results carry no metadata, so statements read that way are not in
  the sum (the probe's `missing` count shows how many).
- The report lane's gate outcome is in its log line (`gated`); the lane has no
  tick record (`LANE_TICK_COUNTS` does not list it), so open question 5's
  closed count is left to the slice that gives it one.

## Slice 2 as built (2026-11-23)

- Snapshot-input revision: `core_snapshot_input_revision` (migration 0108)
  with triggers on `SNAPSHOT_INPUT_REVISION_LEDGER`: parse runs,
  `published_parse_runs`, `publication_events`, coverage claims, snapshot
  policies, fetch run seals and annotations. Decision 1's "unit outcomes" are
  not in it: unit reports, like every acquisition table, cannot change after
  their run is sealed (migration 0001), and the selections read sealed runs
  only, so the seal's own bump covers them. Every ledger table is also in the
  CORE ledger, which a test checks.
- Container registry: filled by a trigger on `published_parse_runs`, not on
  `fetch_artifacts` insert, keyed by (source, parser, dataset, unit, MyJCB
  connection). A container with captures but no published parse has no
  current snapshot, and keying by parser keeps a shared dataset name
  (`realised-gains` of SBI and Sony) from being walked for the other parser.
- Walk index: `idx_fetch_artifacts_source_dataset_capture` on (source,
  dataset, the sealed view's capture time, id) is partial on a condition that
  always holds and that only the walks state. Without table statistics a plain
  (source, dataset) index moved the plans of the card usage, card statement
  and reward candidate reads to it; the partial index leaves every other plan
  as it was. The walk orders by the raw time in ms, the shipped selections by
  the view's text of it, which is NULL from year 10000 on; the two orders agree
  only below that, so migration 0108 refuses a capture or terminal report timed
  at or past it (production held none).
- Memo key and reading: the digest is pinned in code
  (`SNAPSHOT_SELECTION_DIGEST`, checked against the walk's text by a test) so
  that the reading statements can name this build's key. A statement that finds
  no key for the current revision fails ("malformed JSON") rather than reading
  an empty set, and the Processor stores the memo again and retries, then falls
  back to the shipped selection inline. A failure to store the memo fails the
  lane instead of falling back, so it is seen. Only the Processor reads the memo; the
  app and MCP keep the inline selection, so they never depend on a lane having
  run.
- Readers: the balance and position reads start from the candidate parses
  (members' parses, the current V Point runs' parses, and every published parse
  of a parser that no snapshot rule governs) and keep the shipped predicates,
  so the candidates are a superset, never the filter. The valuation pairs no
  longer grow with history. The reward bucket read joins the memo's V Point
  run and still ranks every claim (an exception in the plan lint). The history
  parsers' parses are still visited one index probe each, which slice 4
  removes.
- Report gate: stays keyed on the CORE revision, not the snapshot-input one.
  The report also reads exact decimals and is bound by restrictions, which move
  the CORE revision only, so the snapshot revision alone would let a stale
  report pass the gate. With the memo, a build that the gate does not skip
  reads 6,380 and 11,780 rows on the harness stores instead of about 52,500
  and 104,000. `REPORT_GATE_VERSION` is unchanged; the gate id moves anyway,
  since it digests the memo-backed statements' text.
- Plan lint: `tick-query-plan.test.ts` keeps its per-statement entries, now
  either `bounded` (with the reason) or an `exception` naming the issue that
  removes it and an expiry date, after which the test fails. The latest-state
  reads' entry is gone: the tick no longer prepares the inline selection.
- Measured on the harness stores (30 and 60 days, rows read per call):
  balances 6,705 and 12,705 (from 37,703 and 74,953), positions 3,102 and
  5,802 (from 20,041 and 39,791), valuations 79 and 79 (from 12,371 and
  24,401), reward buckets 290 and 530 (from 8,571 and 17,101), the walk 968
  and 1,448 once per revision.

## Slice 3 as built (2026-11-24)

- After slice 2, one hour of ticks (06:35 to 07:35 UTC) read about 2.5M
  rows a tick, 65% of it in the card settlement sweep and the purchase
  recognition pass: both page through their whole input every tick (52
  current statements, about 86k rows of `card_statement_facts`; the current
  card usage rows) because one pass fits in one tick and the cursor wraps.
- Gate, not high-water mark: `processor_sweep_passes` (migration 0109) holds
  one row per sweep. A pass from the first row records the CORE revision
  (source revision, visibility revision, core epoch), the sweep's policy and a
  token; a pass that reaches the end with its work done marks that start
  clean, naming the token, so an overlapping tick's pass is never marked by
  another's end. While the revision and the policy equal the clean ones, a
  tick at cursor 0 reads the gate row and stops. What the sweeps read off the
  CORE dependency ledger is folded in or argued:
  - the policy carries code-owned versions (the matching, debit-account and
    card information reader versions; the recognition writer and the
    matcher's release and options) and a digest of the views each sweep's
    code reads, which `test/sweep-pass.test.ts` checks against the migrated
    schema, so a migration that redefines one of them fails until the pin
    moves;
  - the settlement policy also carries the highest card information reading
    id, since the debit-account lane writes those readings off the ledger;
  - the settlement candidates and debit-account evidence are written only by
    that sweep, the purchase proposals only added (by the sweep, or under
    other digests by the reconciliation sweep) or decided through a decision
    revision, and none is deleted.

  A pass whose own writes moved the revision (purchase events) is followed by
  one more, which writes nothing and closes the gate. A tick reads its cursor
  and the recorded pass in one statement. The purchase cursor leaves a page
  only after its candidates and merges, so a tick cut off before then reads
  the page again. A purchase pass in which a tick left work for later (the
  candidate budget full, more linked events than one merge takes, any failed
  write, or a candidate or merge step that threw, counted as a failure so one
  failing page never holds the cursor) marks nothing clean; a failure that repeats keeps that pass
  reading everything each tick. The settlement sweep's write budget stops the
  cursor on its statement, so a pass that reaches the end has written
  everything. A code change that no version string carries (a statement's
  text written in TypeScript, a domain rule) runs no pass by itself: the pass
  after the next CORE write applies it, or a bump of the sweep's version.

- Decision 7's "proportional to new rows" is not reached: a tick in which the
  revision moved still runs a whole pass. Quiet ticks cost the gate read; the
  first measured hour of production had a moving revision on every tick (the
  parse backlog left by the stop: 1,080 pending parse jobs at 13:05 UTC, about
  150 parses an hour), so the effect shows only once that backlog is done.
  Reading only what changed would need the statement and usage readings keyed
  by what moved, which the sweeps' rankings do not offer; it stays open under
  issue #1491 with slice 4.
- Measured on the harness: a quiet settlement tick prepares two statements
  (the card information mark, then the cursor and the gate together), and a quiet purchase
  tick reads the gate instead of the usage page, checked by
  `services/processor/test/sweep-pass.test.ts`.
- Not changed here: the Vpass binding insert (decision 4) and the stale-key
  read of the retirement pass, which already skips while its own revision
  check holds.

## Verification

- `services/processor/test/tick-rows-read.test.ts` (landed in #1510): each
  slice lowers its statements' ceilings to the measured value.
- Per slice: frozen legacy SQL and differential tests for every rewritten
  read; the ledger tests for the snapshot-input revision; the plan lint.
- After each deploy: the Processor's `invocation_budget.lanes.*.d1RowsRead`
  per tick and the D1 daily rows read, reported in the pull request.
