# ADR 0129: Make the tick's latest-state reads cost what changed, not the history

- Status: proposed. **Design only: the owner approves it before any slice is
  implemented** (issue #1491: "to be designed and approved by the owner before
  implementing"), and it goes into no pull request before that. The
  measurement it cites (`tick-rows-read.test.ts`, [direction
  4](#4-a-cost-budget-in-tests)) and the corrections of the documents that said
  the snapshot reads read each artifact once are test and document changes
  that land on their own, without this ADR; they change no production path.
- Date: 2026-11-21
- Tracking: [issue 1491](https://github.com/risu729/kogane/issues/1491);
  follow-up of [issue 1464](https://github.com/risu729/kogane/issues/1464)
  (the tick paused for its D1 rows read; its cadence fix has not merged)
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

## Decision (proposed)

Direction 4 lands on its own as a measurement; adopt directions 2, 3 and 1,
in that order, as slices, each after the owner approves it:

- **Direction 4 (landed on its own, before this ADR): the measured
  baseline.** `tick-rows-read.test.ts` fails when a statement's growth from
  30 to 60 days exceeds a ceiling over today's measurement (linear reads 2.4,
  the Vpass insert 4.8), rather than a budget that fails today. A read made
  cheaper passes, and its slice restates the cost in `docs/read-model.md` and
  lowers the ceiling. (The first draft pinned a band, 1.6 to 2.4 and 3.2 to
  4.8, which failed on any improvement with a message that named neither the
  ratio nor the band, and made a slice move a lower bound down, which reads
  as loosening a test; whether a floor is wanted is open question 6.) The
  target, "doubling the historical artifacts at the same current state adds
  at most a small constant" (issue #1491), is a `test.todo` per statement
  until a slice reaches it. The plan check's accepted reasons state the real
  passes.
- **Slice 1, direction 2a: the Vpass binding insert from its candidate.**
  Smallest and safest: one statement, no migration, the semantics of an inner
  join unchanged.
- **Slice 2, direction 3: the report job's skip**, with the key above
  including the price inputs, stored in a new operational singleton
  (`operational-mutable`, one migration).
- **Slice 3, direction 1b for the source-scoped selections**: V Point runs and
  MyJCB past months, the two walks of every terminal report, memoised (or
  first rewritten to start from their source's artifacts, if the owner accepts
  that their parsers occur on their own source only, open question 7).
- **Slice 4, direction 1b for the container snapshots and the card currentness
  CTEs** (`VPASS_STATEMENT_SNAPSHOT_CTES`, `MYJCB_LEDGER_SNAPSHOT_CTES`), with
  each reader rewritten to start from the members. Option 1a is not chosen: a
  missed update is silent and permanent, where 1b's worst case is a key that
  misses an input, which its ledger tests guard and which the next move of
  the key repairs.

Expected rows read per day, at today's cadence and executions, as a share of
the 6.74B the issue attributes (estimates from the harness ratios and the
issue's per-execution figures, not measurements of the slices):

| After   | What it removes                                                                                                                                                |                    Rows read a day removed |  Share of 6.74B |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------------------------------: | --------------: |
| Slice 1 | the Vpass insert, 6.0M a call to about 1,500                                                                                                                   |                                      1.26B |             19% |
| Slice 2 | the report's positions reads on ticks whose key did not move (about a third of the ticks if it holds as the balance gate did on 11-19, so about 0.3B)          |                                 0 to 0.86B |        0 to 13% |
| Slice 3 | the MyJCB past months and V Point walks in each latest-balances read (28% of it here) and the reward bucket read's V Point walk                                |                         about 0.87B + 0.7B |       about 23% |
| Slice 4 | the remaining selections and active chains of the latest-state and card reads, down to the members' rows; with it, whatever of the report's reads slice 2 left | about 2.6B (after a quiet slice 2) to 3.4B | about 40 to 50% |

Slice 2 also removes the report's valuation read on the ticks it skips; that
statement is not in the issue's table (by the harness ratio, about 1.8M a
call, 0.52B a day at 288 calls), so it is not in the shares above.

After slice 4 what remains of the issue's six statements is the card
settlement sweep (0.20B, bounded per call by its own design), the memo
computations once per snapshot key move, and the members' own rows: on the
order of 0.3B to 0.6B a day. The issue's 10x is measured against the tick's
5.75B a day (about 20M a tick), so it is about 0.58B a day (2M a tick), not a
tenth of the 6.74B the table attributes. Statements outside the issue's table
also grow with history in the harness and are in no slice: the reward
capture's J-Point totals read (5,760 rows at 60 days, a third of the reward
bucket read), the fixed-input capture's visible-run count (4,879, 6.5% of a
latest-balances read), and the identity sweep's candidate page (6,899; an
open limit of `docs/observation-lanes.md`, open question 8). If production
holds the harness's proportions the J-Point read alone is about 0.25B a day.
So the 10x holds only if the snapshot revision moves no more than a few dozen
times a day, slice 2's key is quiet, and those reads are measured and, if
needed, given slices of their own. Each slice reports the Processor's
`invocation_budget` `d1RowsRead` per tick and the daily D1 rows read after
its deploy, as the issue's acceptance asks; who reads those numbers is open
question 5.

## Consequences

- No production path changes until the owner approves a slice. Until then the
  tick costs what the table above says, and issue #1464's cadence is the only
  lever.
- The harness fails when any of the measured statements grows faster with
  history than today; each slice restates the cost it reaches and lowers its
  ceiling.
- Slices 2 to 4 add migrations: an operational singleton, a counter with a
  trigger ledger, and a memo table. Each is classified in the schema ledger and
  pinned in `services/processor/test/lanes.test.ts` in its own slice.
- Every reader rewrite carries the shipped text frozen as legacy SQL and its
  differential tests, as AGENTS.md requires of a query rewrite.
- Limits: the harness's stores are synthetic and small (about 2,000
  artifacts); the absolute rows differ from production's, and only the growth
  ratios and the relative shares are claimed. The production shares above are
  estimates. The card usage page returns more rows at 60 days than at 30, so
  part of its growth is what it returns.
- Security and permissions: no slice changes what an MCP client or the
  operator can read (an MCP client reads the whole store; no table grant
  exists to widen), adds an operation to the catalogue, a binding, a secret or
  an Access policy, or changes a confirmation class. The memo is written by
  the Processor only, so no read path gains a write, and it holds ids only.
  The one new access the design touches is the measurement: Workers Logs and
  D1 analytics are read with a Cloudflare account API token (Workers
  observability or account analytics read), outside the MCP Access
  application and the audit log, and secrets are never an operation. Such a
  token sees every log event and request of every Worker in the account, not
  only aggregates, so "aggregate counts only" would be a rule the agent
  follows, not a limit the token enforces (open question 5).

## Open questions for the owner

1. Approve the slice order, and that slice 1 proceeds as a plain query rewrite
   under the rewrite rule (frozen legacy SQL, differential tests, plan checks).
2. May CORE hold a derived, rebuildable table (the memo) classified
   `operational-mutable`, or should derived tables get their own class in the
   schema ledger? (READ's `read-projection` class fits such a table, but the
   readers join it with CORE rows, and D1 cannot join across databases.)
3. Is a new snapshot-input revision counter (1b) acceptable, beside
   `core_source_revision`, with its own trigger ledger?
4. The report skip's key: is "CORE (or snapshot) revision, `core_epoch`, the
   newest promoted price claim, the build releases, the caller's options, the
   row bound, and the earliest stored price time after the last cutoff (the
   skip ends when the clock passes it)" complete for the report manifest, and
   may the last key be kept in an operational singleton?
5. How should the revision's move rate, and each slice's post-deploy rows
   read, be measured? The lanes' `unchanged` count cannot answer it: the
   projection lanes return `unchanged` both when the gate skips the capture
   and when a capture finds the same content, so only the lane's
   `d1RowsRead` per tick (a skip reads tens of rows, a capture millions)
   tells them apart. Reading Workers Logs or D1 analytics needs a Cloudflare
   account API token (see Consequences: it is outside the MCP Access
   application and the audit log, and sees more than aggregates). The
   options: (a) the owner runs the queries and records the counts; (b) the
   owner approves a read-only observability token for agents, its scope and
   holder; (c) the move rate is estimated from the store with read-only
   aggregate timestamp queries of the ledger tables, which the production-data
   rule already allows, and the capture-or-skip outcome becomes a closed
   count in a stored record (a code change).
6. The measurement landed with a ceiling (a read made cheaper passes). Should
   it also have a floor, so that a slice that lowers a cost fails until the
   documents restate it?
7. May the V Point and MyJCB past-month selections start from their own
   source's artifacts, on the registry fact that their parsers accept only
   their own source, or must they keep the parser-name rule exactly (then an
   index on `parse_runs(parser_name, ...)`, a migration)?
8. Is the identity sweep's candidate page, which orders every successful
   parse run (an accepted open limit), in scope for issue #1491?

## Verification

- `services/processor/test/tick-rows-read.test.ts`: both stores hold the same
  current state (balance candidates, positions, reward buckets) over twice the
  artifacts; every named statement runs through its caller on both; each
  growth ratio lies under its ceiling; the report job's reuse reads as much
  as its build; the Vpass insert's shipped plan nests every Vpass artifact
  under every binding artifact; the selections alone against a whole
  latest-balances read.
- This proposal's copy of the harness is the first draft: it still pins the
  band, and it carries the prototypes of directions 2 and 3, which the landed
  measurement leaves out as design: the candidate-first Vpass join (the same
  rows, 38 rows read per candidate at both sizes, against 2,486,343 for the
  shipped order over 502 candidates at 60 days; its plan has the candidate as
  the only scan) and the report reuse against the one-row revision read. The
  revision row is not the whole key of direction 3: the price and clock
  inputs above need reads of their own, which the prototype does not measure.
- `services/processor/test/tick-query-plan.test.ts`: the accepted entries are
  unchanged; their reasons state the passes above.
- `mise run //services/processor:ci`, `mise run //packages/read-model:ci` and
  `mise run ci:root` with synthetic data only. No production data, D1 or
  Workers were read.
