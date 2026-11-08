# Operations API

The committed App configuration enables `OPS_API_ENABLED` and names a human
operator; agent grants remain empty. The operations are not served over MCP
to an agent grant: `/mcp` accepts only agent-only MCP clients
([ADR 0047](adr/0047-mcp-client-connection.md)), and every such client
requests an operation as itself ([MCP](#mcp),
[ADR 0084](adr/0084-mcp-operator-authority-without-delegation.md)). These
six operation-request kinds are distinct from the newer operator-only
[schedule settings API](schedules.md#settings-api). A collection or unattended
session-refresh request reaches a collector only through the named collector RPC
the alarm uses, and only for a connection the Processor's
`OPS_COLLECTOR_DISPATCH_CONNECTIONS` names; the committed value names
`sony-bank`, `sbi-securities`, `mobile-suica`, `moneyforward-me` and `myjcb` ([collector execution](#collector-execution-adr-0048),
[ADR 0048](adr/0048-operation-collector-dispatch.md)).

The things an operator asks this system to _do_ — collect a source,
re-register a persisted run, replay a parse, rebuild the read model, refresh a
session — and the two reads of what happened (one request, and the list of
every request, whichever principal made it) as one authenticated API under
`/api/ops/v1`, served by
the same Worker that serves the reads. Each route has an MCP tool over the
same service, which every MCP client uses as itself ([MCP](#mcp)).

This implements unified plan 02 §4-5 and the U06 backlog row. Everything here
is **off by default**: with `OPS_API_ENABLED` unset these paths answer exactly
what they answer today.

Nothing on this page or in these routes carries an amount, an account number,
a credential, a session, a bucket key or a provider URL.

## Why the API exists at all

Collection, re-parsing and rebuilding were operator actions that lived in
`curl` calls against the pipeline Worker, in a person's shell history and in
the arguments they happened to type. This API gives them one place with one
identity, one record and one vocabulary, so that:

- the actor is the Cloudflare Access subject the Worker verified, never a body
  field (`src/auth.ts`, the same rule the change lifecycle and the agent API
  follow);
- the request is stored in CORE **before** the caller is told anything, so a
  lost notification loses a dispatch, never the request (02 §5);
- re-sending the same request is the same operation rather than a second bank
  session (G3-06, G3-14);
- a person looking at a screen and an operator with `curl` reach the same
  application service and get the same record (G3-05); a model with an MCP
  client requests one through the same service as itself, never as the
  operator ([MCP](#mcp), ADR 0084).

The one thing the API deliberately cannot be is a generic proxy: there is no
route that takes SQL, a table name, a bucket key, a URL, a database id or a
Cloudflare token, and there is no route that deletes anything. Creating and
dropping databases, purging buckets, issuing tokens and deploying Workers stay
in protected GitHub workflows (02 §6).

## Routes

All seven are authenticated, and all seven are refused unless `OPS_API_ENABLED`
is `"true"`. The route set is closed: any other path under `/api/ops/v1` is
`404 not_found`, and any verb other than `POST` (accept) and `GET` (read) is
`405 method_not_allowed`, exactly as everywhere else on this Worker.

| Route                                        | Body                                                       | Answers                     | What "done" means                                                          |
| -------------------------------------------- | ---------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `POST /api/ops/v1/collections`               | `{source, requestedScope:{from,to}, idempotencyKey?}`      | `202 {operationId, status}` | The request is stored. A provider is contacted later, by the collector.    |
| `POST /api/ops/v1/imports`                   | `{source, runId, idempotencyKey?}`                         | `202 {operationId, status}` | The request is stored. Registration is complete when `registered` is.      |
| `POST /api/ops/v1/replays`                   | `{scope:{source,from,to}, parserRelease, idempotencyKey?}` | `202 {operationId, status}` | A `planned` replay plan exists. Parsing is complete when `parsed` is.      |
| `POST /api/ops/v1/projections`               | `{reason, idempotencyKey?}`                                | `202 {operationId, status}` | The request is stored. Publication is complete when `projected` is.        |
| `POST /api/ops/v1/sessions/{source}/refresh` | `{idempotencyKey?}`                                        | `202 {operationId, status}` | The request is stored; `waiting_for_human` when a person must act.         |
| `GET /api/ops/v1/operations/{id}`            | –                                                          | `200` operation record      | Reads the stored record; it never asks a downstream system "are you done". |
| `GET /api/ops/v1/operations`                 | query `kind`, `status`, `cursor`, `limit`                  | `200` one page of summaries | Reads every principal's stored requests, newest first ([list](#the-list)). |

An import's `runId` is checked against the bucket key's own run grammar
(`RUN_ID` in `packages/collection/src/keys.ts`, imported by
`services/app/src/ops-api.ts` rather than copied): an ASCII letter or digit, then up
to 199 ASCII letters, digits, `.`, `_` or `-`. The import names the run whose
terminal is `runs/<source>/<runId>/terminal.json`, so a run id that key cannot
carry (a `:`, a `/`, a space, a leading separator) could never register; it is
refused at acceptance with `400 invalid_request` and `refs: ["runId"]`, and no
request is stored. The MCP tool `kogane.ops.import.request` validates with the
same schema and publishes the same pattern.

`status` is the stored operation status, not a promise: `accepted` or
`waiting_for_human` on acceptance, and later `running`, `completed`, `failed`
or `blocked`. **A 202 never means the work happened.** For a collection or
session refresh, the record's `execution` block says what the collector did
([collector execution](#collector-execution-adr-0048)). Queued work, a flag
that is off, a missing processor and a `building` snapshot are never
completion (`contracts/stages.json`, 05 §6).

### `GET /api/ops/v1/health` — the release postcheck's route

One more route lives under the same prefix and is **not** one of the seven. It is
authenticated like everything else here, but it is _outside_ `OPS_API_ENABLED`:
a postcheck that only works once an unrelated flag is on is not a postcheck
(plan 11 §6, `services/app/src/health.ts`, [ci-cd.md](ci-cd.md#postcheck)).

| Field          | What it is                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`       | `ok` (HTTP 200) or `degraded` (HTTP 503)                                                                                                                                                       |
| `releaseSha`   | the commit the deploy stamped into `RELEASE_SHA`, or `""` outside a release                                                                                                                    |
| `worker`       | `kogane-evidence-browser`                                                                                                                                                                      |
| `core`         | `SELECT 1` against CORE, plus the applied migration file names in order                                                                                                                        |
| `read`         | the same for READ, with `required: true`. This deployment always requires READ. The retired `READ_PROJECTION_ENABLED` name is not read. A binding that does not answer is `degraded`           |
| `data`         | one R2 `head` of the fixed key `health/release-marker`; `markerPresent` is reported, never required                                                                                            |
| `capabilities` | this deployment's capability snapshot, the same object `/api/meta` serves                                                                                                                      |
| `grants`       | `{ "usable": true }`, or `{ "usable": false, "problem": "<code>" }` when `OPERATOR_SUBJECTS`/`AGENT_GRANTS` cannot be read or overlap — a code, never a subject; `usable: false` is `degraded` |
| `processor`    | the Processor's own `/internal/health`, relayed over the `PIPELINE` service binding ([processor.md](processor.md#13-internal-health-and-the-release-postcheck))                                |

It is read-only: one `SELECT 1` per database, one migration list, one bucket
`head`, one capability snapshot, one service-binding read. No write, no
provider request, no bank access, no collection and no backfill — and no value
of any kind in the answer.

Who may read it (`services/app/src/health.ts`):

- **the operator**, graded by the same loader the seven routes use, so an
  `AGENT_GRANTS` subject is refused with `403 approval_required` here too;
- **an Access service token** whose common name (its Client ID) is listed in
  the deployment variable `HEALTH_PROBE_TOKENS`. This is how CD calls the
  route. A service token carries no subject — Cloudflare issues it with an
  empty `sub` and names it in `common_name` — so it is never an actor:
  `authenticate` still refuses it, and it can reach no other path of this
  Worker.

An empty `HEALTH_PROBE_TOKENS` means _no_ service token, which fails the
release rather than opening the route. A `HEALTH_PROBE_TOKENS` that is present
but cannot be read closes the route to everyone with `503 grants_misconfigured`,
as an unreadable grant list does on the seven routes. Empty subject lists are a
_usable_ configuration (deny-all when no subjects are configured): `grants.usable` is
false only for a list that is present but unreadable, or a subject named in
both lists, and then the deployment is `degraded` — a release does not certify
a Worker that can grade nobody.

### The operation record

```jsonc
{
  "schemaVersion": "kogane-operation-v1",
  "operationId": "op_<64 hex>",
  "kind": "collection",
  "status": "accepted",
  "source": "sony-bank",
  "targetRef": null, // the run/plan an executor bound this to
  "dispatch": { "state": "dispatch_pending", "attempts": 0 },
  "stages": [
    {
      "stage": "persisted",
      "state": "pending",
      "evidenceRef": null,
      "failureCode": null,
      "attempts": 0,
      "updatedAt": null,
    },
  ],
  "failureCode": null,
  "acceptedAt": "2026-09-11T00:00:00Z",
  "updatedAt": "2026-09-11T00:00:00Z",
  // collection and session-refresh only; null for the other kinds
  "execution": {
    "action": "collect", // or "refresh-session"
    "state": "accepted",
    "connectionId": null, // the alarm job id, once the Processor bound it
    "reasonCode": null,
    "scope": "collector_default", // null for a refresh
    "waits": 0,
    "expiresAt": "2026-09-12T00:00:00.000Z",
    "startedAt": null,
    "collectedAt": null,
    "publishedAt": null,
    "finishedAt": null,
    "runs": [],
  },
}
```

Stages are the vocabulary of `contracts/stages.json` — `persisted`,
`registered`, `parsed`, `adopted`, `projected` — defined once in
`packages/collection/src/stages.ts` (03 §5) and imported here, so an operation
and the run behind it cannot name the same stage differently. Recording a
stage goes through that module's `stageRecord`, which refuses `completed` for
the four reasons that are never completion (`queued`, `building`, `flag_off`,
`no_processor`). Each kind reports only the stages it can reach:

| Kind              | Stages                                                |
| ----------------- | ----------------------------------------------------- |
| `collection`      | persisted → registered → parsed → adopted → projected |
| `import`          | registered → parsed → adopted → projected             |
| `replay`          | parsed → adopted → projected                          |
| `projection`      | projected                                             |
| `session-refresh` | none: its progress is its status                      |

A stage nobody has reported is `pending`. Silence is never progress, and an
operation's stored `status` turns `completed` only when every stage of its
kind has a `completed` row written by the executor that held the evidence.
One stage is read rather than stored: once `adopted` is complete, `projected`
is derived from the READ database each time the record is read, and the
record's `status` reads `completed` when that makes every stage complete
([projected](#projected-read)).

### The list

`GET /api/ops/v1/operations` answers one page of every request in the store,
whichever principal made it: the operator in the browser or any MCP client
([ADR 0086](adr/0086-operator-operations-list.md),
`packages/application/src/operations/list.ts`; whole-store reads, owner
2026-11-08 04:21 UTC):

```jsonc
{
  "schemaVersion": "kogane-operation-list-v1",
  "operations": [
    {
      "operationId": "op_<64 hex>",
      "kind": "collection",
      "status": "running",
      "source": "sony-bank",
      "dispatch": { "state": "dispatched", "attempts": 1 },
      "failureCode": null,
      "acceptedAt": "2026-09-11T00:00:00Z",
      "updatedAt": "2026-09-11T00:05:00Z",
    },
  ],
  "nextCursor": null, // or the operationId to pass as `cursor` for the next page
}
```

- **Order.** Newest first by acceptance time, then by operation id, both
  descending. Neither column changes after insert, so the order is stable,
  and a cursor taken from one page continues after it under any filter.
- **Query.** `kind` (one of the five kinds), `status` (one of the six
  statuses), `cursor` (the `nextCursor` of the previous page) and `limit`
  (1–50, default 20). Each key at most once. An unknown key is
  `400 invalid_query` without a ref; a repeated key or a value outside its
  list is `400 invalid_query` naming the key. A cursor that names no
  operation is `404 receipt_not_found` with ref `cursor`; any principal's
  operation is a cursor.
- **Content.** A summary has no stages, no `execution` block, no target and
  no principal; read one operation for the first three, and the
  [audit log](audit-log.md) for who requested it. The stored request is not
  read, so a rebuild's `reason` never appears. `status` is the stored status,
  and the `status` filter matches it: READ is not read, so a request whose
  record reads `completed` through the derived `projected` stage
  ([projected](#projected-read)) is listed, and filtered, as `running`.
- **Cost.** One range of the index `ops_requests_open` per allowed
  (status, kind) pair (thirty without a filter, six for a kind, five for a
  status, one for both), each limited to the page, merged newest first. Rows
  sharing the boundary timestamp are sorted, and after a cursor the tied rows
  at or ahead of it are skipped. No range reads another pair's rows, so a
  page reads at most (pairs × (limit + 1)) rows plus ties, at any store
  size; the rows it does not return are the other pairs' candidates and
  those ties. No migration was added.
- **Audit.** Each request is recorded once as `ops.operation.list`, with the
  number of rows shown and whether a next page exists
  ([audit log](audit-log.md)).

## Idempotency

`operationId = "op_" + sha256(canonical-json{kind, principal, idempotencyKey})`
and `payload_digest = sha256(canonical-json{kind, payload})`, where the payload
is the validated request without its key.

- `idempotencyKey` absent means "this exact payload, once": the key becomes the
  payload digest, so an identical re-send addresses the same operation.
- The same key with the **same** payload returns the same record with 202. The
  caller cannot tell whether it was the first sender, which is the point.
- The same key with a **different** payload is `409 idempotency_conflict`, with
  the operation id as the only ref. Neither request is silently dropped.
- A key belongs to its principal: two subjects using the same key hold two
  operations, and neither can resend the other's. Either can read both
  ([reads](#authorization)).
- Two senders racing on one key — both reading "no such operation" before
  either writes — get the same answers as if they had arrived in order: the
  insert is guarded on the row not existing, the loser inserts nothing, and it
  is then checked against what the winner stored. The same payload is the same
  record (with `replayed` set from the write, not from the earlier read); a
  different payload is `409 idempotency_conflict`. A replay plan raced this
  way is planned once (`packages/application/test/operations.test.ts`).

The collector's side of this (G3-14) is the execution row of 0068 and
`target_ref`: the one start of an operation is a guarded `waiting → started`
update in the same batch that binds `target_ref` to
`collector:<connection>`, so a second dispatch, a re-send under the same key or
a raced tick finds the row started and never calls the collector again.
`recordDispatch` answers with the target the row holds and whether this call
bound it (`{targetRef, boundHere}`); `boundHere: false` with a non-null target
is the signal to continue the first executor's run. The 0040 trigger refuses
any write that would re-point a bound target, even a direct one.

## Authorization

Two gates in order, after the Access check that every route of this Worker
already does. Between them, on a `POST`, sits the own-origin rule: an
`Origin` that is present and not the Worker's own is
`403 origin_not_allowed` before a grant, a schema or the store is touched
([ADR 0078](adr/0078-own-origin-state-changing-routes.md)). With the flag
off the route answers as it did before (a `POST` is `405`), whatever its
`Origin`. An operator's `curl` sends no `Origin` and is unaffected.

1. the deployment flag `OPS_API_ENABLED`;
2. the change lifecycle's principal grading (`OPERATOR_SUBJECTS` +
   `AGENT_GRANTS`, resolved by the one resolver described in
   [change-lifecycle.md](change-lifecycle.md), "Grants"). Both are allow-lists:

   | Verified subject                    | All seven routes                             |
   | ----------------------------------- | -------------------------------------------- |
   | listed in `OPERATOR_SUBJECTS`       | served                                       |
   | listed in `AGENT_GRANTS`            | `403 approval_required`                      |
   | in neither list                     | `403 subject_not_granted`                    |
   | (a list is unreadable, or overlaps) | `503 grants_misconfigured`, for **everyone** |

   An agent is refused on the read too: requesting a provider session, a
   replay or a rebuild needs `interpretation.accept`, which an agent does not
   hold (addendum 10 §5), and it has no operations to read because it cannot
   create one. A subject in neither list is refused for the same reason, one
   step earlier — the operator role is granted here, never inferred from being
   authenticated. **With `OPERATOR_SUBJECTS` empty
   `OPS_API_ENABLED=true` serves the routes and every one of them answers
   `subject_not_granted` until a deployment names its operator. That is
   intended.**

   The routes are the only transport that reaches this resolver: `/mcp`
   never grades its caller by these lists and runs an operations tool as the
   MCP client itself (`callDelegatedOpsTool`, [MCP](#mcp)).

Reads are whole-store, like every other read since
[ADR 0084](adr/0084-mcp-operator-authority-without-delegation.md) (owner,
2026-11-08 04:21 UTC; [ADR 0086](adr/0086-operator-operations-list.md)): any
caller the transport authenticated — the operator on these routes, any MCP
client on `/mcp` — reads and lists every operation, whichever principal
accepted it. Only an id that does not exist answers `404 receipt_not_found`.
Writes are unchanged: a request is accepted, re-sent and bound under the
caller's own principal.

## Errors

Codes only, with safe refs — the path of a field the caller sent (`source`,
`scope.source`, `parserRelease`, `requestedScope`) or an operation id the
server derived. The rejected value itself is never echoed into a response, a
log or a queue (G3-08) — not even a source or release id that failed the
registry lookup — and Zod's own messages are never returned. The request log
carries the route label, the status and the code, never a ref.

| Code                   | HTTP | Means                                                                                  |
| ---------------------- | ---- | -------------------------------------------------------------------------------------- |
| `invalid_request`      | 400  | The body failed the published schema; `refs` names the fields                          |
| `invalid_query`        | 400  | A query string where none is taken, or a list query outside its closed keys and values |
| `target_missing`       | 400  | The source or parser release is not declared in the registry                           |
| `approval_required`    | 403  | An agent asked for work only an operator may request                                   |
| `subject_not_granted`  | 403  | The verified subject is in neither grant list                                          |
| `actor_not_supported`  | 403  | The verified subject is not a shape the decision log can record                        |
| `origin_not_allowed`   | 403  | A `POST` carried another site's `Origin` (ADR 0078)                                    |
| `not_found`            | 404  | No such operations route                                                               |
| `receipt_not_found`    | 404  | No such operation, as an id or a list cursor                                           |
| `idempotency_conflict` | 409  | The same key was reused for a different payload                                        |
| `request_too_large`    | 413  | The body exceeds 16 KiB                                                                |
| `grants_misconfigured` | 503  | This deployment's grant lists cannot be read; nobody is graded                         |

Neither authorization code carries a subject, a list or a configured value. A
misconfiguration is logged once as
`{"event":"grants_misconfigured","problem":<code>}` and nowhere else.

## MCP

The seven routes have MCP tool definitions (`src/ops-tools.ts`), each
generated from the Zod schema its route validates with:

| Tool                            | Route                                        |
| ------------------------------- | -------------------------------------------- |
| `kogane.ops.collection.request` | `POST /api/ops/v1/collections`               |
| `kogane.ops.import.request`     | `POST /api/ops/v1/imports`                   |
| `kogane.ops.replay.request`     | `POST /api/ops/v1/replays`                   |
| `kogane.ops.projection.request` | `POST /api/ops/v1/projections`               |
| `kogane.ops.session.refresh`    | `POST /api/ops/v1/sessions/{source}/refresh` |
| `kogane.ops.operation.get`      | `GET /api/ops/v1/operations/{id}`            |
| `kogane.ops.operation.list`     | `GET /api/ops/v1/operations`                 |

**Every `/mcp` principal uses them as itself.** Since
[ADR 0047](adr/0047-mcp-client-connection.md), `/mcp` accepts only an identity
that came through the MCP Access application, and that identity is the
agent-only caller `mcp-client:<sub>` — the operator's own identity included.
Since [ADR 0084](adr/0084-mcp-operator-authority-without-delegation.md)
(2026-11-07) every such caller resolves an operation authority over the whole
store, whatever the operator lists say; it acts as itself (`principal_kind:
delegated`, actor `mcp-client:<sub>`), never as the operator. `callOpsTool`,
the HTTP routes' adapter, refuses an `mcp-client` caller object
(`403 delegation_not_configured`) before `opsContext` runs, so the operator
lists still grade only the browser's routes. `delegatedOpsTools` (#660, ADR 0063 slice
S3) publishes each tool to a resolved principal holding its `operations.*`
capability, and `callDelegatedOpsTool` runs it through the same services; a
collection request or session refresh needs a prepare and an exact
confirmation. Every MCP client holds all seven.
For the same input, a call over MCP and its route give the same receipt and
store the same request ([ADR 0081](adr/0081-ui-parity-through-mcp.md),
`services/app/test/delegated-ops-parity.test.ts`).

`kogane.ops.operation.get` and `kogane.ops.operation.list` are defined over
the same services as the two read routes (`readOperation` and
`listOperations`). Both are whole-store (owner, 2026-11-08 04:21 UTC): an
MCP client lists and reads every operation, those the operator requested in
the browser and those any MCP client accepted, with the same answer as the
route, `execution` block included. A principal whose delegation scope names
fewer sources or accounts is refused an operation outside its scope, and the
list, as `400 target_missing`; since ADR 0084 no MCP client has such a scope.
The list tool takes the
route's query as arguments (`kind`, `status`, `cursor`, `limit`, with `limit`
a number), validated by the same schema (`operationListSchema` in
`src/ops-api.ts`); a refusal is `invalid_request` with the field paths, as on
the other tools, where the route answers `invalid_query` naming the key. No
agent-API grant capability reads an operation.

### Requesting a collection as an agent

An agent may request collections without a count or rate limit (owner,
2026-11-08 03:19 UTC); nothing in the App or the Processor caps them. The
`kogane.ops.collection.request` description tells the caller to read the
source's history first, and every item is an existing read:

| Read first                                                    | Tool                                                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| the source's collection quality: latest runs and stage codes  | `kogane.collection-quality.read` with `source`                                                                                            |
| its schedule, next alarm, recent occurrences and held leases  | `kogane.schedules.read`                                                                                                                   |
| its maintenance windows and the maintenance-adjusted due time | `kogane.schedules.maintenance.read` with `source`                                                                                         |
| earlier requests and how they ended                           | `kogane.ops.operation.list` with `kind: "collection"` (each summary names its source and status), then `kogane.ops.operation.get` for one |

It then does not request while the source's alarm is due, its maintenance
window is on, a lease is held or an earlier request has not finished, and when
the latest runs failed it finds the cause before requesting again. The
dispatcher holds a request during maintenance and while a lease is held anyway
([collector execution](#collector-execution-adr-0048)); reading first avoids a
request that can only wait, expire or fail the same way. The rule is in the
tool description, not in code.

Both operations reads are whole-store ([MCP](#mcp), ADR 0086): a request
the operator or another MCP client made is listed and read like the caller's
own. Requests are
accepted without a cap, but the dispatch lane starts at most one collector per
tick (`COLLECTOR_STARTS_PER_TICK`), so several requests start one after
another, not in parallel.

## Session refresh and human-required states

`SESSION_REFRESH_POLICY` is a wrangler var holding `{"<source>": "unattended"}`
for the sources whose session a collector may renew by itself. **Every source
not named there needs a person**, and so does every source when the variable is
absent, empty or malformed: the safe direction is to ask (12 §3).

A human-required refresh is stored with `status: "waiting_for_human"` and
`dispatch_state: "not_required"`. Nothing retries a login, nothing repeats a
password, and no policy in this repository automates an MFA or a passkey
challenge (G3-11). The response carries an id and a state and never a
credential. Its `execution.state` reads `waiting_for_human` (本人操作待ち) with no
expiry: nothing dispatches it, so nothing expires it.

An unattended refresh is executed like a collection (below) through a
`refresh-session` connection. The only one is SBI VC's keepalive job
(`sbi-vc-keepalive`); for every other source an unattended refresh ends
`unsupported` with `session_refresh_unsupported` and contacts nobody. SBI VC
runs its keepalive and, if that fails, one passkey login without its 6-hour
cooldown. It makes at most one such forced login per hour whoever asks; a
request inside that hour runs the keepalive under the alarm's own login policy
(ADR 0069, 2026-11-08).

## Collector execution (ADR 0048)

An accepted `collection` or unattended `session-refresh` is executed by the
Processor's `operation_dispatch` lane through the **named collector RPC the
alarm already uses**: the `SCHEDULE_<WORKSPACE>` Service Binding to the
collector's `ScheduledCollection` entrypoint, method `runOperation`. There is no
URL, no generic executor and no other transport
([ADR 0048](adr/0048-operation-collector-dispatch.md)).

**From the schedules page.** The operator's **収集を依頼** on `/schedules`
posts this route after a confirmation step, and the schedules snapshot says
for each job which CORE source a request names and whether this lane would
start it (`collectionRequest`, [schedules](schedules.md#収集を依頼-collection-request);
owner decision 2026-11-08 03:19 UTC).

**Connection.** The request's CORE source and action select one connection — an
alarm job of `config/alarm-jobs.json`, mirrored as `OPERATION_CONNECTIONS` in
`packages/collection/src/operation-rpc.ts`. The call carries
`{version, operationId, connectionId, source, action, requestedAtMs}` and
nothing else. The collector checks it against the same table (another
collector's connection, another source or an action the connection lacks is
refused before anything runs) and then runs the connection's job exactly as
its alarm would, through `runScheduled` and the same execution lease. It
collects the job's daily scope: **the requested window is stored and not
applied** (`execution.scope: "collector_default"`).

**States.** `execution.state` is closed:

| State               | Means                                                                                         | `status` of the request |
| ------------------- | --------------------------------------------------------------------------------------------- | ----------------------- |
| `accepted`          | stored; no executor has looked at it                                                          | `accepted`              |
| `waiting_for_human` | a refresh the source policy hands to a person; never dispatched, never expires                | `waiting_for_human`     |
| `waiting`           | not started, nothing contacted; `reasonCode` says why                                         | `accepted`              |
| `started`           | the collector was called; no answer recorded yet                                              | `running`               |
| `collected`         | the collector reports its terminal(s) persisted; `runs` lists them                            | `running`               |
| `refreshed`         | the collector reports the session renewed                                                     | `completed`             |
| `published`         | every reported run settled and at least one has an adopted (published) parse                  | `running` (see limits)  |
| `unpublished`       | every run settled with nothing adopted, or nothing settled within 48 h; `reasonCode` says why | `failed`                |
| `failed`            | the collector's own closed failure code; a run it still persisted is listed in `runs`         | `failed`                |
| `uncertain`         | the call threw, answered outside the closed shape, or never recorded an outcome in an hour    | `failed`                |
| `expired`           | not started within 24 h of acceptance                                                         | `blocked`               |
| `unsupported`       | no connection (or no binding) serves the source and action                                    | `blocked`               |

The closed shape a collector answers is `status` (`completed` or `failed`), a
`failureCode` exactly when it failed (lower-case letters, digits and `_`, at
most 64; the pattern is checked, not a fixed list), and at most 100 run ids, each one
a terminal key can carry (`RUN_ID` in `packages/collection/src/keys.ts`, so
never a `:`): `collectorOperationResult` in
`packages/collection/src/operation-rpc.ts`. The collector's own result helpers
(`scheduledResult`, `scheduledFailure`) report only such ids, and none for a
run whose terminal was not written, even when the run is listed.

`startedAt`, `collectedAt`, `publishedAt` and `finishedAt` are set when the
state is reached; `expiresAt` is acceptance + 24 h.

**Before a start** (each check contacts nobody):

| Reason code                   | When                                                              | Next look                                       |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| `collection_unsupported`      | no `collect` connection for the source (SMBC Direct, V Point Pay) | terminal (`unsupported`)                        |
| `session_refresh_unsupported` | no `refresh-session` connection for the source                    | terminal (`unsupported`)                        |
| `collector_binding_missing`   | the connection has no Service Binding in this deployment          | terminal (`unsupported`)                        |
| `operation_expired`           | 24 h after acceptance                                             | terminal (`expired`)                            |
| `collector_dispatch_disabled` | the connection is not in `OPS_COLLECTOR_DISPATCH_CONNECTIONS`     | 1 h                                             |
| `provider_maintenance`        | the source's collection/session maintenance window is open        | when it closes (1 h if the windows never close) |
| `collection_lease_held`       | another execution (the alarm, a manual trigger) holds the lease   | 5 min                                           |
| `dispatch_deferred`           | this Processor invocation already started a collector             | 5 min                                           |

Waits never pass the expiry. **The lease is only read**: the operation path never
takes, releases, replaces or expires `collection_execution_leases`; the collector
claims it inside `runScheduled` as for the alarm, so the same source never runs
twice at once. If another execution takes the lease between the lane's read and
the collector's claim, the collector refuses before contacting anyone and the
request ends `failed` with `collection_busy`. St George does the same since
2026-11-08 UTC: its session coordinator answers `busy` for a refused lease and
records no run ([St George](sources/st-george.md)).

**After a start nothing is retried.** A collector failure, an uncertain call
and a start that never recorded an outcome are terminal; a provider login is
never repeated by this path (G3-11, ADR 0039). A St George collection request
is the one way to lift a login pause without changing the credential: it allows
one login, at most once per 24 hours whoever sends it, and a request inside that
spacing ends `failed` with `st_george_paused_<reason>` (ADR 0069). Re-sending the same key returns
the same operation; a new key is a new request.

**The trail.** For a `collected` execution, each tick reads (at most five
executions, every five minutes each) and the record shows live, per reported run:

| Field                                   | From                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `state: not_registered` / `registering` | no `collection_runs` row yet / seen, not yet registered                                           |
| `state: blocked`, `blockedCode`         | registration refused (`collection_runs.blocked_code`)                                             |
| `evidenceRunId`, `registeredAt`         | the registered fetch run (`r_<id>`, the 取得記録 link)                                            |
| `state: parsing`                        | the sealed run's parse scheduling is unprocessed, or a job is pending                             |
| `artifacts.total` / `parseSelected`     | the run's artifacts / those a parser job or parse run exists for                                  |
| `artifacts.published`                   | selected artifacts with a CORE publication (`published_parse_runs`)                               |
| `artifacts.pending` / `parseFailed`     | still queued or parsing / settled with an error parse run                                         |
| `state: published` / `unpublished`      | settled; `reasonCode` is `provider_failed`, `no_parser_selected`, `parse_failed` or `not_adopted` |

The stages `registered`, `parsed` and `adopted` are written from those rows
only. A collected execution with no reported run is `unpublished`
(`run_not_reported`); one whose runs do not settle within 48 h of collection is
`unpublished` (`publication_not_observed`).

Limits: no deployed collector has served `runOperation` and no connection is
enabled; the requested window is not applied; one collector call is awaited
per Processor invocation, inside the tick; the web UI has no operations view.

### Projected (READ)

When the Processor records an execution `published`, the same batch stores
the `projected` stage as `pending` with the CORE revision READ has to reach
(`core-revision:<core_epoch>:<source_revision>`, read from
`core_source_revision` in that batch; ADR 0048, amended 2026-11-07). The
operation record — `readOperation`, behind both the HTTP route and
`kogane.ops.operation.get` — then compares it with READ's published pointer
whenever it is read, and writes nothing:

| `projected`                                                | When                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `completed`, `evidenceRef: "read-snapshot:<snapshot id>"`  | the pointer, the stored revision and CORE share one epoch, and the pointer was verified at or above it |
| `pending`, `failureCode: "projection_behind"`              | the published snapshot was verified at an older revision                                               |
| `pending`, `failureCode: "read_model_unavailable"`         | no `READ` binding, nothing published, another READ contract, or READ could not be read                 |
| `pending`, `failureCode: "read_model_context_changed"`     | the epochs differ (CORE restored, or READ built under another epoch)                                   |
| `pending`, `failureCode: "projection_revision_unrecorded"` | the execution was recorded published before the revision was stored with it                            |
| `pending`, no `failureCode`                                | `adopted` is not complete                                                                              |

The record's `status` reads `completed` when the stored status is `running`
and every stage, this one included, is `completed`; a re-send of the request
answers with that same status. The stored request stays
`running` and its `projected` row `pending`, so the answer follows READ: it
falls back to `running` with the reason if READ is lost or CORE is restored
under a new epoch. Coverage compares revisions over the whole CORE input, so
a collection whose parses add no balance row is covered once the published
snapshot was verified at or above its revision. A use restriction that makes
the snapshot unservable does not reopen the stage. Requests of the other
kinds never reach `adopted` through an executor, so their `projected` stays a
plain `pending`; a rebuild request is still not traced.

## Storage

Every request to the seven routes, and every operations MCP tool call, is
recorded in the common audit log ([audit log](audit-log.md), ADR 0064): an
accepted request's `accepted` record is the last statement of the acceptance
batch (so a request exists exactly when its record does), and a re-send, a read
or a refusal is recorded once after the answer. A validation refusal records
the field paths, never the refused value.

Migration `0040_operations_api.sql` (CORE), additive:

- `ops_requests` — one accepted request. What was accepted (id, kind,
  principal, key, digest, source, payload, acceptance time) is immutable and
  the row is never deleted; the progress columns (`status`, the dispatch
  columns, `target_ref`, `failure_code`, `updated_at`) may only move forward:
  a terminal request is never reopened, attempts never decrease, `target_ref`
  is write-once. Three triggers enforce this (`_no_delete`, `_no_replace`,
  `_progress_only`).
- `ops_request_stages` — stage progress per operation, keyed by
  `(operation_id, stage)`, written only by the executor that reached the
  stage. Never deleted; a `completed` stage is never reopened; attempts never
  decrease. The operation's `status` is materialised from these rows by
  `recordOperationStage` — `completed` only when every stage of the kind is —
  and by `recordDispatch` (`blocked` on a failed dispatch); it is never set by
  a caller.
- `observation_replay_plans.operation_id` — which request a replay plan belongs
  to. The 0035 plan tables stay the only place a replay plan lives; this API
  creates a `planned` row there rather than a second copy of the plan.

Migration `0068_ops_collector_dispatches.sql` (CORE), additive, adds
`ops_collector_dispatches`: one execution row per collection or refresh
operation (state, closed reason, connection, terminal source, reported run ids,
timestamps). Its triggers refuse deletion, an insert in a started state, a
started row returning to `waiting` (`starts` is 0 or 1), reopening a terminal
state and rewriting reported runs. It is `operational-mutable`: execution
state, not evidence.

The two 0040 tables are classified `core-keep` in `infra/schema/core-ledger.md`,
on the chapter 04 §2 row "change_plans, approvals, operation_receipts,
decision_outbox → CORE" (acceptance and the promise of follow-up work): an
accepted request is that promise and its stage rows are the evidence it was
kept ([infra-ledgers.md](infra-ledgers.md)).

The 0031 tables are untouched: `operation_receipts` records a _judgement_ of
the change lifecycle, and its `operation_kind` CHECK is that closed list. A
collection request is a different fact, and existing migrations are immutable.

## The application services (for U08 and U09)

`packages/application/src/operations/requests.ts`, exported from
`@kogane/application`. The Processor and the collectors call these instead of
writing their own SQL against the tables above:

| Service                                                                                                        | For                                                         |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `requestCollection` / `requestImport` / `requestReplay` / `requestProjectionRebuild` / `requestSessionRefresh` | the six accept paths                                        |
| `readOperation`                                                                                                | one operation record, of any principal (ADR 0086)           |
| `listOperations` (`operations/list.ts`)                                                                        | one page of every request, newest first (ADR 0086)          |
| `pendingDispatches({store, nowMs, limit})`                                                                     | the Processor alarm tick's queue of undispatched requests   |
| `recordDispatch({operationId, outcome, targetRef?})`                                                           | one dispatch; binds `target_ref` once, answers who holds it |
| `recordOperationStage({operationId, stage, state})`                                                            | stage evidence; completes the operation when all stages are |

`dispatch_state='dispatch_pending'` keeps a request in the scheduled lane's
queue until a dispatch takes it, so a failed notification never loses the
request. For a collection or refresh, "takes it" is the one guarded start of
ADR 0048; a wait puts the request back with a retry time and a closed reason.

U08 built the scheduled side of that contract: the `operation_dispatch` lane of
`services/processor` (`docs/processor.md` §7), behind
`OPS_DISPATCH_ENABLED`, default off. It re-registers a stored terminal in
process, starts the replay plan an acceptance created, hands a projection
over, and — since ADR 0048 — starts a `collection` or an unattended
`session-refresh` through the collector's named RPC and follows it
([collector execution](#collector-execution-adr-0048)).
`operationRequestPayload(store, operationId)` is the reader the executor uses
to see what was accepted — the dispatch acts on the durable row, never on the
contents of a notification. No branch of it completes an operation merely by
handing the work over. An import whose re-registration throws (R2 or CORE
unavailable) neither fails the lane nor holds the head of the queue: it stays
`dispatch_pending` with `failureCode: "registration_failed"`, one more
dispatch attempt and a retry time five minutes ahead, while the requests
behind it are dispatched in the same tick (`docs/processor.md` §7). It is
retried with no cap, and the code stays on the record after a later look
registers it, as every retry code does.

Only collections and unattended session refreshes expire (24 h,
[collector execution](#collector-execution-adr-0048)). A replay or projection
is dispatched or blocked on its first look. **An import has no expiry and no
other closed end while its terminal is missing** (`terminal_not_found`), its
registration is staged (`pending`) or `retryable`, or the tick's budget was
spent (`registration_deferred`): it stays `accepted` / `dispatch_pending` and
is looked at every five minutes, `dispatch.attempts` growing by one each time,
until the registration succeeds or is blocked. Nothing cancels it, and a new
idempotency key is a new operation. A registration that throws ends nothing
either: it is retried five minutes later as `registration_failed`, and the
lane carries on. This is an open limit, not a policy
([processor §7](processor.md#7-operations-dispatch)).

The collector execution services are in
`packages/application/src/operations/collector-dispatch.ts` (writes) and
`collector-trail.ts` (reads):

| Service                                                      | For                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `claimCollectorStart`                                        | the one start of an operation, with the request row in the same batch |
| `recordCollectorWait` / `recordCollectorDeclined`            | a closed reason to wait, or to end before any start                   |
| `recordCollectorOutcome`                                     | what the collector answered: collected, refreshed, failed, uncertain  |
| `abandonStartedCollectorDispatches`                          | a start nobody finished, after an hour: `uncertain`                   |
| `collectedDispatchesDue` / `trackCollectorPublication`       | the trail of a collected execution, until published or a reason       |
| `collectorExecution` / `collectorRunTrails` / `trailOutcome` | the `execution` block and the stage ladder it supports                |

`projection-trace.ts` holds the `projected` requirement the published batch
stores (`projectionRequirementWrite`) and the read-time comparison with the
READ pointer (`projectionCoverage`); see [projected](#projected-read).

## What was verified locally, and what was not

Synthetic data only.

- `services/app/test/ops-api.test.ts` (43 checks over the real
  Worker, the real migrations and the real store): flag-off behaviour, the
  closed route and verb set with the flag on, `/api/meta` discovery, one
  record per request, re-send, idempotency conflict, one operation per
  principal for one key (either principal reads the other's), schema refusals of SQL / storage keys / external URLs / unknown keys /
  impossible dates (G3-13), an import run id outside the terminal key's
  grammar, that the import schema accepts exactly the run ids
  `terminalKey` accepts and that the MCP import tool publishes that grammar,
  error bodies that carry no rejected value — not
  the unknown source or release either (G3-08), the four other routes, the
  replay plan written into the 0035 tables exactly once, `waiting_for_human`
  (G3-11), stage progress and completion, the read route's `execution` block
  for an accepted and for a collected request, and that `/mcp` publishes the
  operations to every MCP client, which applies them as itself and reads the
  operator's browser receipt exactly as the route answers it, while HTTP
  still grades the operator lists (G3-05, ADR 0047, ADR 0084, ADR 0086), and
  a published collection followed to `projected` alike on HTTP and MCP
  against a synthetic READ pointer. Its
  list checks (ADR 0086) cover the whole-store page (two operators shown the
  same page of both's requests), cursor paging, the filters, every refusal,
  the audit record and the list's query plans on D1 without table statistics.
- `services/app/test/delegated-ops-parity.test.ts`: the list tool and the
  route answer the same page of both principals' requests in the stored
  order, the get tool and the route read the operator's request and the MCP
  client's alike, the operator's operation pages on as the tool's cursor, a
  bad limit, an unknown key and an unknown cursor are refused, and the call
  is recorded once as `read` with its row count on `mcp`.
- `packages/application/test/operations-list.test.ts`: the list paged to its
  end for every filter shape on random synthetic stores against an in-memory
  reference (two principals, the same pages whichever asks), the summary
  shape, cursors of another principal and of no operation, and the query
  plans without table statistics.
- `packages/application/test/operations.test.ts` (10 checks; the SQL half
  runs against the real migrations in `bun:sqlite`): request identity,
  principal binding, the stage table per kind, the session policy's safe
  default, and the deterministic races — two senders of one key with the same
  payload (one row, one `replayed: false`), with different payloads (one row,
  one conflict), a raced replay (one plan), and two dispatches of one
  operation (one `target_ref`, the second told to reuse it) — plus the 0040
  guards against delete, replacement and reopening.
- `apps/web/test/api-schema.test.ts` and
  `services/app/test/conformance.test.ts` pin the new `opsApi`
  capability off in the shared contract.
- Collector execution (ADR 0048), synthetic source and collector:
  `services/processor/test/collector-dispatch.test.ts` (21 checks over the
  real CORE schema and the real registration: success through `published`
  with distinct timestamps, failure, uncertain, an unfinished start, re-send
  with the same key before and after the run, a raced claim, a held lease and
  a lease taken by the collector, unsupported and human-required and supported
  refresh, expiry, maintenance (including windows that never close), one start
  per tick, the 48-hour horizon, no parser selected, the stored columns, the
  `projected` requirement stored with publication);
  `packages/application/test/collector-trail.test.ts` (the 0068 guards, the
  trail's outcomes and its keyed query plans without table statistics);
  `packages/application/test/projection-trace.test.ts` (`projected` pending,
  behind, completed and each closed reason against real CORE and READ
  migrations, and its keyed statements without table statistics);
  `packages/collection/test/operation-rpc.test.ts` (the connection table
  against `config/alarm-jobs.json`, request refusals before any run, the
  closed answer, the lease refusal mapped to `collection_busy`);
  `tests/collector-operation-rpc.test.ts` (terminal sources, one connection
  per CORE source and action, the shared binding name, every scheduled
  collector's `runOperation`); and
  `services/processor/test/schedule-native-runtime.test.ts` (a real workerd
  Processor tick starting one request over a named service binding).

The tests above use no deployed instance, live Access policy, real provider or
session. In production, `sony-bank` served `runOperation` for an MCP client's
collection request, and the run it reported was registered and every
parse-selected artifact published; the other connections the committed
configuration names had not run a request when they were added. Dated MCP
client connection evidence is in the [recovery runbook](mcp-recovery.md).

Acceptance ids and the test that carries each:

| Id    | Asked                                                                        | Test                                                                                                                        |
| ----- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| G3-01 | absence is reported as absence, not empty success                            | `ops-api.test.ts` "stores one record … pending, not as success (G3-01)"                                                     |
| G3-05 | the same request over UI/HTTP is the same; MCP makes it as itself (ADR 0084) | `ops-api.test.ts` "operations over /mcp: every MCP client, as itself (ADR 0047, ADR 0084)"                                  |
| G3-06 | a re-sent operation returns the existing record                              | `ops-api.test.ts` "collection requests are accepted, not executed (G3-06, G3-14)"; `operations.test.ts` raced re-send tests |
| G3-08 | a secret in the input leaves only a safe code                                | `ops-api.test.ts` "the schema is the boundary (G3-08, G3-13)"                                                               |
| G3-11 | human-required state, no login retry                                         | `ops-api.test.ts` "waiting_for_human … (G3-11)"; `operations.test.ts` "a session refresh needs a person … (G3-11)"          |
| G3-13 | SQL / bucket key / URL is not executed                                       | `ops-api.test.ts` "refuses arbitrary SQL, storage keys and external URLs by shape"                                          |
| G3-14 | a duplicated acceptance maps to one run                                      | `operations.test.ts` "a second dispatch of one operation finds the first executor's run … (G3-14)"                          |

## Flags, deploy order and rollback

Flag defaults when absent (not the current committed settings):

| Variable                             | Worker    | Default | Effect                                                                                    |
| ------------------------------------ | --------- | ------- | ----------------------------------------------------------------------------------------- |
| `OPS_API_ENABLED`                    | app       | `""`    | `"true"` serves the seven routes and publishes their tools to every MCP client (ADR 0084) |
| `SESSION_REFRESH_POLICY`             | app       | `""`    | Sources a collector may refresh unattended; absent = a person                             |
| `OPS_DISPATCH_ENABLED`               | processor | `""`    | `"1"`/`"true"` runs the `operation_dispatch` lane                                         |
| `OPS_COLLECTOR_DISPATCH_CONNECTIONS` | processor | `""`    | JSON array of connection ids whose collector the lane may call; empty or malformed = none |

Historical initial activation procedure for migration 0040; current releases
follow [rollout controls](rollout.md#4-deployment-order). Do not send a real
operation merely to check deployment health.

1. Apply CORE migration `0040_operations_api.sql`. It is additive and the
   running Worker never reads the tables it creates.
2. Deploy `services/app` with `OPS_API_ENABLED` unset. Every
   operations path answers exactly as before (405 on POST, 404 on GET) and
   `/api/meta` reports `opsApi: false`.
3. Set `OPS_API_ENABLED=true` for the deployment and confirm `/api/meta`. Send
   one `POST /projections` and read it back: `accepted`, every stage `pending`.
4. Set `SESSION_REFRESH_POLICY` only for a source whose unattended renewal has
   actually been demonstrated.

Rollback: set `OPS_API_ENABLED` to `""` (no code deploy needed if it is a
secret), or deploy a compatible Worker revision under the current rollback floor. Accepted operations stay in
`ops_requests`; they are inert while nothing dispatches them, and turning the
flag off does not need to remove them. The migration is not rolled back: its
tables are unread by the previous revision.

### Enabling collector execution (ADR 0048)

Order: CORE `0068` is applied, the collectors (with `runOperation`) are
uploaded, then the Processor, then the App ([rollout](rollout.md#4-deployment-order)).
With an empty `OPS_COLLECTOR_DISPATCH_CONNECTIONS` (as committed until
2026-11-08), the first ticks only decline requests no connection serves, expire requests older than 24 hours
and leave the rest waiting with `collector_dispatch_disabled`; no provider is
contacted.

To enable one connection, add its id (for example `["sony-bank"]`) to
`OPS_COLLECTOR_DISPATCH_CONNECTIONS` in both `services/processor/wrangler.jsonc`
and `services/processor/cloudflare.config.ts` in a reviewed change, refresh the
resource ledger and deploy the Processor. Then send one collection request with
a fresh idempotency key at a time the source's alarm is not due, and read
`GET /api/ops/v1/operations/{id}` until `execution.state` is `published`,
`unpublished`, `failed` or `uncertain`. Rollback: remove the id; a request
already `started` is not interrupted, and nothing started is retried.
The owner allowed every healthy connection (2026-11-08 03:19 UTC). `sony-bank`
came first; once its first request was followed to publication, the healthy
connections that wait on no open fix were added together, and their first
requests are sent one connection at a time, each after the previous one ends.
The committed value names `sony-bank`, `sbi-securities`, `mobile-suica`,
`moneyforward-me` and `myjcb`. `sbi-vc-trade`, `sbi-vc-keepalive` and
`st-george` follow [#1131](https://github.com/risu729/kogane/pull/1131)
([#1140](https://github.com/risu729/kogane/issues/1140)); the remaining
connections (`prestia-globalpass`, `sbi-shinsei`, `vpass`, `mizuho-bank`,
`vpoint`, `prestia-bank`) come after their open fixes. `mobile-suica` and
`myjcb` drive a browser and run far longer than `sony-bank`; the Processor tick
waits for them, so their first requests are watched for `uncertain`.
`SESSION_REFRESH_POLICY` must also name `sbi-vc-trade` before an unattended
refresh of it is dispatched, and only once its unattended renewal has been
demonstrated.

### Replay publication target

The replay API pins `parserRelease` as `target_release`. With candidate mode on,
a registered release that is not the dataset's active release produces candidate
runs, not immediately adopted observations. Comparison and activation are separate
operations; a successful parse or completed replay plan is not adoption. For a
bounded backfill with the normally deployed parser and no candidate target, use
the authenticated [processor replay helper](observation-lanes.md#bounded-operator-replay).
