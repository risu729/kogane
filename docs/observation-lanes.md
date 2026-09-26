# Observation job lanes: incremental parsing, repair scan, targeted replay

Design-review finding D09 (PR-12). The observation pipeline used one cyclic
cursor over `fetch_artifacts` both to notice newly sealed evidence and to
re-examine all history, and one job budget for everything. This change keeps
the existing D1 job table, lease/claim/publish fencing, retry policy and
parser-version retirement exactly as they were, and adds three independently
budgeted lanes on top of them. No new Queue or Worker; D1 plus the existing
five-minute cron.

Nothing here changes stored Layer A/B semantics, parser versions, publication
or supersession rules, or what readers see. A job's lane only decides which
budget executes it.

## Lanes

| Lane          | Job source                                                                          | Cursor / state                                                          | Default budget per sweep                                 |
| ------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `incremental` | Unprocessed `observation_work_items` (one per sealed run, appended by a D1 trigger) | `observation_work_items.processed_at_ms`, per-item `cursor_artifact_id` | 12 jobs, 50 items, 5 artifact pages of 100               |
| `repair`      | The historical cyclic scan over `fetch_artifacts`                                   | `observation_scan_state` row 1 (unchanged meaning)                      | 28 jobs, 100 artifact ids per sweep                      |
| `replay`      | Running `observation_replay_plans`                                                  | `observation_replay_plans.creation_cursor`                              | 8 jobs, 2 plans stepped, 200 artifacts examined per step |

`sweep` runs maintenance (lease exhaustion, interrupted attempts, version
retirement) once, then the lanes in order incremental → repair → replay. Each
lane creates its own jobs and then executes at most its own budget of ready
jobs of that lane, so a 10,000-job replay backlog cannot delay a run sealed a
minute ago, and a slow history scan cannot delay either. Jobs are ordered by
`priority DESC, available_at_ms, fetch_artifact_id` inside a lane.

Existing rows in `observation_parse_jobs` became `lane='incremental'` through
the column default; jobs created by the repair scan are `repair`, jobs created
from a plan are `replay` and carry `replay_plan_id` and `target_release`.

`observation_lane_state` records each lane's last sweep time, jobs created and
executed, and a cursor (highest processed work item for incremental, the scan
cursor mirror for repair, the last stepped plan for replay). It is operational
state and may be reset.

## Work items (durable seal outbox)

```sql
CREATE TRIGGER observation_work_items_on_seal AFTER INSERT ON fetch_run_seals
BEGIN INSERT OR IGNORE INTO observation_work_items(fetch_run_id,kind,enqueued_at_ms)
  VALUES(NEW.fetch_run_id,'sealed_run',NEW.sealed_at_ms); END;
```

Why a trigger and not a raw-evidence code change: both services already share
the `kogane-raw-evidence` database and the migrations directory, `fetch_run_seals`
is a plain append-only table with one row per run, and the trigger runs inside
the same D1 transaction as the seal insert. A committed seal therefore always
has its notification; a rolled-back seal never has one; raw-evidence code,
its API contract and its tests are unchanged, and there is no cross-service
import. The raw store's own triggers require the terminal run report before a
seal, so the run is already visible to `observation_fetch_runs` when the item is
consumed.

Processing: the incremental lane reads unprocessed items in id order, pages the
run's eligible artifacts (`observation_fetch_artifacts` with a successful run
and no failures) 100 at a time, inserts `INSERT OR IGNORE` jobs for every
deployed parser that accepts the artifact, and advances the item's
`cursor_artifact_id`. An item is marked processed with an outcome
(`jobs_created`, `no_new_jobs`, `not_eligible`) only after its last page; a
sweep interrupted mid-run resumes from the cursor, and re-issued inserts are
no-ops. Partial or failed runs are recorded as `not_eligible` and are not
retried by this lane.

Delivery assumptions (addendum §3): items may be consumed twice by concurrent
sweeps, out of order, or lost by an operator. All three are safe: job creation
is idempotent on the primary key, execution is lease-fenced, and the repair
lane rediscovers any artifact without a job during its next cycle. Work items
are operational state and carry no evidence; deleting them never loses data.

Runs sealed before migration 0035 have no work item. Their jobs already exist
from the historical scan; nothing needs backfilling.

## Replay commands

Internal `POST` routes on the pipeline Worker at the same trust level as
`/sweep` (private service binding, no public route). Bodies are JSON, at most
4 KiB, and responses contain identifiers and counts only.

| Route             | Body                                                                                                                              | Effect                                                                                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/replay/plan`    | `source`, `parser`, `version`, `reason`, optional `dataset`, `artifactIdFrom`, `fetchedFrom`/`fetchedTo` (dates), `targetRelease` | Records a plan in status `planned` with the artifact id high-water fixed to `max(fetch_artifacts.id)` now, an eligible-artifact estimate and how many already have a published success at that version (membership in `published_parse_runs`, not `parse_runs.status='ok'`). Creates no jobs. |
| `/replay/start`   | `planId`                                                                                                                          | `planned → running`, then one bounded creation step (200 artifacts). Repeating it on a running plan performs the next step; on a completed plan it is refused.                                                                                                                                |
| `/replay/pause`   | `planId`                                                                                                                          | `planned/running → paused`. Unclaimed replay jobs of the plan stop being selected; a held lease finishes through the normal fenced publish. Idempotent.                                                                                                                                       |
| `/replay/resume`  | `planId`                                                                                                                          | `paused → running`. Idempotent.                                                                                                                                                                                                                                                               |
| `/replay/cancel`  | `planId`                                                                                                                          | `→ cancelled`; pending (and expired-lease) replay jobs of the plan become `failed/replay_cancelled`. Published parse runs, observations and raw evidence are never touched.                                                                                                                   |
| `/replay/inspect` | `planId`                                                                                                                          | Plan row, attached job counts, `scopeJobs` counts for matching work in every lane, and whether the parser version is currently deployed.                                                                                                                                                      |

The sweep's replay lane continues creation steps for running plans (two plans
per sweep) and marks a plan `completed` once creation is complete and no job
of the plan is pending or running. Plans and steps are idempotent: a second
`start` or step re-examines the same artifact range and inserts nothing new.

Guarantees:

- The high-water is fixed at plan time; artifacts sealed later are never added
  to the plan (verified in `test/lanes.test.ts`).
- Only a deployed parser version can be planned, because the ready query only
  selects registered versions; anything else would sit pending forever.
- A replay job whose artifact/version already has a successful run is skipped
  exactly like `already` today: the job is marked done, no new parse run is
  written, and the unique success index makes a second `ok` impossible. That
  skip is deliberately about the execution attempt, not about adoption: the
  parser must not run twice for the same input and version even when the gate
  has not published the result. The plan estimate above is the operator
  signal and does use the projection.
- An explicit replay can attach a matching `repair` job only when it is still
  `pending`, has zero attempts, no lease, no successful parse, no existing replay
  plan, and exactly the same `target_release` (including null). Its lane becomes
  `replay`; attempts, backoff, priority and creation time stay unchanged.
  `jobs_created` includes these newly attached jobs as well as newly inserted jobs.
  Incremental work, running leases, retries, failed/done jobs and different release
  targets remain untouched. Cancellation applies to attached jobs too; it never
  deletes facts or resets attempts.
- `target_release` is how a plan aims its jobs at a registered candidate
  release (A04, `docs/release-adoption.md`). With `RELEASE_CANDIDATES_ENABLED`
  absent it is recorded and ignored, and every replay result publishes
  normally. With the flag on, a job whose `target_release` names a registered
  release of the same parser and version that is **not** the dataset's active
  release is written as a candidate: `status='ok'`, marked in
  `parse_run_candidates`, and never in `published_parse_runs`. Which parse run
  readers see changes only through `POST /release/activate`.
- Job creation in the incremental and repair lanes consults `active_releases`:
  a dataset with an active release gets jobs only for that release's parser
  version, unless the version is not deployed, in which case the deployed
  registry decides as before.

## Bounded operator replay

Run the authenticated helper from the repository root in WSL:

```sh
mise run //services/processor:ops status
mise run //services/processor:ops replay plan '{"source":"smbc-bank","dataset":"balance-normalized","parser":"smbc-direct-balance","version":"1.0.0","fetchedFrom":"2026-09-10","fetchedTo":"2026-09-11","reason":"Reviewed historical parser update"}'
mise run //services/processor:ops replay inspect '{"planId":1}'
mise run //services/processor:ops replay start '{"planId":1}'
mise run //services/processor:ops sweep replay 20
```

Use the returned plan id and the deployed parser version. The plan's dates refer
to artifact capture dates, not the financial statement month. The recorded
`estimated_artifacts` is an eligibility upper bound: parser acceptance is checked
when jobs are created. Zero jobs can mean that the selected metadata is not
accepted by the parser, or that existing jobs could not join the plan. Inspect
`scopeJobs`: `attached`, `same_target` and `attempted` are 0/1 flags beside each
lane/status count. A completed plan does not prove that every matching job in
another lane finished, or that candidate results were adopted.

Omitting `targetRelease` on this internal helper uses normal publication. The
public `POST /api/ops/v1/replays` API always pins its supplied `parserRelease` as
`target_release`; with candidate mode enabled and no matching active release,
its results remain candidates until explicit comparison and activation. Do not
use candidate replay when the intended operation is an ordinary deployed-parser
backfill. See [release adoption](release-adoption.md) for that separate process.

For existing repair retries that intentionally cannot join a replay, the bounded
`mise run //services/processor:ops sweep repair 20` runs at most 20 ready repair
jobs across the lane; it is not source-filtered. Inspect progress before repeating.
`catchup` increases only the incremental budget and does not accelerate repair.

## Budgets and overrides

`POST /sweep` runs all lanes with the defaults above. `?maxJobs=N` (1–40)
overrides the incremental budget only, which is the historical meaning of the
sweep budget (`mise run //services/processor:ops catchup` relies on it). `?lane=incremental|repair|replay`
runs that single lane, with `maxJobs` applying to it. Maintenance always runs.

Per-source fairness inside a lane is not implemented; a slow source's failing
jobs back off exponentially and are ordered behind ready work, but a large
single-source incremental burst still consumes that lane's budget in artifact
order. Recorded as an open item.

The budgets are constants in `services/processor/src/lane-budgets.ts`, with
`MAX_LANE_JOBS` (40) as the hard bound: every `maxJobs` override is clamped to
it, and `test/repair-budget.test.ts` holds every default to it. Overrides come
only from an operator's `/sweep`, which runs no identity stage; the runs it
publishes are identified by later ticks, oldest first. What the scheduled
identity stage has to cover is the sum incremental + repair, and the same test
holds that sum to `identitySweep`'s 40: above it the function refuses the call
and the identity stage would fail on every tick.

### Repair budget and drain rate

The repair lane is how history is re-parsed after a parser version bump, so
its budget is the drain rate. It executes `REPAIR_JOBS_PER_SWEEP` = 28 jobs a
tick:

```text
28 jobs x 12 ticks/hour = 336 artifacts/hour
vpass-statement-page 1.2.0, 3,133 artifacts at 1.1.0 on 2026-09-24:
  3,133 / 336            = 9.3 hours   (28 jobs a tick)
  3,133 / (4 x 12)       = 65 hours    (the former 4 jobs a tick)
```

The scan that creates the jobs is not the bottleneck. It walks 100 artifact
ids a tick; on 2026-09-24 the 1.2.0 work not yet scanned was 1,617 artifacts
in the 4,169 ids beyond its cursor, about 39 per 100 ids, more than the 28 a
tick executes, so the lane has ready work for the whole drain.

What sets 28 is the identity sweep later in the same tick. A published
re-parse needs its identity run before the read models resolve its rows to an
account (current card usage, the account a Transactions row is organized
under), and
`identitySweep` takes at most 40 parse runs and 200 observations per call. The
scheduled stage passes `IDENTITY_RUNS_PER_TICK` = incremental 12 + repair 28 =
40, so a tick's incremental and repair runs fit its run cap. At the function's own default of 8, which the stage used before, a 28-job
tick would leave 20 published re-parses without identity on every tick of a
drain.

The run cap is not the only bound, so a re-parse is identified on the tick
that published it only when two more things hold. The sweep stops at 200
observations: on 2026-09-24 Vpass statement pages carried 1.47 on average
(2,599 of the 3,101 published 1.1.0 runs are empty), about 41 a tick, but the
largest has 69, and three such pages in one tick already reach 200; a run cut
at the 200th row keeps its identified pages and is sealed on the next tick,
and the runs after it wait
(`identity-store.test.ts` "a 40-run sweep stops at 200 observations…"). And
the sweep takes published runs in parse-run id order, so an older backlog goes
first: replay jobs (8 a tick, operator-started), the operator's own `/sweep`
calls (`catchup`, `sweep repair`) and an identity policy bump publish or
reopen runs the identity budget does not reserve. With incremental, repair and
replay all at full budget, 48 runs publish a tick against 40 slots. A deferred
run is identified on a later tick; until then its rows read with no account
(`source_account_id` null in current card usage), purchase recognition skips
the parse and reaches it after its cursor wraps, and the seal bumps the CORE
revision the balance projection rebuilds from.

One repair job, measured on synthetic Vpass statement pages under Miniflare
with counting D1 and R2 proxies, and on production counts read on 2026-09-24:

| Measurement                             | Value                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------- |
| D1 per job                              | 14 statements and 1 batch (the 5-statement publish); 13 for an empty page  |
| R2 per job                              | 1 `get` of the raw object                                                  |
| Per repair sweep, besides the jobs      | 9-12 D1 statements and 1 insert batch (scan, ready query, counts, state)   |
| Parser CPU, parse + serialize + SHA-256 | 0.6 ms (20 rows, 6 KB), 2.4 ms (100 rows, 29 KB), 7.3 ms (300 rows, 85 KB) |
| Job CPU counted on the test process     | 46-63 ms, Miniflare's proxy work included (an upper bound)                 |
| Identity sweep, production-shaped tick  | 29 re-parses (25 empty, 40 observations): 66 D1 calls, all identified      |
| Production page size                    | 3,314 pages, 2.6-2.8 KB on average, 23 KB at most                          |
| Production wall time per job            | 0.32-1.1 s (gaps between consecutive 1.2.0 parse runs, 6 ticks)            |

Against the limits of one scheduled invocation, per Cloudflare's
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
(last updated 2026-09-05, the page `docs/vpass-card-identity.md` cites):

| Limit                                                       | 28 repair jobs                             |
| ----------------------------------------------------------- | ------------------------------------------ |
| CPU, Cron Trigger with an interval under one hour: 30 s     | under 2 s at the upper bound above         |
| Subrequests, Workers Paid (D1 and R2 included): 10,000      | about 450 (16 a job)                       |
| Wall time, Cron Trigger: 15 minutes; the cadence: 5 minutes | at most 31 s at the slowest production job |

`limits.cpu_ms` (300,000) in `wrangler.jsonc` raises the HTTP ceiling; the
page lists the cron trigger ceiling separately, so the budget is sized against
30 s. [D1's limits page](https://developers.cloudflare.com/d1/platform/limits/)
(last updated 2026-04-21) still lists 1,000 queries per invocation for Workers
Paid by reference to the subrequest limit the Workers page has since raised to
10,000, and counts a batch as one query.

That figure counts the whole tick, not only the repair jobs. Measured on
Miniflare with a counting proxy on both D1 bindings and every flag of
`wrangler.jsonc` on, on synthetic balance artifacts (one row each):

| Tick                                                        | D1 calls (a batch is one) | `observation_sweep` | `identity_sweep` | Other nine stages |
| ----------------------------------------------------------- | ------------------------- | ------------------- | ---------------- | ----------------- |
| Every budget: 12 + 28 + 8 jobs, 40 one-row runs to identify | 1,470                     | 795                 | 601              | 74                |
| The next tick: 12 repair + 4 replay jobs, 24 runs           | 694                       | 275                 | 361              | 58                |

A non-empty run costs `identity_sweep` about 15 calls and an empty one next to
nothing (29 production-shaped re-parses, 25 empty: 66 calls), so a Vpass drain
tick of 28 repair jobs is about 500 + 66 + 74, roughly 640. The other stages
were measured with almost no data of their own; with work they cost more.
Before this change a tick at every budget (24 jobs, 8 identity runs) was
roughly 630 by the same figures. So the worst case is under the Workers
page's 10,000 but above the D1 page's 1,000; see
[not verified](#verified-locally--not-verified).

The repair lane runs inside `observation_sweep`, the first stage, so the
stages after it start later by the extra jobs' wall time and do no less work:
each keeps its own bound.

## Health signals

`GET /status` returns, in addition to the existing parser list and job counts:

| Signal (review §2)             | Field                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Latest sealed evidence arrival | `freshness.latestSealedAtMs`, `freshness.latestSealedArtifactFetchedAtMs`                                                    |
| Latest published parse         | `freshness.latestParsedAt` (`max(parsed_at)` over `published_observation_parses`, so an unadopted success never advances it) |
| Per-lane backlog and failure   | `lanes.<lane>.{pending,running,done,failed}`                                                                                 |
| Oldest pending age per lane    | `lanes.<lane>.oldestPendingAgeMs` (null when no pending job or the job predates 0035)                                        |
| Notification backlog           | `workItems.unprocessed`, `workItems.oldestUnprocessedAgeMs`                                                                  |
| Lane liveness                  | `laneState[]` (last sweep time, last created/executed counts, cursor)                                                        |
| Replay progress                | `replayPlans[]` (active plans and plans updated in the last seven days)                                                      |
| Scheduled lane ticks           | `laneTicks[]` (latest `processor_lane_ticks` row per lane: outcome, safe code, age, counts; `docs/processor.md` §6.1)        |

Eligible/unsupported/oversized reasons, parsed-B versus sealed-identity
coverage, candidate-versus-active, and raw integrity results remain on the
evidence-browser metadata API and identity audit; they are not duplicated here.
No field carries an amount, a raw body, a token or a provider URL.

The scheduled handler logs each stage as its own JSON event with counts only,
in this order (`runScheduled` in `services/processor/src/worker.ts`). In the
`observation_sweep` line every lane reports its `budget`, the jobs it
`executed` (parsed or failed) and the jobs still `pending` in it, so a drain's
progress is readable tick by tick. `pending` uses the ready query's own
eligibility (`RUNNABLE_JOB_SQL`) without its clock: a job backing off is
counted, one out of attempts, of a parser version this build does not deploy
or of a paused or cancelled replay plan is not, since it never drains. It
reads the lane's pending rows through `observation_jobs_lane_ready`
(`repair-budget.test.ts` "pending counts only repair work that can still
run…"):

| #   | Event                    | Gate                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `observation_sweep`      | Always. The candidate lane inside it is gated by `RELEASE_CANDIDATES_ENABLED = "true"` (A04, `docs/release-adoption.md`).                                                                                                                                                                                                        |
| 2   | `collection_scan`        | Always; lists and registers only when `SHARED_R2_INGEST_ENABLED` is `"1"` or `"true"`, otherwise logs `status: "skipped"` (U08, `docs/processor.md`).                                                                                                                                                                            |
| 3   | `identity_sweep`         | Always (`docs/identity.md`).                                                                                                                                                                                                                                                                                                     |
| 4   | `balance_projection`     | Always runs and reports itself `skipped` while `BALANCE_PROJECTION_ENABLED` is anything but `"1"` (`docs/balance-read-model.md`). With `READ_PROJECTION_ENABLED` on it writes the READ database instead of the CORE tables of migration 0030, and completes the CORE job only after READ is published (`docs/read-model-d1.md`). |
| 5   | `reconciliation_sweep`   | Only when `RECONCILIATION_ENABLED` is `"1"` or `"true"`; otherwise the stage is not run and logs nothing. Runs stage A only for Vpass and MyJCB, whose pending-to-posted pairs are `purchase_recognition`'s candidate pass, so it reads its pages and proposes nothing (`docs/economic-events.md`).                              |
| 6   | `card_settlement_sweep`  | Under the same flag as `reconciliation_sweep`, as its own lane: card statement totals and bank debits become settlement candidates (`docs/card-settlements.md`).                                                                                                                                                                 |
| 7   | `purchase_recognition`   | Only when `PURCHASE_RECOGNITION_ENABLED` is `"1"` or `"true"`; otherwise the stage is not run and logs nothing. Turns adopted Vpass/MyJCB usage rows into purchase and refund events, then writes pending-to-posted candidates for the groups it read and merges only provider-linked pairs (`docs/economic-events.md`).         |
| 8   | `reward_claims_sweep`    | Only when `REWARD_CLAIMS_ENABLED` is `"1"` or `"true"` (`docs/rewards.md`).                                                                                                                                                                                                                                                      |
| 9   | `reward_read_projection` | Only when `REWARD_READ_PROJECTION_ENABLED` is `"1"` or `"true"` (U16, `docs/rewards.md` §12).                                                                                                                                                                                                                                    |
| 10  | `report_job`             | Only when `REPORTS_ENABLED` is `"true"` (`docs/calculation-and-reports.md`).                                                                                                                                                                                                                                                     |
| 11  | `operation_dispatch`     | Always; dispatches only when `OPS_DISPATCH_ENABLED` is `"1"` or `"true"`, otherwise logs `status: "skipped"` (U06/U08, `docs/processor.md`, `docs/ops-api.md`).                                                                                                                                                                  |
| 12  | `decision_outbox`        | Always, and last: it runs after the projections a decision may have invalidated (A09, `docs/change-lifecycle.md`).                                                                                                                                                                                                               |

Why those positions. `collection_scan` registers terminals the shared DATA
bucket already holds, so it runs before `identity_sweep`: a run it finds this
tick can reach identity and parsing on the same tick instead of waiting for the
next one. `purchase_recognition` follows `reconciliation_sweep`, which reads
the same card usage rows only for provider-issued ids, and runs after `identity_sweep`
so a row whose card was resolved this tick can be recognised on it.
`reward_read_projection` builds from the claims
`reward_claims_sweep` promotes, so it follows it. `operation_dispatch` hands
accepted operations to their executor, so it runs before the outbox — work
accepted this tick can still reach it — while `decision_outbox` keeps its
place at the end.

Neither is a parse lane: they create no `observation_parse_jobs` rows and have
no job budget. `collection_scan` is bounded by one R2 list page and a
registration count per tick; its cursor lives in `collection_scan_state`, not
in `observation_lane_state`.

Each stage is isolated: a failure is logged as its own `<event>_failed` line
and never stops the stages after it, so a parse-sweep failure does not prevent
the identity sweep from running. A failure code is either the pipeline's safe
code or the error's constructor name, never exception text. Health signals,
load budgets and the recovery drills for these stages are in
`docs/operations.md`.

The lanes that keep no state of their own — `identity_sweep`,
`reconciliation_sweep`, `card_settlement_sweep`, `purchase_recognition`,
`reward_claims_sweep`, `operation_dispatch` and `decision_outbox` — also
record every tick in `processor_lane_ticks` (migration 0049): `ran` with its
counts, `failed` with the same safe code, or `skipped-by-flag` when the gate
above is off, which still logs nothing. The last day per lane is kept
(`docs/processor.md` §6.1).

## Invariants kept and how they were verified

Synthetic fixtures only, under Miniflare D1/R2 (`services/processor/test`):

| Invariant                                                                                                            | Test                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| New sealed run gets a job on the next sweep without a cursor cycle; lane-scoped sweep leaves the repair cursor alone | `lanes.test.ts` "a newly sealed run gets its job on the next sweep…"                                   |
| Replay backlog of 200 does not block incremental jobs in the same sweep                                              | `lanes.test.ts` "a replay of 200 artifacts…"                                                           |
| Lost notification recovered by repair                                                                                | `lanes.test.ts` "a dropped notification is recovered…"                                                 |
| Pause/resume idempotent; live lease fenced; one `ok` per artifact/version                                            | `lanes.test.ts` "pause/resume is idempotent…"                                                          |
| High-water fixed; cancel never touches published results                                                             | `lanes.test.ts` "the replay high-water is fixed…"                                                      |
| Identity sweep runs and is logged separately when parse sweep fails                                                  | `lanes.test.ts` "identity sweep still runs…"                                                           |
| More repair work than one budget: exactly the budget per tick, the rest next tick; identity takes them on the tick   | `repair-budget.test.ts` "a tick with more repair work than the budget…"                                |
| A 40-run identity sweep stops at 200 observations; the next sweep identifies and seals the rest                      | `identity-store.test.ts` "a 40-run sweep stops at 200 observations…"                                   |
| Migration 0035 applies after 0017–0024 through D1; full chain 0001–0035 compiles; old Worker's insert still works    | `harness.ts`, `pipeline.test.ts` "all production migrations compile…"                                  |
| Existing lease, retry, supersession, retirement, metadata and parser behaviour                                       | all pre-existing tests in `pipeline.test.ts`, `job-retirement.test.ts`, `identity-*.test.ts` unchanged |

`services/raw-evidence` tests load every migration including 0035; the seal
paths in `store.ts` are unchanged and its suites cover sealing with the new
trigger present.

## Deploy order and rollback

1. Apply `packages/storage-d1/migrations/core/0035_observation_job_lanes.sql`
   (additive: `ALTER TABLE … ADD COLUMN` with defaults, three new tables, one
   trigger, one index). The running pre-0035 Worker keeps working during and
   after the migration: its job insert names only the original columns and
   every new column has a default; its `SELECT *` ignores extra columns; the
   trigger only appends work items it never reads.
2. Deploy `kogane-observation-pipeline`. The first sweeps consume work items
   appended since the migration (50 per sweep) and continue the scan cursor
   from where it was.
3. No reader deploy is needed; the evidence browser is unaffected.

Rollback target: the previous Worker build with migration 0035 left in place
(verified by the "all production migrations compile" assertion that the old
insert statement succeeds and lands in the incremental lane, and by the whole
pre-existing test suite running against the 0035 schema). Work items then
accumulate unprocessed until a lane-aware Worker returns; the old cyclic scan
still discovers every artifact. Do not roll the migration back; it is not
required and the old Worker does not need it removed.

Flags: none. The incremental and repair lanes are on by default because they
only change scheduling, not results. Replay plans exist only when an operator
creates one through the internal route; the cron never starts a plan.

## Verified locally / not verified

Verified with synthetic data: everything in the table above, `mise run //services/processor:typecheck`,
`wrangler deploy --dry-run`, the raw-evidence suite with 0035 present. The
repair budget was sized from the measurements in
[Repair budget and drain rate](#repair-budget-and-drain-rate). Not verified:
D1 query cost of `/status` on the real catalogue, and the CPU and wall time of
a 48-job worst-case sweep (incremental 12 + repair 28 + replay 8) inside a
whole production tick, which the Workers dashboard's cron invocation metrics
show; and whether D1's 1,000 queries per invocation still applies. A tick at
every budget measured 1,470 D1 calls, above it
([Repair budget and drain rate](#repair-budget-and-drain-rate)). If that limit
applies, such a tick fails partway, and every stage after the point logs its
`_failed` event; the budgets (repair and `IDENTITY_RUNS_PER_TICK` above all)
would then have to come down. Budgets are constants in `lane-budgets.ts` and should be tuned from
observed sweep durations.

## Open items for later PRs

- A budget of its own for candidate replays; today they share the replay lane's.
- Per-source fairness inside a lane.
- Identity projection as its own lane with budget and state rows; today it
  keeps its own budgets in `identity-store.ts` and is only isolated at the
  scheduled handler.
- The evidence-browser metadata API could surface `/status` lane fields for
  operators without a service-binding call.
