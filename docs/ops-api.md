# Operations API

The six things an operator asks this system to _do_ — collect a source,
re-register a persisted run, replay a parse, rebuild the read model, refresh a
session, and read what happened — as one authenticated API under
`/api/ops/v1`, served by the same Worker that serves the reads, and reachable
through MCP under the same names.

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
- a person looking at a screen, an operator with `curl` and a model with an
  MCP client all reach the same application service and get the same record
  (G3-05).

The one thing the API deliberately cannot be is a generic proxy: there is no
route that takes SQL, a table name, a bucket key, a URL, a database id or a
Cloudflare token, and there is no route that deletes anything. Creating and
dropping databases, purging buckets, issuing tokens and deploying Workers stay
in protected GitHub workflows (02 §6).

## Routes

All six are authenticated, and all six are refused unless `OPS_API_ENABLED` is
`"true"`.

| Route                                        | Body                                                       | Answers                     | What "done" means                                                          |
| -------------------------------------------- | ---------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `POST /api/ops/v1/collections`               | `{source, requestedScope:{from,to}, idempotencyKey?}`      | `202 {operationId, status}` | The request is stored. A provider is contacted later, by the collector.    |
| `POST /api/ops/v1/imports`                   | `{source, runId, idempotencyKey?}`                         | `202 {operationId, status}` | The request is stored. Registration is complete when `registered` is.      |
| `POST /api/ops/v1/replays`                   | `{scope:{source,from,to}, parserRelease, idempotencyKey?}` | `202 {operationId, status}` | A `planned` replay plan exists. Parsing is complete when `parsed` is.      |
| `POST /api/ops/v1/projections`               | `{reason, idempotencyKey?}`                                | `202 {operationId, status}` | The request is stored. Publication is complete when `projected` is.        |
| `POST /api/ops/v1/sessions/{source}/refresh` | `{idempotencyKey?}`                                        | `202 {operationId, status}` | The request is stored; `waiting_for_human` when a person must act.         |
| `GET /api/ops/v1/operations/{id}`            | –                                                          | `200` operation record      | Reads the stored record; it never asks a downstream system "are you done". |

`status` is the stored operation status, not a promise: `accepted` or
`waiting_for_human` on acceptance, and later `running`, `completed`, `failed`
or `blocked`. **A 202 never means the work happened.** Queued work, a flag
that is off, a missing processor and a `building` snapshot are never
completion (`contracts/stages.json`, 05 §6).

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
}
```

Stages are the vocabulary of `contracts/stages.json` — `persisted`,
`registered`, `parsed`, `adopted`, `projected` — and each kind reports only the
stages it can reach:

| Kind              | Stages                                                |
| ----------------- | ----------------------------------------------------- |
| `collection`      | persisted → registered → parsed → adopted → projected |
| `import`          | registered → parsed → adopted → projected             |
| `replay`          | parsed → adopted → projected                          |
| `projection`      | projected                                             |
| `session-refresh` | none: its progress is its status                      |

A stage nobody has reported is `pending`. Silence is never progress, and an
operation turns `completed` only when every stage of its kind has a
`completed` row written by the executor that held the evidence.

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
  operations, and neither can read or resend the other's.

The collector's side of this (G3-14) is `target_ref`: the executor writes the
run it started once, and a second dispatch of the same operation finds it set
and must reuse that run rather than open a second provider session.

## Authorization

Two gates in order, after the Access check that every route of this Worker
already does:

1. the deployment flag `OPS_API_ENABLED`;
2. the change lifecycle's principal grading (`AGENT_GRANTS`): a subject listed
   there is an agent and is refused with `403 approval_required`. Requesting a
   provider session, a replay or a rebuild needs `interpretation.accept`, which
   an agent does not hold (addendum 10 §5). An agent may still _read_ its own
   operations — it has none, because it cannot create one.

Reads are scoped to the principal that accepted the operation. An operation
belonging to someone else answers `404 receipt_not_found`, exactly like one
that does not exist: the API never confirms an id it will not show.

## Errors

Codes only, with safe refs — a field path the caller sent, an operation id it
holds, or a `source:<id>` / `parser_release:<id>` it named. The rejected value
itself is never echoed into a response, a log or a queue (G3-08), and Zod's own
messages are never returned.

| Code                   | HTTP | Means                                                           |
| ---------------------- | ---- | --------------------------------------------------------------- |
| `invalid_request`      | 400  | The body failed the published schema; `refs` names the fields   |
| `invalid_query`        | 400  | These routes take no query string                               |
| `target_missing`       | 400  | The source or parser release is not declared in the registry    |
| `approval_required`    | 403  | An agent asked for work only an operator may request            |
| `actor_not_supported`  | 403  | The verified subject is not a shape the decision log can record |
| `not_found`            | 404  | No such operations route                                        |
| `receipt_not_found`    | 404  | No such operation for this principal                            |
| `idempotency_conflict` | 409  | The same key was reused for a different payload                 |
| `request_too_large`    | 413  | The body exceeds 16 KiB                                         |

## MCP

The same six operations are MCP tools on the existing `POST /mcp` endpoint,
published **only while the flag is on**:

| Tool                            | Route                                        |
| ------------------------------- | -------------------------------------------- |
| `kogane.ops.collection.request` | `POST /api/ops/v1/collections`               |
| `kogane.ops.import.request`     | `POST /api/ops/v1/imports`                   |
| `kogane.ops.replay.request`     | `POST /api/ops/v1/replays`                   |
| `kogane.ops.projection.request` | `POST /api/ops/v1/projections`               |
| `kogane.ops.session.refresh`    | `POST /api/ops/v1/sessions/{source}/refresh` |
| `kogane.ops.operation.get`      | `GET /api/ops/v1/operations/{id}`            |

Each tool's published JSON Schema is generated from the same Zod schema its
route validates with, so the wire contract and the advertised contract cannot
drift. Reaching `/mcp` still needs an `AGENT_API_GRANTS` grant (that is the MCP
endpoint's own gate) _and_ the operator capability above, so a read-only agent
principal sees the tools refuse exactly as the routes do.

## Session refresh and human-required states

`SESSION_REFRESH_POLICY` is a wrangler var holding `{"<source>": "unattended"}`
for the sources whose session a collector may renew by itself. **Every source
not named there needs a person**, and so does every source when the variable is
absent, empty or malformed: the safe direction is to ask (12 §3).

A human-required refresh is stored with `status: "waiting_for_human"` and
`dispatch_state: "not_required"`. Nothing retries a login, nothing repeats a
password, and no policy in this repository automates an MFA or a passkey
challenge (G3-11). The response carries an id and a state and never a
credential.

## Storage

Migration `0040_operations_api.sql` (CORE), additive:

- `ops_requests` — one accepted request. Append-only except its progress
  columns; a terminal request is never reopened; `target_ref` is write-once.
- `ops_request_stages` — stage progress per operation, keyed by
  `(operation_id, stage)`. A `completed` stage is never reopened.
- `observation_replay_plans.operation_id` — which request a replay plan belongs
  to. The 0035 plan tables stay the only place a replay plan lives; this API
  creates a `planned` row there rather than a second copy of the plan.

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
| `readOperation`                                                                                                | the operation record, scoped to a principal                 |
| `pendingDispatches({store, nowMs, limit})`                                                                     | the Processor cron's queue of undispatched requests         |
| `recordDispatch({operationId, outcome, targetRef?})`                                                           | what happened to one dispatch; binds `target_ref` once      |
| `recordOperationStage({operationId, stage, state})`                                                            | stage evidence; completes the operation when all stages are |

`dispatch_state='dispatch_pending'` is the hook U09 replaces with a Service
Binding call to the collector: the row stays pending until a dispatch
succeeds, so the cron keeps re-dispatching and a failed notification never
loses the request. Nothing in this change contacts a collector.

## What was verified locally, and what was not

Synthetic data only.

- `services/evidence-browser/test/ops-api.test.ts` (25 checks over the real
  Worker, the real migrations and the real store): flag-off behaviour,
  `/api/meta` discovery, one record per request, re-send, idempotency
  conflict, per-principal scoping, schema refusals of SQL / storage keys /
  external URLs / unknown keys / impossible dates (G3-13), error bodies that
  carry no rejected value (G3-08), the four other routes, the replay plan
  written into the 0035 tables exactly once, `waiting_for_human` (G3-11),
  stage progress and completion, and HTTP/MCP parity (G3-05).
- `packages/application/test/operations.test.ts`: request identity, principal
  binding, the stage table per kind, and the session policy's safe default.
- `poc/observation-pipeline/test/api-schema.test.ts` and
  `services/evidence-browser/test/conformance.test.ts` pin the new `opsApi`
  capability off in the shared contract.

Not verified: no deployed instance, no live Access policy, no collector, no
Processor execution, no real provider or session. No MCP client has connected.

## Flags, deploy order and rollback

Flags this change adds, both off:

| Variable                 | Default | Effect                                                        |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `OPS_API_ENABLED`        | `""`    | `"true"` serves the six routes and publishes the six tools    |
| `SESSION_REFRESH_POLICY` | `""`    | Sources a collector may refresh unattended; absent = a person |

Deploy order:

1. Apply CORE migration `0040_operations_api.sql`. It is additive and the
   running Worker never reads the tables it creates.
2. Deploy `services/evidence-browser` with `OPS_API_ENABLED` unset. Every
   operations path answers exactly as before (405 on POST, 404 on GET) and
   `/api/meta` reports `opsApi: false`.
3. Set `OPS_API_ENABLED=true` for the deployment and confirm `/api/meta`. Send
   one `POST /projections` and read it back: `accepted`, every stage `pending`.
4. Set `SESSION_REFRESH_POLICY` only for a source whose unattended renewal has
   actually been demonstrated.

Rollback: set `OPS_API_ENABLED` to `""` (no code deploy needed if it is a
secret), or redeploy the previous Worker revision. Accepted operations stay in
`ops_requests`; they are inert while nothing dispatches them, and turning the
flag off does not need to remove them. The migration is not rolled back: its
tables are unread by the previous revision.
