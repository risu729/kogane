# ADR 0048: Run an accepted collection or session refresh once through the named collector RPC

- Status: accepted (merged 2026-10-08 in #576; production dispatch unverified)
- Date: 2026-10-08
- Issue: #544
- Amended: 2026-11-07, the `projected` stage is derived from the READ pointer
  ([below](#amendment-2026-11-07-the-projected-stage-is-derived-from-the-read-pointer);
  proposed)
- Amended: 2026-11-07, the operator's 依頼の経過 page
  ([below](#amendment-2026-11-07--the-operators-依頼の経過-page-proposed);
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
  coordinator originally persisted a failed run (`container-failed`) for a
  refused lease and refused later runs until the operator resumed it, and since
  2026-11-08 UTC answers `collection_busy` like the others and records no run;
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
- The operator UI reads one operation's trail on its 依頼の経過 page
  (amendment of 2026-11-07 below); no page lists operations, and the UI sends
  no operations request. `kogane.ops.operation.get` returns the same record to
  every MCP client
  ([ADR 0084](0084-mcp-operator-authority-without-delegation.md)), whichever
  principal requested the operation, the operator in the browser included
  ([ADR 0086](0086-operator-operations-list.md), owner 2026-11-08 04:21 UTC).
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

## Amendment 2026-11-07: the `projected` stage is derived from the READ pointer

- Status: proposed
- Date: 2026-11-07
- Carried by: `packages/application/src/operations/projection-trace.ts`,
  `trackCollectorPublication` (`collector-dispatch.ts`) and `readOperation`
  (`requests.ts`); the App's `opsContext` and the MCP tools' context
  (`services/app/src/ops-api.ts`, `ops-tools.ts`);
  [ops-api.md](../ops-api.md#collector-execution-adr-0048)

### Context

The decision above left `projected` (contracts/stages.json: "READ content
validated and published") untraced, so a collection whose runs were adopted
stayed `status: running` for ever and the operation record could never say
that the request had reached what a reader sees. Phase 3 of the
[roadmap](../roadmap.md#phase-3--coverage-collection-requests-and-cross-source-identity)
asks that a collection be followed to published observations.

CORE and READ are two databases that cannot be joined
([read-model-d1.md](../read-model-d1.md)). READ's pointer carries the
watermark `source_revision`: the published content was verified against that
CORE revision, and the pointer never moves back within an epoch. What CORE does
not keep is the revision at which a given parse was published:
`published_parse_runs` and `publication_events` have a time, and
`core_source_revision` is one row that only counts.

### Options considered

1. **Compare the snapshot's `published_high_water` parse run** with the
   request's published parse runs, at read time, writing nothing. Rejected: a
   parse run is published after it is created, so a lower id can be published
   after a higher one (a pending run finalised later, the activation of an
   older candidate release); the high water is the input summary migration
   0038 stopped trusting for exactly this reason.
2. **Compare times** (the execution's `published_at` with the pointer's
   `switched_at` or the snapshot's `created_at`). Rejected: both stored times
   come after the capture whose revision they publish, and the capture time is
   kept only in the input envelope in R2, so a capture taken before the
   publication can carry a later time.
3. **Compare the pointer with CORE's current revision** at read time. Sound,
   but not stable: the stage would complete and then fall back to pending as
   soon as any ledger write moved CORE.
4. **A column for the required revision** (on `ops_collector_dispatches` or a
   new table). Needs a migration; the 0040 stage row already has a reference
   column that is free until the stage completes.
5. **The Processor keeps watching published executions and writes
   `projected` completed.** It would materialise `status: completed`, but
   needs READ reads in the dispatch lane and a second watch: a `published`
   execution is terminal and its 0068 trigger refuses any later update, so it
   cannot be rescheduled without a migration or a scan of stage rows.
6. **Store the required revision when publication is recorded; derive the
   stage at read time.** Chosen. It is the decision outbox's rule
   (`required_source_revision`, [projection input](../projection-input.md)):
   a published snapshot at or above the revision a write reached carries it.

### Decision

- When `trackCollectorPublication` records an execution `published`, the same
  D1 batch inserts its `projected` stage row as `pending`, with
  `evidence_ref` `core-revision:<core_epoch>:<source_revision>` read from
  `core_source_revision` inside that batch, and `attempts` 0. It is written
  only when that batch's own update moved the execution (the `published_at`
  it set) and never replaces an existing `projected` row. The tracker read
  the publication before the batch ran and the revision only rises within an
  epoch, so the stored revision is at or above the one the publication wrote.
  No migration: `ops_request_stages` (0040) and its `pending` state exist.
- `readOperation` — the one service behind `GET /api/ops/v1/operations/{id}`
  and `kogane.ops.operation.get` (ADR 0081) — derives `projected` once
  `adopted` is complete and `projected` is not, from the READ database the
  adapter passes (`readStore`, the App's `READ` binding; both transports build
  it in one place). Three singleton reads: READ's `read_instance` and
  `balance_snapshot_pointer`, and CORE's `core_source_revision`. Nothing is
  written.
  - `completed`, with `evidenceRef` `read-snapshot:<snapshot id>`, when the
    READ contract is this code's, the pointer, the stored revision and CORE
    share one epoch, and the pointer's `source_revision` is at or above the
    stored one.
  - Otherwise `pending` with no evidence and a closed reason in
    `failureCode`: `projection_behind` (an older watermark),
    `read_model_unavailable` (no READ binding, nothing published, another
    READ contract, or READ could not be read), `read_model_context_changed`
    (epochs differ) or `projection_revision_unrecorded` (published without a
    stored revision). Never `completed` for a reason (INV05).
- The record's `status` reads `completed` when the stored status is `running`
  and every stage of the kind, the derived one included, is `completed`. A
  re-send under the same key answers from the same derivation.
  `ops_requests.status` and the stage row are not changed.

### Consequences

- A collection can be followed through `projected` to `status: completed` on
  HTTP and MCP alike. No route, schema, MCP tool, capability, flag, binding or
  migration is added; the App already binds `READ`.
- The stored request stays `running` and its `projected` row `pending`: the
  completion is a reading of READ, not a record. A reader that loses READ
  (dropped, not yet rebuilt) or a CORE restored under a new epoch reports
  `running` again with the reason; a rebuilt READ captures a CORE at or above
  the stored revision, so its first publication covers it again. Whatever
  else reads `ops_requests.status` directly sees `running`.
- Only executions recorded `published` after this change carry a revision;
  an earlier one reads `projection_revision_unrecorded` for good. No
  production execution was ever published (no connection is enabled), so
  this affects none today.
- Coverage is a revision comparison over the whole CORE input, whatever the
  balance projection keeps from the request's parses (a transaction-only
  collection contributes no balance row, and is still covered once the
  snapshot was verified at or above the revision). A use restriction that
  makes the published snapshot unservable does not reopen the stage; the v2
  routes answer that themselves.
- `import`, `replay` and `projection` requests never reach `adopted` through
  an executor today, so their `projected` stays a plain `pending` as before; a
  rebuild request (`projection`) is still not traced.

### Verification

- `packages/application/test/projection-trace.test.ts` (real CORE and READ
  migrations in `bun:sqlite`, synthetic ids): the requirement is the
  publishing batch's revision, written once and only by that batch; no READ,
  nothing published, an unreadable READ and another contract are
  `read_model_unavailable`; a pointer one revision behind is
  `projection_behind`, at or above the requirement `completed` with the
  request `completed` and the stored rows unchanged; another pointer epoch and
  a restored CORE are `read_model_context_changed`; a publication without a
  requirement is `projection_revision_unrecorded`; a re-send under the same
  key answers the read's record in each of these states, and a first request
  runs no READ statement; the write and the three reads are keyed lookups on
  stores without statistics.
- `services/app/test/ops-api.test.ts`: a collection accepted over HTTP and
  one over MCP read `read_model_unavailable`, then `projection_behind`, then
  `completed` with the same stages on both transports against a synthetic
  READ pointer.
- `services/processor/test/collector-dispatch.test.ts`: the real tracker
  stores the requirement when it records `published`; a reader without READ
  reports `read_model_unavailable`.

A production trail to `projected` is unverified: no connection is enabled.

## Amendment 2026-11-07 — the operator's 依頼の経過 page (proposed)

Status: proposed (accepted when its pull request merges).

**Context.** Phase 3 of the [roadmap](../roadmap.md#phase-3--coverage-collection-requests-and-cross-source-identity)
asks that a collection can be requested and followed to published
observations. The trail existed only as JSON over
`GET /api/ops/v1/operations/{id}`, and the UI footer states that collection is
not run from the screen.

**Options considered.** (1) Keep the trail HTTP-only. (2) A page that reads
one operation and also requests collections from the browser. (3) A read-only
page for one operation, opened from the audit log, that sends nothing.

**Decision.** Option 3. `/operations/op_<64 hex>` in the observation client
(`apps/web/src/pages/Operation.tsx`) reads the existing route once per opening
and again only when the operator presses 最新の状態を読み直す or the shell's
表示を更新 (no polling, no re-read on focus or reconnect): the record's
status, dispatch, failure code and times; every stage the kind reports with
its evidence reference (a fetch run `r_<id>` links to its 取得記録) and
failure code; and for a collection or session refresh the execution state,
reason, connection, waits and times, the note that the requested window is
stored and not applied, and each reported run's state, reason, block code,
provider outcome, 取得記録 link and artifact counts. Closed codes are shown
by Japanese name with the code beside them; unknown codes are shown as
themselves. The 監査ログ page links every `op_` target to this page. No page
lists operations (the list route of
[ADR 0086](0086-operator-operations-list.md) has none), so the audit log is
where an operation id is found on screen. Like the
audit page, it reads no capability and is drawn outside the metadata
boundary; the route's operator check is the only gate (`403` reads as
operator-only, `404` as not found, which also covers a deployment without
the API). Since [ADR 0086](0086-operator-operations-list.md) (owner,
2026-11-08 04:21 UTC) the read is whole-store, so the page shows an operation
whichever principal requested it, an MCP client's included. Option 2 is not
taken: requesting a provider contact from the browser is a product change the
owner has not made, and the footer's statement stays true.

The browser validates the record before rendering it
(`packages/observation-shared/src/operation-contract.ts`, through
`validApiResponse`): exact keys, the closed vocabularies, the stages of the
kind in order, an execution exactly for the collector kinds with the scope of
its action, at most 100 runs, a run's state consistent with its registration
(CORE 0039: `registeredAt` exactly when there is a fetch run) and its
artifact counts (`published + pending + notPublished = parseSelected ≤ total`,
`parseFailed ≤ notPublished`), and references that are identifiers, never a
URL. A record outside it is an error, never a partial trail.

**Consequences.** No route, migration, flag, MCP tool or capability changes.
Each opening and each re-read is an audited `ops.operation.get` read, as an
HTTP read already was. The page derives nothing itself: the `projected` stage
and `status` it shows are the record `readOperation` answers, derived from
READ
([amendment above](#amendment-2026-11-07-the-projected-stage-is-derived-from-the-read-pointer)). It
does not apply a requested window or show operations the operator cannot find
in the audit log.

The page makes this read a screen read, so
[ADR 0081](0081-ui-parity-through-mcp.md) requires it over MCP too. What main
does today (after #1027 and #1034): `kogane.ops.operation.get` is published
to every MCP client Access verifies, which acts as its own principal
`mcp-client:<sub>` ([ADR 0084](0084-mcp-operator-authority-without-delegation.md);
`delegatedOpsTools` and `callDelegatedOpsTool` in
`services/app/src/ops-tools.ts`). The trail itself is one function: the HTTP
route and the tool both call `opsServices.operation`, which calls
`readOperation` in `packages/application` and returns the same record this
page validates. The tool's lookup of the request's source is
`operationSource` in `packages/application` (#1027, renamed by ADR 0086), so
the tool issues no SQL of its own.

An earlier draft of this amendment listed one limit: `readOperation` read
only an operation the same principal requested, so a request made over MCP
was not shown on this page and the tool could not read one the operator
made, and the read-route guard listed `/api/ops/v1/operations/:id` as a
known gap. The owner decided on 2026-11-08 04:21 UTC that operations-request
reads are whole-store, like every other read since ADR 0084
([ADR 0086](0086-operator-operations-list.md)). The page and the tool now
read the same record for any operation, and the read-route guard
(`services/app/test/ui-mcp-parity.test.ts`) maps the route to
`kogane.ops.operation.get` with no gap entry.

**Verification.** `packages/observation-shared/test/operation-contract.test.ts`
(the validator); `packages/application/test/operation-record-contract.test.ts`
(the restated vocabularies equal the application's);
`services/app/test/ops-api.test.ts` (records the real route returns over the
real migrations pass the validator) and
`services/processor/test/collector-dispatch.test.ts` (every record read along
the full trail, from acceptance to publication, failure and expiry, passes it);
`apps/web/test/operation.browser.test.ts` (the page on desktop and phone
widths, one read per opening, an explicit re-read, refusals and a malformed
record) and `apps/web/test/audit.browser.test.ts` (the audit link opens the
page); `services/app/test/ui-mcp-parity.test.ts` (the page's route is mapped
to `kogane.ops.operation.get`); `services/app/test/delegated-ops-parity.test.ts`
(the tool and the route answer the same receipt for the operator's request and
for the MCP client's).
