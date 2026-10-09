# Common audit log

What the code records today about who did what, through which path
([ADR 0064](adr/0064-common-audit-log.md); slice S1 of the
[AI operation path plan](plans/2026-10-ai-operation-path.md#8-implementation-slices-in-dependency-order)).
The log covers the operations that exist today on three paths — the
operator's routes (`ui`), the agent HTTP routes (`agent-http`) and MCP tool
calls (`mcp`). It does not record the Processor's own `alarm` and `lane` work
yet (plan S7), there is no delegated principal, prepare or confirm (ADR 0063,
plan S3), and agents cannot read it (plan S5/S8). The limits are listed at the
end.

## The record

CORE `audit_records` (migration 0075), one row per operation call:

| Column                                                                               | Holds                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_id`, `recorded_at`                                                            | `aud_` + UUID; canonical UTC milliseconds                                                                                                                                                                                                    |
| `path`                                                                               | `ui`, `agent-http`, `mcp` (the table also admits `alarm` and `lane`, which nothing writes yet)                                                                                                                                               |
| `subject`, `principal`, `principal_kind`                                             | the verified Access subject; what it was graded as; `human` (the operator) or `agent` (the table also admits `delegated` and `automatic`)                                                                                                    |
| `delegation_ref`                                                                     | always NULL today                                                                                                                                                                                                                            |
| `operation`, `risk_class`, `step`                                                    | a name from `OPERATION_CATALOGUE` (`packages/application/src/operation-path/catalogue.ts`), its ADR 0063 risk class, and `call`                                                                                                              |
| `scope_namespace`, `scope_source`                                                    | the one server-resolved source the target belongs to, or both NULL                                                                                                                                                                           |
| `target_ref`                                                                         | the target, as an id the existing logs hold (`plan:<id>`, `op_<id>`, `schedule:<id>`, …); NULL on a refusal                                                                                                                                  |
| `result`, `result_code`, `reason_code`                                               | `applied` / `accepted` / `read` / `replayed` / `refused` / `failed` / `overflow`; the closed code of a refusal or failure; a closed reason                                                                                                   |
| `correlation_id`                                                                     | the App's request id (`x-request-id` of the answer), forwarded to the Processor                                                                                                                                                              |
| `idempotency_key`, `payload_digest`                                                  | the caller's key (a commit's `operationId`, an operations request's key); the digest of the validated payload, never the payload                                                                                                             |
| `confirmation_digest`, `confirm_expires_at`, `confirms_audit_id`, `reverts_audit_id` | always NULL today (two-step confirmation and reverting operations are ADR 0063's later slices); the table requires `confirms_audit_id` only on an applied or accepted confirm, so a refused confirm with no matching prepare can be recorded |
| `refs_json`                                                                          | at most 16 references into the existing logs (`approval:<id>`, `operation:<id>`, `decision:<id>`, `schedule:<id>@<rev>`, `field:<path>`)                                                                                                     |
| `diff_json`                                                                          | one closed shape per kind: `revision` (from, to, changed field names), `decision` (counts), `request` (status), `read` (row count), `release`, `overflow`, `none`                                                                            |

The table is append-only (no update, delete or replace), `STRICT`,
`core-keep`, never pruned, and listed in `REVISION_EXCLUDED_TABLES`, so an
audit write never moves the CORE source revision. Every column is an enum, a
bounded pattern, a digest, a count or a canonical time; a trigger refuses any
reference outside the reference character set and any text value in the diff
that is not a lower-case code. The builder (`packages/application/src/audit/`)
validates the same shapes first and refuses with the name of the field, never
its value.

The record names what changed by reference and copies nothing: no plan
payload, simulation, decision reason, rule pattern, URL, request or response
body, provider text, amount, account label, credential, token or exception
text. A refused value is never echoed; a validation refusal records the
schema paths of the refused fields (`field:requestedScope.from`).

## Who writes which record

`executeOperation` (`packages/application/src/operation-path/execute.ts`) is
the one entry every adapter calls. It runs the adapter's existing
authorization and service unchanged and records the outcome:

- **An effect** (`applied`, `accepted`) is written by the writer itself, as
  the last statement of its own D1 batch, through `OperationCall.effect`: a
  plain `INSERT … SELECT … WHERE` joined to the row the effect wrote, never
  `OR IGNORE`. A guard that matches no row writes neither the effect nor the
  record; a statement error rolls both back. The statement also refuses a
  second effect record for the same effect (same target and operation, and
  the same revision, approval or operation id), so two raced batches that saw
  one effect leave one record.
- **Everything else** — a read, a replay, a refusal, a failure — is written by
  the App adapter (`services/app/src/audit.ts`), once, after the answer. The
  Processor never writes these for `ui`, `agent-http` or `mcp`: a refusal it
  makes comes back to the App as its closed code and is recorded there. The
  instrument-candidate pin checks (ADR 0055) are such refusals: a candidate
  plan whose anchor or subject mapping moved, or a candidate plan without
  both pins, is `409 stale_context` at plan, simulate, approve or commit
  before any batch, and the App records it once as `refused` under the
  command's operation.

| Path         | Route or tool                                                                                                                                                                  | Operation                                                                                                                                                                                      | Effect record written by                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ui`         | `POST /api/command/v1/{plan,simulate,approve,commit,operation}`                                                                                                                | `command.plan`, `command.simulate`, `command.approve`, `command.commit`, `command.operation.get`                                                                                               | the Processor: `createPlan`, `approve` and `commit` batches                                            |
| `ui`         | `POST /api/ops/v1/{collections,imports,replays,projections}`, `…/sessions/{source}/refresh`, `GET …/operations/{id}`                                                           | `ops.collection.request`, `ops.import.request`, `ops.replay.request`, `ops.projection.request`, `ops.session.refresh`, `ops.operation.get`                                                     | the App: the acceptance batch of `packages/application/src/operations/requests.ts`                     |
| `ui`         | `POST /api/ops/v1/schedules/{job}`, `/maintenance`, `/proposals/{id}`, `/leases/{source}`                                                                                      | `schedules.job.update`, `schedules.maintenance.update`, `schedules.survey.decide`, `schedules.lease.release`                                                                                   | the Processor: `updateSchedule`, `updateMaintenance`, `decideSurveyProposal`, `releaseCollectionLease` |
| `agent-http` | `POST /api/agent/v1/<tool>`                                                                                                                                                    | the tool name without `kogane.` (`capabilities`, `context.open`, `financial.query`, `explain`, `purchases.explain`, `instruments.candidates`, `reconstructed-state.read`, `reconcile.propose`) | the App: the proposal batch of `services/app/src/proposals.ts`                                         |
| `mcp`        | `tools/call` on `/mcp` by an MCP client (`mcp-client:<sub>`, ADR 0047): the agent tools; the operations tools are refused (`actor_not_supported`) and that refusal is recorded | the same names; a refusal before any tool is named is `mcp.request`                                                                                                                            | as above                                                                                               |

The three schedule writers that were not one batch before are one now:
a maintenance revision, its provenance update and its record; an accepted
survey proposal's revision, its decision row and its record (a proposal
decided by someone else in between rolls the revision back with them); a lease
release and its record, which is the only durable trace of a release. Alarm
reconciliation after a settings write stays outside the batch, as before.

A record's principal is the subject until the adapter grades it: a subject the
grant lists do not name is recorded as itself, `human` on `ui` and `agent` on
the agent paths. On the agent paths the principal is the caller the boundary
built: the browser session's subject on `/api/agent/v1/*` (`agent-http`), and
`mcp-client:<sub>` on `/mcp` (`mcp`), whose record also names `<sub>` as its
subject. A browser session whose verified subject claims the agent-only
namespace (`403 actor_not_supported`, before any tool) is recorded on
`agent-http` under that subject. A read records its row count
(`financial.query`: the result's rows and whether more exist; `explain`:
nodes; `purchases.explain`: purchases; `instruments.candidates`: candidates on
the page, truncated when the total is larger; `reconstructed-state.read`: one
when the answer carries a reconstruction, else none; the others one).
Whole-store and multi-source reads carry no scope. A replay names the earlier
effect by the id the service answered with.

### The envelope to the Processor

The App forwards `x-kogane-correlation-id` (its request id) and
`x-kogane-audit-path` with every command and settings write, beside the actor
headers. The Processor's command and schedule routes refuse a request without
them, or with an `x-kogane-delegation-ref` (no delegation exists), exactly as
they refuse a missing actor (`invalid_command`, `operator_required`). When the
Processor's batch wrote the effect record it answers
`x-kogane-audit-recorded: 1`; the App strips it from the answer and records
nothing more. If the Processor's answer is lost (the binding throws or the
body cannot be read), the caller gets the answer it always got and the App
records `failed` with `upstream_unavailable`; if the Processor applied the
operation anyway, its `applied` record under the same correlation id is the
authoritative one.

## Daily caps

Per principal and UTC day (`AUDIT_DAILY_CAPS`): 2,000 `read` and 500
`refused` records. Past a cap the read is still served and the refusal still
answered, but the event only increments a row of `audit_overflow_counters`
(`operational-mutable`, keyed by day, principal, path and result; it keeps
the subject and principal kind for the aggregate). The cap check and the
increment read the day's count inside one batch, so exactly one of them
writes. `applied` and `accepted` records are never capped. The 200 `prepared`
cap is enforced by the store (`cap_reached`), but nothing prepares yet.

The Processor's `audit_overflow` lane runs last on every tick: for each
counter row of a day that has ended it appends one `overflow` record
(operation `audit.overflow`, the counter's path, subject and principal,
`{"kind":"overflow","of":…,"count":…,"cap":…}`) and deletes the row in the
same batch, guarded on the count it read. At most 100 rows a tick; a tick
with no ended day writes nothing. Its tick row in `processor_lane_ticks`
counts `counters` and `written`.

## Reading

`GET /api/v2/audit` (operator only, `403 operator_required` otherwise) returns
the whole store, newest first, 50 records a page:

```json
{ "schemaVersion": "kogane-audit-page-v1", "records": [ … ], "cursor": "…" }
```

Query parameters, each at most once: `operation`, `path`, `principalKind`,
`result`, `from` and `to` (UTC days, inclusive) and `cursor`; anything else is
`400 invalid_query`. The filters are in the SQL `WHERE` before the `LIMIT`, no
total is computed, and the cursor binds the filters it was issued under (a
cursor presented with other filters is `409 stale_context`). Reading the log is
a page load and is not recorded. No page shows it yet (plan S8), and no agent
route serves it (`audit.read` is a later slice).

## Cost

Indexes: by principal, by scope, by operation (each with `recorded_at`), by
target, by correlation id, by time (`recorded_at`, `audit_id`), and the two
unique partial indexes (one `applied`/`accepted` record per confirmed prepare
and per principal, operation and caller key). The page is one range on the
time index — from its first day to the earlier of its cursor and the end of
its last day — so a later page or an older day seeks to its place instead of
walking the index from the newest record, and nothing is sorted; the other
filters are checked on the rows that range reads. The daily cap counts the
principal's own records of the day through the principal index; the
one-record-per-effect check reads the target index; the overflow lane reads
only ended days through the counter table's key.
`packages/application/test/audit.test.ts` asserts these plans without table
statistics, and that the page's range form answers exactly what the page's
first text (every bound behind `IS NULL OR`) answered. Each operator write and
each agent call adds one row; volume is bounded by the operations themselves
and by the caps above.

## Not recorded, and other limits

- `alarm` and `lane` records (plan S7): until they exist the log records
  subject-originated operations only.
- Page loads and reads of the operator's GET routes (the schedules page, the
  read pages, `/api/v2/query`, this log), except `GET /api/ops/v1/operations/{id}`,
  which is an operations read and is recorded.
- A request refused before authentication (401), the deployment's
  service-token bootstrap (no subject), a path or tool this deployment does
  not serve (`404 not_found`, MCP `unknown_tool`), and the MCP protocol's own
  messages (`initialize`, `tools/list`, `ping`, an accepted notification) —
  including a JSON-RPC error `/mcp` answers inside a `200` (an unknown method,
  `-32601`). Everything `/mcp` refuses with an HTTP status before a message
  reaches a tool is recorded once as `mcp.request`: the App's own refusals (a
  method other than POST, a query string, a cross-origin request, no grant)
  and the MCP SDK's (`400 invalid_body` for a body that is not JSON, not a
  JSON-RPC message or carries an unsupported protocol header,
  `406 not_acceptable`, `413 request_too_large`, `415 unsupported_media_type`).
  A tool that throws is recorded `failed` by its own call and not again by the
  transport.
- A subject outside the actor shape (`actor_not_supported` for a subject
  `ACTOR_PATTERN` refuses; an agent-only `mcp-client:` subject fits the shape
  and its refusal is recorded, above): the record could not hold it, so the
  request log carries `audit_write_failed` instead. The
  same holds for any read, replay, refusal or failure record that cannot be
  written: the answer never changes. An effect record is different: it is in
  its writer's batch, so an effect whose record cannot be built or written is
  not applied either, and the caller gets the writer's failure (the
  schedules' `503 scheduling_unavailable`, the survey's
  `503 decision_record_failed`, a command's 5xx, and the proposal tool's
  existing `409 idempotency_conflict`, which it answers for every failed
  append). The command, operations and schedule writers act only for a
  principal whose subject the actor shape admitted (`principalFor`); the
  proposal tool acts for any subject `AGENT_API_GRANTS` names, so a granted
  subject outside the actor shape can read but cannot propose.
- `replayed` and `failed` records are not capped (ADR 0064 caps `prepared`,
  `read` and `refused` only).
- With one principal on several paths (the owner's subject on `ui` and on the
  browser-audience agent routes), the overflow aggregate is one record per
  path and capped result per day.
- No delegated principal, prepare, confirm, idempotent replay of schedule
  writes, rollback reference or agent read exists yet (ADR 0063, plan S3–S6).

Tests: `packages/storage-d1/test/audit-records-migration.test.ts` (the table's
guards), `packages/application/test/audit.test.ts` (builder, effect statement,
caps, overflow, chokepoint, page and plans),
`services/processor/test/change-lifecycle.test.ts` and
`services/processor/test/schedule-audit.test.ts` (each Processor writer and
its envelope), `services/app/test/audit.test.ts` (every path end to end, the
lost answer, the caps, the operator's read and a deep scan for provider text,
a token-shaped value and an amount).
