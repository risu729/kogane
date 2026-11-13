# ADR 0048: Run an accepted collection or session refresh once through the named collector RPC

- Status: accepted (merged 2026-10-08 in #576; production dispatch verified
  2026-11-08, [below](#amendment-2026-11-08-five-connections-enabled-and-verified-in-production))
- Date: 2026-10-08
- Issue: #544
- Amended: 2026-11-07, the `projected` stage is derived from the READ pointer
  ([below](#amendment-2026-11-07-the-projected-stage-is-derived-from-the-read-pointer);
  accepted, #1097)
- Amended: 2026-11-07, the operator's 依頼の経過 page
  ([below](#amendment-2026-11-07--the-operators-依頼の経過-page);
  accepted, #1075)
- Amended: 2026-11-08, a collection with more than 100 runs
  ([below](#amendment-a-collection-with-more-than-100-runs-2026-11-08);
  accepted, #1111)
- Amended: 2026-11-08, five connections enabled and verified in production
  ([below](#amendment-2026-11-08-five-connections-enabled-and-verified-in-production);
  accepted, #1179)
- Amended: 2026-11-08, St George and SBI VC enabled
  ([below](#amendment-2026-11-08-st-george-and-sbi-vc-enabled);
  accepted, #1189)
- Amended: 2026-11-12, retryable registration visibility
  ([below](#amendment-2026-11-12-retryable-registration-visibility);
  proposed, #1270)

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
   malformed means none; the committed value was empty until the
   [2026-11-08 amendment](#amendment-2026-11-08-five-connections-enabled-and-verified-in-production)) → waits
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

- ~~Production dispatch has not run: no connection is enabled, and no deployed
  collector has served `runOperation`.~~ Closed by the
  [2026-11-08 amendment](#amendment-2026-11-08-five-connections-enabled-and-verified-in-production).
- The requested window is not applied by any collector.
- ~~READ projection of a run is not traced; `projected` stays pending.~~
  Closed by the
  [2026-11-07 amendment](#amendment-2026-11-07-the-projected-stage-is-derived-from-the-read-pointer).
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

- Status: accepted (merged 2026-11-08 in [#1097](https://github.com/risu729/kogane/pull/1097))
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
  an earlier one reads `projection_revision_unrecorded` for good. When this
  amendment was written no production execution had been published; the
  first one (sony-bank, 2026-11-08) was published before this amendment
  deployed and so reads `projection_revision_unrecorded`.
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

A production trail to `projected` was unverified when this amendment was
written; the
[2026-11-08 amendment](#amendment-2026-11-08-five-connections-enabled-and-verified-in-production)
followed four to `completed`.

## Amendment 2026-11-07 — the operator's 依頼の経過 page

Status: accepted (merged 2026-11-08 in [#1075](https://github.com/risu729/kogane/pull/1075)).

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

## Amendment: a collection with more than 100 runs (2026-11-08)

- Status: accepted (merged 2026-11-08 in [#1111](https://github.com/risu729/kogane/pull/1111))
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

## Amendment 2026-11-08: five connections enabled and verified in production

Status: accepted (merged 2026-11-08 in [#1179](https://github.com/risu729/kogane/pull/1179)).

### Context

The decision above left every connection disabled until the owner enabled
one, and its open limits said production dispatch had not run. On 2026-11-08
03:19 UTC the owner allowed agents to request collections without a limit,
asked that every healthy connection be enabled, and asked that the request
tool tell its caller to read the source's history first
([AGENTS.md](../../AGENTS.md#production-data)).

### Decision

`OPS_COLLECTOR_DISPATCH_CONNECTIONS` names `sony-bank`, `sbi-securities`,
`mobile-suica`, `moneyforward-me` and `myjcb` in both Processor
configurations (sony-bank in #1119, the other four in #1149). The first
request per connection was sent one at a time through
`kogane.ops.collection.request`, after reading the source's collection
quality, schedule, leases, maintenance windows and earlier requests ([ops-api.md](../ops-api.md#requesting-a-collection-as-an-agent)).
The gates, the one start per tick and the never-retry policy are unchanged.
The remaining connections wait for their own fixes
([ops-api.md](../ops-api.md#enabling-collector-execution-adr-0048); St
George and SBI VC in #1140).

### Consequences

- Each of the five requests went accepted → started → collected →
  published, with every parse-selected run published and no reason code.
  Four reached `projected` and `status: completed`; sony-bank's was
  published before the READ-tracing amendment deployed and reads
  `projection_revision_unrecorded`, as that amendment says.
- The tracker records a publication only when it next checks the execution
  (`TRACK_INTERVAL_MS`), so the trail shows `published` some minutes after
  the run was published.
- The open limit "Production dispatch has not run" is closed. The requested
  window and unattended session refresh remain open as written above.

### Verification

- The committed list and its parsing: `services/processor/wrangler.jsonc`,
  `services/processor/cloudflare.config.ts`,
  `services/processor/test/operation-dispatch.test.ts`, and the resource
  ledger's digest in `scripts/resource-ledger.test.ts`.
- Production (2026-11-08, read through Kogane MCP, no provider contacted by
  hand): one operation per connection read through
  `kogane.ops.operation.get` to its terminal state, recorded in
  [current-status.md](../current-status.md) and
  [ops-api.md](../ops-api.md#enabling-collector-execution-adr-0048) by #1170.

## Amendment 2026-11-08: St George and SBI VC enabled

Status: accepted (merged 2026-11-09 in [#1189](https://github.com/risu729/kogane/pull/1189)).

### Context

The amendment above left `st-george`, `sbi-vc-trade` and `sbi-vc-keepalive`
waiting for [#1131](https://github.com/risu729/kogane/pull/1131), which
retired these collectors' admin routes
([ADR 0069](0069-collector-admin-retirement.md#retirement-of-the-last-two-admin-routes-2026-11-08)).
Since then an accepted request is the only way to ask them for a login
outside the alarm: a requested St George collection lifts a login pause at
most once per 24 hours, and an SBI VC session refresh forces at most one
passkey login per hour. Both limits are the collectors' own and apply to every
caller. Neither collector accepts provider terms.

### Decision

Both Processor configurations add the three connections to
`OPS_COLLECTOR_DISPATCH_CONNECTIONS` (eight in all), and the App's
`SESSION_REFRESH_POLICY` is `{"sbi-vc-trade":"unattended"}`, so an SBI VC
session-refresh request is dispatched to `sbi-vc-keepalive` instead of being
stored `waiting_for_human` (owner, 2026-11-08 03:19 and 03:57 UTC;
[#1140](https://github.com/risu729/kogane/issues/1140)). Every other source's
refresh still waits for a person.

### Consequences

- A St George request while a pause holds and the day's requested login is
  spent ends `failed` with `st_george_paused_<code>` and no run; nothing
  contacts the bank.
- An SBI VC request while the owner's terms agreement is pending ends `failed`
  with `manual_agreement_required`; the collector never sends `setAgreement`.
- The open limit on unattended session refresh is unchanged: SBI VC's
  keepalive is still the only one.
- No request to the three connections has yet been followed in production;
  [ops-api.md](../ops-api.md#enabling-collector-execution-adr-0048) records
  the first ones when they are made.

### Verification

- The committed values: `services/processor/wrangler.jsonc`,
  `services/processor/cloudflare.config.ts`, `services/app/wrangler.jsonc`,
  `services/app/cloudflare.config.ts`, and their digests in
  `scripts/resource-ledger.test.ts`.
- The collectors' limits: `services/collector-st-george/test/worker-policy.test.ts`
  (the requested lift once per 24 hours) and
  `services/collector-sbi-vc-trade/worker-test/schedule-result.test.ts` (the
  forced login once per hour, and the login retried while an agreement is
  pending).

## Amendment 2026-11-09: PRESTIA bank enabled

Status: accepted ([#1232](https://github.com/risu729/kogane/pull/1232)). The first request's result is recorded in [ops-api.md](../ops-api.md#enabling-collector-execution-adr-0048).

### Context

The PRESTIA bank collector is deployed, but its daily alarm (`prestia-bank` in
`config/alarm-jobs.json`) is seeded disabled until one production collection
has been followed to publication
([plan, gate 4](../plans/2026-10-prestia-bank-worker.md#remaining-gates)). It
has never collected in production. The owner allowed that first collection to
be requested by an agent (2026-11-09 19:52 UTC), as part of collecting what
existing collectors' sites offer before any new collector
([roadmap, New sources](../roadmap.md#new-sources)).

### Decision

Both Processor configurations add `prestia-bank` to
`OPS_COLLECTOR_DISPATCH_CONNECTIONS` (nine in all). The first production
collection is one `kogane.ops.collection.request` for source `prestia`, after
the reads the tool description lists. The alarm stays disabled; enabling it is
a separate step after that request is followed to publication. The connection
stays listed after the first request, like the other eight, so agents may request
it again within AGENTS.md's request rules (every healthy connection, owner,
2026-11-08 03:19 UTC); if the first request does not reach publication, the
change that records its result removes `prestia-bank` until the cause is fixed.

### Consequences

- The collector logs in with the ID and password stored as Worker secrets. A
  missing secret ends the request `failed` without contacting the bank; an OTP
  or other additional authentication stops the run and stays human-required
  ([ADR 0042](0042-prestia-bank-worker.md)). Neither is retried.
- `prestia-globalpass` is a separate connection and stays outside the list.

### Verification

- The committed values in `services/processor/wrangler.jsonc` and
  `services/processor/cloudflare.config.ts`, and the Processor digest in
  `scripts/resource-ledger.test.ts`.
- The first request's terminal state through `kogane.ops.operation.get`,
  recorded in [ops-api.md](../ops-api.md#enabling-collector-execution-adr-0048).

## Amendment 2026-11-12: Retryable registration visibility

Status: proposed (accepted when its pull request merges).

### Context

The first PRESTIA run recorded a `registered` stage with state `retryable` and
code `inactive_ingest_route`. Its production ingest route was missing; the
route was added with owner approval on 2026-11-11. The existing operation
trail read the run as `registering`, and the operation's `registered` stage
remained `pending` with zero attempts and no code. The route repair does not
prove that the stored run has since registered or published (#1270).

### Decision

The CORE trail selects the registered revision of each run when present,
otherwise the newest revision. It reads that revision's latest `registered`
stage and counts its stored stage rows. A retryable refusal is reported as
`retryable` with its closed failure code, attempt count and latest recorded
time in the run trail. The operation's `registered` stage derives the same
facts at read time while the request remains open; the publication tracker
also records a retryable verdict when it sees one. A later registered run
outranks historical retryable refusals. Malformed legacy failure text becomes
`unclassified`.

### Consequences

- A retryable registration remains unsettled. It cannot by itself publish or
  block the operation, and the collection scan's retry interval is unchanged.
- The operation and run trail expose only counts, timestamps and closed codes;
  no provider text, object key or amount is returned.
- This read-side change neither re-registers the stored PRESTIA terminal nor
  satisfies its production publication gate.

### Verification

- `packages/application/test/collector-trail.test.ts` covers the latest
  retryable stage, multiple attempts, the operation receipt, registered
  revision precedence, a blocked run and a missing run.
- Hosted CI and independent review are required before this amendment is
  accepted.

## Amendment 2026-11-12: Current publication after the tracking horizon

Status: proposed (accepted when its pull request merges).

### Context

A stored collection can remain retryable beyond the operation's fixed
48-hour publication-observation horizon. The request and execution then end
`failed / unpublished / publication_not_observed`, and their terminal guards
correctly forbid reopening them. Later registration and publication of the
same bound runs can appear in the live trail, while the original operation
still needs an explicit current publication result
([issue 1270](https://github.com/risu729/kogane/issues/1270)).

### Options considered

- Rewrite or reopen the terminal receipt: rejected because it erases the
  original horizon result and violates the terminal-state invariants.
- Persist a separate recovery fact and maintain a historical observer queue:
  unnecessary for current-result reporting. A durable past observation would
  be a separate contract, including its evidence revision and observed time.
- Derive a versioned current-result extension on the existing bounded detail
  read: chosen because the exact original run trail is already read there.

### Decision

The same application reader used by HTTP, MCP and the detail page adds the
optional `execution.currentResult` contract documented in
[the operations API](../ops-api.md#collector-execution-adr-0048). Its schema
is `kogane-collector-current-result-v1`; `state: published` means current CORE
publication proof, alongside the immutable `originalTracking` outcome,
original 48-hour `publicationDeadlineAt` and recorded `finishedAt`.

Eligibility requires the original failed request, a collected execution that
ended `unpublished / publication_not_observed` after its existing horizon,
and a valid original source and unique nonempty run set of at most 100.
Every bound run must be returned in the same order. The existing
`trailOutcome` rule requires all runs settled and at least one published
parse; failed provider outcomes never qualify. Other outcomes, malformed
bindings, absent/pending evidence and zero selected parsers cannot claim
publication. A newer unrelated run is not evidence for this operation.

### Consequences

- Existing v1 status, stages, execution state, reason and timestamps retain
  their meanings. Terminal rows and evidence remain untouched.
- `publishedAt` in the extension is null: the current trail does not establish
  an actual first publication time. No observation time is invented either.
- `readReadiness: unproven` leaves the existing CORE epoch/revision and READ
  gate intact. Publication alone never completes `projected` or the request.
- Current pointers are re-read, so the result can become unobserved again.
  There is no durable late-publication fact, migration, GET write, historical
  scan, new capability, grant, resource or provider action.
- The detail page explicitly distinguishes the original deadline failure
  from current publication. The operations list remains a stored summary.
- This implementation supplies the same-operation reporting contract; it
  does not itself prove the original production run published or close its
  production acceptance gate.

### Verification

- Pure application and strict-wire tests cover exact bindings, malformed
  metadata, the 100-run bound, pending/failed/empty trails, original outcomes,
  closed versions and unknown fields, without a writable read path.
- The Processor integration regression reaches the original horizon, then
  registers and publishes the same synthetic run, and compares stored request,
  dispatch and stage rows unchanged across repeated reads and tracker ticks.
- Worker tests compare the same operation's HTTP and MCP detail responses
  before and after synthetic publication. Browser checks cover Japanese copy,
  accessibility and overflow at desktop/mobile widths.
- Existing terminal-immutability and projection-revision tests remain required.
