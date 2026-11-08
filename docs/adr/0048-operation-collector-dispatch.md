# ADR 0048: Run an accepted collection or session refresh once through the named collector RPC

- Status: accepted (merged 2026-10-08 in #576; production dispatch unverified)
- Date: 2026-10-08
- Issue: #544
- Amended: 2026-11-08, a collection with more than 100 runs
  ([below](#amendment-a-collection-with-more-than-100-runs-2026-11-08);
  proposed)

## Context

The operations API (CORE 0040, [ops-api.md](../ops-api.md)) accepts
`POST /api/ops/v1/collections` and `POST /api/ops/v1/sessions/{source}/refresh`
and stores one idempotent record per request. Until this change the Processor's
`operation_dispatch` lane parked every such request at
`dispatch_pending` / `awaiting_collector_dispatch`: an accepted request never
reached a collector. Separately, the alarm path of
[ADR 0039](0039-alarm-schedule-management.md) already calls each collector's
private `ScheduledCollection` entrypoint over the `SCHEDULE_<WORKSPACE>`
Service Binding, under a shared execution lease
(`collection_execution_leases`), and records which runs it produced.

Issue #544 asks that an operator can request a collection through the common
API and follow it to its execution and its published result or an explicit
terminal reason, without a generic URL executor, without running the same
source twice at once, with idempotency, retry policy, a human-required state,
failure and expiry as closed states, and with acceptance, start, collection and
publication kept apart.

`OPS_DISPATCH_ENABLED` is already `"true"` in the committed Processor
configuration, and the App names an operator. Wiring the collector call under
that flag alone would let the first deploy contact providers for any request
already stored.

## Options considered

1. **Call `runScheduled(cron, time)` from the dispatch lane.** No collector
   change, but the request would carry no source, connection or action, a
   misrouted binding would collect the wrong source silently, and nothing would
   distinguish an operation from an alarm occurrence.
2. **A new transport or a generic executor** (HTTP trigger URLs, a queue of
   commands, an "invoke this Worker" route). Refused by the issue and by
   [ops-api.md](../ops-api.md) ("the one thing the API deliberately cannot be
   is a generic proxy").
3. **A new Durable Object or a per-job operation queue inside `ScheduleAlarm`.**
   Would avoid awaiting a collector inside the Processor tick, but needs a new
   DO class or a change to the alarm's reservation logic, and a new deployment
   migration.
4. **A closed `runOperation` method on the existing `ScheduledCollection`
   entrypoint, called from the existing dispatch lane over the existing
   binding, with a dedicated per-request execution table.** Chosen.

For the request vocabulary, extending the 0040 `status` CHECK was impossible
without rebuilding an immutable table, and adding states to `ops_requests`
would mix acceptance (a core-keep fact) with execution (operational state).

## Decision

### The call

- A **connection** is an alarm job of `config/alarm-jobs.json` that binds a
  source to a collector Worker: `OPERATION_CONNECTIONS` in
  `packages/collection/src/operation-rpc.ts` is its closed mirror (connection
  id = job id, workspace, lease source, terminal source, action, cron), and a
  test fails when the two differ. `collect` connections are the supported
  `collection` jobs; the only `refresh-session` connection is SBI VC's
  `sbi-vc-keepalive`. SMBC Direct and V Point Pay have none.
- The Processor resolves the one connection whose terminal source maps (through
  `COLLECTOR_SOURCE_IDS`) to the request's CORE source for the request's action,
  and calls `env.SCHEDULE_<WORKSPACE>.runOperation(request)` — the binding name
  computed by the same helper the alarm now uses
  (`services/processor/src/collector-binding.ts`). The request is
  `{version, operationId, connectionId, source, action, requestedAtMs}`:
  identifiers and a time only.
- Each collector's `runOperation` (`runCollectorOperation`) refuses, without
  contacting anyone, a malformed request (`operation_invalid`), another
  collector's connection or another source (`connection_mismatch`) and an
  action the connection lacks (`action_unsupported`). A valid request runs the
  connection's own job through the collector's own `runScheduled(cron, time)`
  — the alarm's code path, including `withCollectionLease`.
- Each collector's `alarmCollection` now reports a lease refusal as
  `collection_busy` instead of `collection_failed`
  (`scheduledFailure`), for the alarm receipts and for operations alike. The
  lease helper itself is unchanged.

### Gates, in order, before any call

1. An execution that already left `waiting` is never started again.
2. No connection serves the source and action → `unsupported`
   (`collection_unsupported`, `session_refresh_unsupported`).
3. Not started within 24 hours of acceptance → `expired`
   (`operation_expired`).
4. The connection is not listed in the new Processor variable
   `OPS_COLLECTOR_DISPATCH_CONNECTIONS` (a JSON array; empty, absent or
   malformed means none, and the committed value is empty) → waits
   (`collector_dispatch_disabled`, re-checked hourly) and so expires unless the
   owner enables the connection.
5. An enabled connection without a binding in this deployment →
   `unsupported` (`collector_binding_missing`).
6. An open provider maintenance window (the alarm's own
   `maintenanceForSchedule`/`afterMaintenance`) → waits until it closes
   (`provider_maintenance`); windows that never close
   (`maintenance_unavailable`) → the same wait, re-checked hourly.
7. The source's execution lease is held → waits five minutes
   (`collection_lease_held`). This is a read; the operation path never claims,
   releases, replaces or expires a lease.
8. One collector start per Processor invocation → others wait for the next
   tick (`dispatch_deferred`).

A human-required session refresh (`SESSION_REFRESH_POLICY`) is still stored
`waiting_for_human` with `dispatch_state='not_required'`; the dispatch lane never
sees it and nothing expires it (本人操作待ち).

### Start, outcome and tracking

- Migration **0068** adds `ops_collector_dispatches`, one row per operation,
  classified `operational-mutable`: states `waiting`, `started`, `collected`,
  `refreshed`, `published`, `unpublished`, `failed`, `uncertain`, `expired`,
  `unsupported`, with a closed `reason_code`, the reported run ids (written
  once, at most 100) and `accepted_at`, `expires_at`, `started_at`,
  `collected_at`, `published_at`, `finished_at`. Triggers refuse deletion, an
  insert in a started state, a started row returning to `waiting` (`starts` is
  0 or 1), reopening a terminal state and rewriting reported runs.
- The start is one D1 batch: the guarded `waiting → started` update and the
  request's `status='running'`, `dispatch_state='dispatched'`,
  `target_ref='collector:<connection>'`. Only the caller whose update changed
  the row calls the collector.
- The answer is re-validated (`collectorOperationResult`). `completed` →
  `collected` with the `persisted` stage (or `refreshed`, completing a refresh,
  which has no stages). A collector failure → `failed` with its closed code
  and any run it still persisted (`collection_busy` included: the lease was
  taken between the lane's read and the collector's claim; St George's
  coordinator instead persists a failed run (`container-failed`) for a refused
  lease, its existing behaviour, answers `collection_failed`, and — as after
  any failed St George run — refuses later runs until the operator resumes it;
  see [St George](../sources/st-george.md)). An exception, or an answer outside the closed shape →
  `uncertain` (`dispatch_uncertain`, `collector_result_invalid`). A start with
  no recorded outcome after one hour → `uncertain`. **Nothing after a start is
  retried automatically**; a new idempotency key is how an operator asks again.
- Each tick, collected executions due for a look have their trail read from
  CORE: run → `collection_runs` (registered fetch run, `r_<id>`, the 取得記録
  link) → its sealed run's parse scheduling (`observation_work_items`) →
  artifacts → parse jobs and parse runs → `published_parse_runs`. Stages
  `registered`, `parsed` and `adopted` are written from those rows only. When
  every run has settled the execution is `published` (one run adopted a
  parse) or `unpublished` with the first closed reason (`registration_blocked`,
  `provider_failed`, `no_parser_selected`, `parse_failed`, `not_adopted`,
  `run_not_reported`); after 48 hours without settling it is `unpublished`
  with `publication_not_observed`. `projected` (READ) is not traced, so a
  published collection keeps `status: running`.
- `GET /api/ops/v1/operations/{id}` returns the existing record plus an
  `execution` block (state, connection, reason, `scope: "collector_default"`,
  waits, timestamps and the live per-run trail with artifact counts). The
  existing `kogane.ops.operation.get` MCP tool calls the same service; no MCP
  tool, schema, grant or client connection is added here (that is #559's
  contract).
- The collector runs its connection's daily scope. A requested window is stored
  with the request and is **not** applied (`scope: "collector_default"`).

### Libraries and reuse

No dependency is added. The App's request schemas stay Zod; the collector-side
request check is the dependency-free closed-key style of
`packages/collection/src/manifest.ts`, because that package is bundled into
every collector and the check is six fields. Idempotency is the 0040 operation
id plus the 0068 primary key and a guarded update inside one D1 batch; the
maintenance deferral is the alarm's own model; the lease is the collectors' own
`withCollectionLease`; stage writes are `recordDispatch` and
`recordOperationStage`. The waits are fixed closed intervals rather than a
retry/backoff library, because the policy after a start is "never retry".

## Consequences

- An accepted collection can reach a provider only when the owner adds its
  connection id to `OPS_COLLECTOR_DISPATCH_CONNECTIONS` in both Processor
  configurations, with `OPS_DISPATCH_ENABLED` on (it is) and an operator named
  in the App (it is). Until then, requests wait and expire after 24 hours. On
  the first ticks after deployment, requests already stored as
  `awaiting_collector_dispatch` become `unsupported` when no connection serves
  their source, `expired` (blocked, `operation_expired`) when they are older
  than 24 hours, and otherwise wait. No provider is contacted by that.
- A collector call is awaited inside the Processor tick, as the alarm awaits
  it inside its alarm. A long collection lengthens that tick and delays the
  decision outbox lane by the same amount; one start per invocation bounds it.
  An invocation killed mid-call leaves `started`, which becomes `uncertain`
  after an hour, and the lease the collector held stays for the operator
  ([schedules.md](../schedules.md)).
- The trail read is bounded by the reported runs (≤ 100) and their artifacts,
  every lookup keyed (checked without table statistics).
- The alarm receipts now say `collection_busy` where a lease refusal used to be
  `collection_failed` (St George excepted, see above); Mizuho's alarm path now awaits its handler, so a lease
  refusal there is `collection_busy` instead of an RPC rejection recorded as
  `uncertain`.
- `awaiting_collector_dispatch` is no longer written.

Open limits, written down rather than guessed:

- Production dispatch has not run: no connection is enabled, and no deployed
  collector has served `runOperation`.
- The requested window is not applied by any collector.
- READ projection of a run is not traced; `projected` stays pending.
- The operator UI has no operations view; the trail is read over HTTP. The
  existing `kogane.ops.operation.get` returns the same record on this code, but
  MCP client access (#559/#565) is designed to stop publishing operations tools
  on `/mcp`; operation tracking over MCP is a follow-up read tool graded by an
  agent capability, never the operator role.
- Session refresh is unattended only for SBI VC's keepalive; every other source
  ends `session_refresh_unsupported` when its policy is unattended, and
  `waiting_for_human` otherwise.

## Verification

- `services/processor/test/collector-dispatch.test.ts` (real CORE schema,
  real registration, synthetic source and collector): success through
  accepted → started → collected → registered → published with distinct
  timestamps; failure; uncertain (exception and malformed answer); a start
  never finished; resend with the same key before and after the run (one row,
  one call); a raced claim; lease held (waits, lease untouched, starts after
  release); lease taken by the collector (`collection_busy`); unsupported
  session refresh and collection; human-required refresh; supported refresh;
  expiry of a disabled connection; maintenance deferral, including windows
  that never close; one start per tick;
  the 48-hour horizon; no parser selected; stored columns.
- `packages/collection/test/operation-rpc.test.ts`: the connection table equals
  `config/alarm-jobs.json`; request validation; refusals before any run; the
  closed result shape; the real lease helper's refusal mapped to
  `collection_busy`.
- `tests/collector-operation-rpc.test.ts`: terminal sources equal each
  collector's own constant, CORE sources map one connection per action, every
  workspace is bound under the shared name, and every scheduled collector's
  entrypoint serves `runOperation` and maps lease refusals.
- `packages/application/test/collector-trail.test.ts`: the 0068 guards, the
  trail's outcomes, and the query plans on a store without statistics.
- `services/app/test/ops-api.test.ts`: the HTTP read route returns the
  `execution` block for an accepted and for a collected request; HTTP/MCP
  parity unchanged.
- `services/processor/test/schedule-native-runtime.test.ts`: a real workerd
  Processor tick starts an accepted request once over a named service binding
  RPC.

Production dispatch, a real collector answering `runOperation`, and a
production trail to publication are unverified.

## Amendment: a collection with more than 100 runs (2026-11-08)

- Status: proposed
- Date: 2026-11-08
- Carried by: `MAX_RUN_IDS`, `RUN_IDS_OVER_LIMIT`, `scheduledCompletion`,
  `scheduledResult` and `scheduledFailure` in
  `packages/collection/src/schedule-result.ts`; `collectorOperationResult` in
  `packages/collection/src/operation-rpc.ts`; Vpass's `alarmCollection` in
  `services/collector-vpass/src/worker.ts`;
  [operations API](../ops-api.md#collector-execution-adr-0048)

### Context

An answer carries at most 100 run ids: `collectorOperationResult` refuses
more, and migration 0068 stores no more on an operation. The shared result
helpers already listed each run once and at most 100 of them. Vpass, which
persists one run per card, built its successful answer itself: every run it
persisted, unchecked. With more than 100 cards the Processor would refuse that
answer and the operation would end `uncertain` (`collector_result_invalid`)
with no run listed, although the collector knew exactly what it had written.
The alarm path stores its answer unchecked, so the same session's schedule
occurrence named every run; the collection-quality contract allows at most
100 `terminals` per occurrence, so such an occurrence would have put the whole
collection-quality summary outside its contract and the web client would have
refused the page.
The other collectors name at most one run per answer, through the helpers or,
for SBI VC's blocked session, only once its terminal is persisted.

### Options considered

1. List the first 100 and answer `completed`. Rejected: tracking follows a
   collected operation's listed runs to `published` or `unpublished` (every
   listed run settled), so it would state a verdict for a collection whose
   other runs it never read: `unpublished` while an unlisted run was adopted.
2. Answer with every run and let the Processor refuse it (today's result).
   Rejected: `uncertain` says the outcome cannot be known and links no run,
   while the collector knows it and could name 100.
3. Add a truncation marker to the answer and a state for it. Rejected for
   now: a new contract field (every collector and the Processor) and a new
   execution state (a migration) for a case only a Vpass session with more
   than 100 cards reaches.
4. Answer `failed` with the closed code `run_ids_over_limit` and the first 100
   runs, in the order persisted. Chosen.

### Decision

`scheduledCompletion(runIds)` builds a finished collection's answer:
`completed` with each run once, or, past 100 distinct runs, `failed` with
`run_ids_over_limit` and the first 100. `scheduledResult` uses it for a
successful value; Vpass's alarm uses it for its card runs. A failed collection
keeps its own code (a lease abort stays `uncertain`) and lists at most its
first 100 runs. `collectorOperationResult` checks the same `MAX_RUN_IDS`.

### Consequences

- No evidence is lost: every run's terminal is written and the collection scan
  registers it like any other. Only the operation's and the schedule
  occurrence's links stop at 100.
- Nothing more is claimed than is known: an over-limit operation is `failed`
  with a code that says why, and is not followed to publication.
- Open limit: a failed answer with more than 100 runs carries no marker, so
  its `runs` alone does not say whether the list is complete. Option 3 is the
  fix if that matters.
- The alarm shares the answer: a Vpass occurrence with more than 100 card runs
  is now `failed` with `run_ids_over_limit` and 100 runs, where it was
  `completed` with every run (the alarm stores the answer as given). The runs
  past 100 are registered like any other; only the occurrence does not link
  them. Its collection-quality source shows `occurrence_failed`, and the
  summary stays within its contract. An occurrence stored before this change
  with more than 100 runs is not rewritten.

### Verification

- `packages/collection/test/schedule-review.test.ts`: exactly 100 runs with
  repeats complete; 101 are `run_ids_over_limit` with the first 100; a failure
  keeps its code, the lease abort's included.
- `packages/collection/test/operation-rpc.test.ts`: every answer the helpers
  build, past the cap included, is one `collectorOperationResult` accepts.
- `services/collector-vpass/test/alarm-run-ids.test.ts`: synthetic sessions of
  100 and 103 cards, successful and failed, persist every terminal and answer
  within the closed shape.
- `packages/application/test/collection-quality-query.test.ts`: an occurrence
  naming 100 runs keeps the collection-quality summary within its contract;
  101 do not.
