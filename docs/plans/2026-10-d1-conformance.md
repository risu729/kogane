# Isolated synthetic remote D1 conformance

- Status: fixed CORE0071 remote run independently verified and cleaned up; current CORE0072 integration has no remote evidence
- Date: 2026-10-09
- Current integration baseline: main 58fa20a8d0d43eb0a4220440f6c8152ee915d65f
- Historical remote baseline: main a72dfde6fdd9f7c9889f9b832cb106dd0ed52740 (#569)
- Implements the verification plan of [ADR 0054](../adr/0054-economic-consumption-guard.md)
- Scope: source, synthetic corpus, local binding tests, independent review and the completed fixed-CORE0071 evidence record
- Production writer gate: closed; no authorization or adoption capability changes

## Completed fixed run and current integration boundary

The approved isolated run on 2026-10-09 used frozen head
`a35186ddd2346dcb30f9d0a3090aae4974e3b99f`, CORE through 0071,
corpus `1fd71e8f31b334b2f7c3107f88d68345618cc7c31a17cf6b56e921457fdb1e74`
and migration digest
`e93ad373ccab5a784167a68e5e9fb9b8ff92c841b9bd3d08610a43f2765c239b`.
All 45 remote cases passed, FK/unlogged counts were zero, and separate matching
Worker invocation telemetry recorded CPU 127 ms and wall time 45,686 ms. Cron
was disabled; the identified experiment Worker/new DB were deleted and exact
absence responses retained. The dedicated heartbeat was removed. Cleanup
completed at 16:21:42 JST before its deadline. A fresh evidence reviewer and
follow-up review found no remaining P1/P2 within this narrow evidence scope.
Private raw evidence stays in the operator handoff; only synthetic aggregates
and source pins are recorded here and in #600's acceptance record.

The raw report retains `cpuMs:null` and `remoteGateSatisfied:false`: cases,
pins, separate CPU telemetry and identified-resource cleanup were joined in a
separate evaluation. Saved account-list evidence is a reduced count/match
summary, not retained full account rows or Worker pagination. Known usage is
a lower bound of reads 238303 / writes 11725; final storage was 2068480 bytes.
Complete cumulative usage and actual additional billing below USD1 remain
unproved. The run did not establish production-writer or authorization
suitability, deployed module-byte readback or an exhaustive lifetime invocation
audit, and opened no production gate.

Integrating current main preserves the runner, generator, cases and seed
source. The generator still discovers all CORE migrations and uses the current
Git HEAD; it does not silently freeze the former runtime baseline. CORE0072
adds `own_transfer_proposals` and `own_transfer_proposal_retirements`, raising
the CORE baseline from 134 to 136 tables. Existing baseline counts, the 45 case
payloads and 53 seed statements remain unchanged. The current migration digest
is `61694eeba4c6b1836f0d208f951708c9ef5434c5545e3792593a19e6db262a6d`.
The generated corpus and bundled Worker bytes therefore differ from the
completed remote run. That run remains evidence for its original head/CORE0071
and is not relabelled as current-head/CORE0072 hosted conformance. Current
schema binding tests are local only; they do not test the own-transfer planner
or authorise another remote run. The procedure below is the design for a
future separately scoped run, not an instruction to repeat the completed run.

## Purpose and evidence boundaries

Exercise the shipped CORE 0070/0071 guards through a real Worker D1 binding's
`env.DB.batch()`, using synthetic data exclusively. `wrangler d1 execute`
is one possible setup/report-retrieval tool; control-plane setup or readback
success is not binding-batch conformance evidence. The completed operator run
used the existing control-plane API for setup/readback and the Worker binding
for conformance. Current source integration performs no new Cloudflare writes,
resources, remote query, credentials read or migration application. Existing main/worktrees and production deployment ownership stay
with their current operators.

This experiment tests database invariants, not command authorization. Its
synthetic principals are strings, including a synthetic owner-delegated
principal in command-table fixtures. It does not introduce a human-only actor
constraint or grant an AI a capability. Shared UI/MCP authorization and audit
remain the separate auth/audit work; this code leaves current gates unchanged.

## Implementation

`experiments/d1-conformance/scripts/corpus.ts` uses the existing
`seedCardRows`/`factOf` fixtures, CORE migrations and production statement
builders. The generated corpus contains only invented rows and immutable
release/migration pins. No provider capture or credential is opened. The
generic synthetic writer repeats ADR 0054's fixture shape solely to exercise
claims, times and effects; it is not an own-transfer planner.

The runner first compares count-only baselines, then checks the exact expected
CORE table names before reading any row snapshot. A wrong/nonempty store
stops before fixture writes and content snapshots. It compares sorted content
of every CORE table after every rejected batch and every sequential replay:
counts, commit log, epoch/source revisions and supersede pointers all count.
Small bounded queries avoid function-argument, compound-SELECT and SQL-length
limits. The runner computes and enforces a conservative submitted-statement
upper bound of 950 including its Worker control writes; the prepared 45-case
corpus has upper bound 933, below Paid's 1000. The complete suite is designed for Workers Paid; Free's invocation
query allowance is insufficient. No limit increase is requested.

The Worker has `workers_dev:false`, `preview_urls:false`, no routes, no
service/DO/queue/R2 bindings, no secrets and no HTTP execution path (404 for
every request). It accepts no payload or SQL. The committed config has no
cron, an invalid sentinel database ID and `RUN_AUTHORIZATION:"disabled"`.
Deployment is not part of any task: CI runs types, tests and dry-run only.
After approval, the single activation pin is the reviewed corpus digest,
which is public configuration, not authentication material. An experiment
control row reserves the run once; duplicate schedules do not reseed or rerun
partial work. Failure requires preserving the evidence and requesting a
new plan, not clearing the control row or deleting CORE rows.

## Cases and pass conditions

| Case        | Required evidence                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1          | RAISE(ABORT) at every statement position; all CORE content/counts unchanged, no orphan decision/revision/seal/commit                                                                                 |
| A2          | Populated claims, seals, commit log, identity epochs, times and leg effects refuse UPDATE and DELETE; unchanged snapshots                                                                            |
| A3          | Second live holder refused by key and independently by alias class across different keys; accept either declared collision code, no dependence on trigger order                                      |
| A4          | Final commit without its seal refused; entire batch rolls back                                                                                                                                       |
| A5          | Nonconsecutive identity epoch refused; after epoch advance, stale-epoch adoption rolls back whole                                                                                                    |
| A6          | Production card purchase recognition builder succeeds; second execution writes zero changes and leaves the complete store unchanged                                                                  |
| A7          | Four 0071 command kinds accepted in plans and receipts; unknown and reserved resolution kind refused; allowed plan status/publication transitions succeed, identity fields cannot change with status |
| A8          | Real current-revisions query receives 1000 subject IDs through exactly one JSON bind and returns 1000 rows; metrics recorded                                                                         |
| Competition | Two independent batches compete for one key: exactly one accepted, one declared rejection, one live holder; two identical concurrent batches accept once and replay with zero changes                |
| Final       | No foreign-key violation and no unlogged economic revision                                                                                                                                           |

For successful batches, report returned statement count, submitted statement
count, D1 duration/rows_read/rows_written and changes, preserving missing
metadata as null. Rejected batches have submitted statement count but no
returned metadata; duration/rows/actual executed count are unknown. They are
not zero-cost. CPU is not D1 duration or JavaScript elapsed time: the report
uses null and requires separate Worker invocation telemetry. Metrics describe
the deliberately small synthetic store, not production scale or savings.

A remote report deliberately keeps `remoteGateSatisfied:false`; the root
must join successful remote cases, pinned identity/binding/migration evidence,
CPU evidence and verified cleanup before declaring this gate satisfied.
Local Miniflare proof does not open the production gate.

## Approval and fixed identities for a future run

The completed run's database and Worker have been deleted; their identity
remains in the private immutable evidence. A future run has no database ID yet. Cloudflare assigns the ID at creation; inventing
one or selecting an existing database is prohibited. Use two explicit stages:

1. Root approves creation only for database **kogane-d1-conformance-20261009**,
   and the proposed Worker of the same name, in the already approved Kogane
   account. Before creation, prove those exact names absent with account-scoped
   listings. A name collision is a stop; never reuse or overwrite it.
2. Record the returned database UUID, exact account ID and Worker name in a
   local run manifest, including approved commit, migration digest, corpus
   digest, desired cron UTC time, cost bound and cleanup owner/deadline.
   Read back name/UUID using `d1 info`; compare UUID against every production
   CORE/READ UUID from the repository resource ledger without querying those
   databases. Root approves that concrete manifest before any migration,
   Worker deploy or execution. Every later command uses that config/UUID,
   never a production config, ambiguous name, automatic provisioning or
   inherited environment. An ID mismatch stops work.

The deployment operator, coordinated by root, alone performs these steps.
This preparation agent does not also deploy or query the same resources.
Use existing operator control-plane authorization; no new token, Access app,
secret or runtime credential is necessary. Lack of the needed permission
stops execution; it is not authority to expand permissions.

## Future operator procedure (completed once on the historical pins)

From the isolated approved checkout:

1. Freeze the reviewed commit; regenerate the corpus and record its digest.
   Repeat local CI and Wrangler dry-run. Reject changed SQL, migrations,
   fixtures or config until reviewed again.
2. After stage 1 approval and absent-name verification, create the exact D1
   name. Do not allow Wrangler to edit production config. Capture the assigned
   UUID and obtain stage 2 manifest approval.
3. Generate a local-only operator config in a git-ignored directory. It keeps
   the committed closed ingress and binds **only** the approved new D1 UUID,
   with no secrets or other resources. Rebase both `main` and
   `migrations_dir` to absolute paths within the frozen approved checkout;
   copying relative paths into a different config directory is invalid.
   Verify those resolved paths and the bundle entry before proceeding.
   Use the experiment config's CORE migration directory. Apply CORE migrations
   through that run's reviewed `lastMigration` to the new UUID and `setup.sql`
   to that same UUID. The completed run stopped at 0071; current generation
   includes 0072 and has no matching remote-run evidence. No production migrations run.
   Read `d1_migrations`, count baselines and `foreign_key_check`; record
   the final schema pin/digest. Partial migration is failure, never approval
   to change the shipped migrations.
4. Deploy the Worker first with no cron and disabled activation. Read back
   deployment ID, binding UUID, closed workers.dev/preview/routes and absence
   of secrets. Set up exact Worker telemetry capture before activation.
5. Only then deploy activation pin plus one UTC cron occurrence for a
   sufficiently future minute (allow control-plane propagation, which can
   take up to 15 minutes). A date-specific cron repeats yearly; the control
   row limits database execution once, and cleanup removes the cron/Worker.
   Record the UTC occurrence and Tokyo conversion. Do not use a per-minute
   repeated trigger, public route, preview URL or production service binding.
6. Wait for the chosen occurrence with a finite deadline. Read only the
   experiment's `conformance_run` report via its approved UUID. Preserve
   remote case results and invocation CPU/wall-time telemetry with
   deployment/corpus pins. Unknown CPU is an unresolved A8 item; do not
   relabel it zero or infer it from D1 duration.
7. Disable the cron first, read back an empty schedule list, capture the
   synthetic report, delete the exact experiment Worker, then delete only the
   manifest's new UUID. Do this on success, failure or timeout. Never remove
   a production resource or any preexisting same-name resource.
8. Verify Worker-specific lookup absent, exact D1 UUID lookup absent, and
   account-scoped lists contain neither exact resource. Permission/transport
   errors do not prove absence. Preserve any cleanup failure and hand it to
   the cleanup owner; do not claim completion until absence is verified.

Set a finite cleanup deadline in the concrete manifest (proposed: 60 minutes
after the scheduled occurrence) and an operator who remains available through
cleanup. No unattended persistent resource is authorized by this plan.

## Cost and limits

New D1 storage, migration writes, synthetic statement reads/writes, Worker
CPU/invocations and observability can add account charges after included
allowances; neither a free run nor a fixed price is promised. Root must approve
a spending bound and abort/cleanup rule before stage 2. Capture actual
successful D1 metrics, but failed-query cost and storage cannot be derived
from returned successful metadata alone. Do not buy a plan, alter billing,
enable replication, increase account limits or add resources to finish this
experiment. If the existing account plan cannot support the bounded invocation,
revise and review the plan before running.

## Validation record

Current-main integration uses the existing native coverage runner for the
experiment test task and registers its Bun suite in the coverage collection
manifest. Its Bun coverage configuration excludes only the ignored generated
corpus from coverage reports; the corpus remains imported and exercised by
the same tests. This follows the repository CI contract without changing the
conformance Worker, case payloads or test assertions.

Preparation validation and independent review results are recorded with the
reviewed commit in the handoff. Existing pinned Miniflare
`5.20260831.0-alpha` supports local compatibility date `2026-09-07`;
the proposed remote config uses `2026-10-09`. This difference is explicit,
and passing local tests cannot prove that remote runtime.

## Official references checked 2026-10-09

- [D1 binding batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 result metadata](https://developers.cloudflare.com/d1/worker-api/return-object/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cron triggers and propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Worker real-time telemetry](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)
