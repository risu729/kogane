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
| `repair`      | The historical cyclic scan over `fetch_artifacts`                                   | `observation_scan_state` row 1 (unchanged meaning)                      | 4 jobs, 100 artifact ids per sweep                       |
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
| `/replay/inspect` | `planId`                                                                                                                          | Plan row, job counts by status, and whether the parser version is currently deployed.                                                                                                                                                                                                         |

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
- Jobs that already exist for an artifact/parser/version keep their lane and
  status; replay never re-opens failed jobs or resets attempts.
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

## Budgets and overrides

`POST /sweep` runs all lanes with the defaults above. `?maxJobs=N` (1–40)
overrides the incremental budget only, which is the historical meaning of the
sweep budget (`scripts/ops.ts catchup` relies on it). `?lane=incremental|repair|replay`
runs that single lane, with `maxJobs` applying to it. Maintenance always runs.

Per-source fairness inside a lane is not implemented; a slow source's failing
jobs back off exponentially and are ordered behind ready work, but a large
single-source incremental burst still consumes that lane's budget in artifact
order. Recorded as an open item.

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

Eligible/unsupported/oversized reasons, parsed-B versus sealed-identity
coverage, candidate-versus-active, and raw integrity results remain on the
evidence-browser metadata API and identity audit; they are not duplicated here.
No field carries an amount, a raw body, a token or a provider URL.

The scheduled handler logs each stage as its own JSON event with counts only,
in this order (`runScheduled` in `services/processor/src/worker.ts`):

| #   | Event                    | Gate                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `observation_sweep`      | Always. The candidate lane inside it is gated by `RELEASE_CANDIDATES_ENABLED = "true"` (A04, `docs/release-adoption.md`).                                                                                                                                                                                                        |
| 2   | `collection_scan`        | Always; lists and registers only when `SHARED_R2_INGEST_ENABLED` is `"1"` or `"true"`, otherwise logs `status: "skipped"` (U08, `docs/processor.md`).                                                                                                                                                                            |
| 3   | `identity_sweep`         | Always (`docs/identity.md`).                                                                                                                                                                                                                                                                                                     |
| 4   | `balance_projection`     | Always runs and reports itself `skipped` while `BALANCE_PROJECTION_ENABLED` is anything but `"1"` (`docs/balance-read-model.md`). With `READ_PROJECTION_ENABLED` on it writes the READ database instead of the CORE tables of migration 0030, and completes the CORE job only after READ is published (`docs/read-model-d1.md`). |
| 5   | `reconciliation_sweep`   | Only when `RECONCILIATION_ENABLED` is `"1"` or `"true"`; otherwise the stage is not run and logs nothing (`docs/economic-events.md`).                                                                                                                                                                                            |
| 6   | `reward_claims_sweep`    | Only when `REWARD_CLAIMS_ENABLED` is `"1"` or `"true"` (`docs/rewards.md`).                                                                                                                                                                                                                                                      |
| 7   | `reward_read_projection` | Only when `REWARD_READ_PROJECTION_ENABLED` is `"1"` or `"true"` (U16, `docs/rewards.md` §12).                                                                                                                                                                                                                                    |
| 8   | `report_job`             | Only when `REPORTS_ENABLED` is `"true"` (`docs/calculation-and-reports.md`).                                                                                                                                                                                                                                                     |
| 9   | `operation_dispatch`     | Always; dispatches only when `OPS_DISPATCH_ENABLED` is `"1"` or `"true"`, otherwise logs `status: "skipped"` (U06/U08, `docs/processor.md`, `docs/ops-api.md`).                                                                                                                                                                  |
| 10  | `decision_outbox`        | Always, and last: it runs after the projections a decision may have invalidated (A09, `docs/change-lifecycle.md`).                                                                                                                                                                                                               |

Why those positions. `collection_scan` registers terminals the shared DATA
bucket already holds, so it runs before `identity_sweep`: a run it finds this
tick can reach identity and parsing on the same tick instead of waiting for the
next one. `reward_read_projection` builds from the claims
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

Verified with synthetic data: everything in the table above, `mise run processor:typecheck`,
`wrangler deploy --dry-run`, the raw-evidence suite with 0035 present. Not
verified: production throughput of the per-lane budgets, D1 query cost of
`/status` on the real catalogue, and the CPU cost of a 24-job worst-case sweep
(incremental 12 + repair 4 + replay 8) on real artifact sizes. Budgets are
constants in `worker.ts` and should be tuned from observed sweep durations.

## Open items for later PRs

- A budget of its own for candidate replays; today they share the replay lane's.
- Per-source fairness inside a lane.
- Identity projection as its own lane with budget and state rows; today it
  keeps its own budgets in `identity-store.ts` and is only isolated at the
  scheduled handler.
- The evidence-browser metadata API could surface `/status` lane fields for
  operators without a service-binding call.
