# Change lifecycle: plan, simulate, approve, commit

Architecture addendum A09 (SC17, UC69/UC70, AT69/AT70; addendum 10 §5–§6 and
§9, addendum 11 §5, addendum 12 §2–§4). This change turns a correction from a
one-way write into a four-step, resumable, idempotent operation: a plan fixes
what would change and at which revisions, a simulation measures it on the
server, an approval binds a human to that exact plan, and a commit applies it
in one guarded transaction and hands back a stable receipt.

There is **no external money action** here and none can be added by
configuration. The command kinds are a closed list in code:
`identity.assign`, `identity.release-override`, `relation.accept`,
`relation.reject`.

## The four steps

| Step       | What it does                                                                                                                                                   | What it changes          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `plan`     | Validates the payload, resolves its targets, records the revisions they are at now, simulates, and stores the plan under its digest.                           | `change_plans` only      |
| `simulate` | Re-runs the same engine against the current store and reports the impact plus whether the plan has gone stale.                                                 | nothing                  |
| `approve`  | Binds one human principal to one plan digest, with a scope, an expiry and a use count. Re-checks the revisions first and marks the plan `stale` if they moved. | `approvals`, plan status |
| `commit`   | One D1 batch: reserve the receipt, verify every expected revision, write the decision, write the receipt and the outbox rows.                                  | everything, atomically   |

`operation` (a fifth route) returns the receipt of a completed operation.

### Plan digest

```
planId = planDigest = canonicalDigest({ kind, payload, expectedRevisions, baseContextId })
```

`canonicalDigest` is `packages/domain`'s `canonical-json-v1` SHA-256. The plan
row's primary key **is** that digest, so there is no second stored copy that
could disagree with it. Any change of kind, payload, expected revision or base
context produces a different plan id, and an approval bound to the old digest
can never apply to the new one (SC17, INV09).

### Expected revisions

`expectedRevisions` is `{ subjectRef: revision }`:

| Subject prefix                  | Meaning                        | "Current revision" is                                   |
| ------------------------------- | ------------------------------ | ------------------------------------------------------- |
| `account_mapping:`              | a `source_accounts.id`         | `max(account_mappings.revision)` for that reference     |
| `instrument_mapping:`           | an `instrument_identifiers.id` | `max(instrument_mappings.revision)` for that identifier |
| `relation:<kind>\|<from>\|<to>` | one typed relation triple      | the number of `entity_relations` rows for the triple    |

A subject with no history answers `0`. The check is **not** a preceding
`SELECT`: `expectedRevisionsSql()` is a condition of the receipt-reservation
statement inside the commit batch (addendum 10 §5). A revision that moved
between plan and commit therefore writes nothing at all — not the receipt, not
the decision, not the outbox row. `change-lifecycle.test.ts` asserts the row
counts of all four new tables plus `decision_revisions`, `decision_operations`
and `account_mappings` before and after a failing guard.

## Tables (migration `0031_operations.sql`)

Additive only. No existing table, view, trigger or row is altered, and a Worker
build that predates the migration never reads or writes these tables.

| Table                | Role                                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `change_plans`       | `plan_id` (PK, = the digest), `kind`, `payload_json`, `base_context_id`, `expected_revisions_json`, `simulation_json`, `created_by`, `created_at`, `expires_at`, `status` (`planned`/`approved`/`committed`/`stale`/`rejected`). |
| `approvals`          | `approval_id` (PK), `plan_id`, `plan_digest`, `approver_actor`, `approver_verification` (always `server`), `scope_json`, `expires_at`, `uses_remaining`, `created_at`.                                                           |
| `operation_receipts` | `operation_id` (PK), `principal`, `operation_kind`, `payload_digest`, `plan_id`, `status` (`accepted`/`published`/`failed`), `result_json`, `created_at`, `published_at`; `UNIQUE(principal, operation_id)`.                     |
| `decision_outbox`    | `id`, `decision_revision_id`, `principal`, `operation_id`, `target`, `enqueued_at`, `processed_at`, `attempts`, `last_error_code`, `outcome`, plus the lease/backoff columns; `UNIQUE(decision_revision_id, target)`.            |

Triggers, following 0018/0029:

- Nothing may be deleted anywhere; nothing may be inserted twice.
- `change_plans`: only `status` moves, and only away from `planned`/`approved`.
- `approvals`: the single permitted update is `uses_remaining = uses_remaining - 1`.
  An approval's `plan_digest` must equal its `plan_id`; the insert is refused
  otherwise.
- `operation_receipts`: only `status` (`accepted` → `published`/`failed`) and
  `published_at` move; a receipt is always inserted as `accepted`.
- `decision_outbox`: only `processed_at`, `attempts`, `outcome`,
  `last_error_code` and the lease columns move, `attempts` never decreases, and
  a processed row is never reopened — which is what makes a duplicate delivery
  a no-op rather than a rewrite.

`operation_id` is the primary key **and** `(principal, operation_id)` is
unique. Idempotency lookups happen in the principal's namespace; a second
principal reusing an operation id is refused with `idempotency_conflict`
rather than being allowed to collide.

## Idempotency and receipts

`commit` looks the receipt up in the `(principal, operationId)` namespace
before it looks at the approval:

- same key, same payload → the stored receipt, no second mutation;
- same key, different payload → `idempotency_conflict`;
- **an expired approval on an already committed operation still returns the
  existing receipt.** A reconnecting client is never told to redo an accepted
  judgement (addendum 10 §5). A new side effect still needs a valid approval.

The commit payload digest is computed server-side over
`{ planId, approvalId, kind, payload }`. A caller may send
`idempotencyPayloadDigest`; a mismatch is `idempotency_conflict`.

`accepted` ≠ `published`. `accepted` means the judgement is durable;
`published` means every outbox row of that operation has been processed. The
confirmation screen shows them as different states, and neither the UI nor an
agent may report an accepted change as "all screens updated" (addendum 10 §5,
addendum 11 §5).

## Decision outbox

This is **not** the collector R2 import outbox (addendum 12 §3). That one
carries fetched evidence towards the central store; this one carries accepted
internal judgements towards the read models.

`services/observation-pipeline/src/decision-outbox.ts` runs one bounded pass
per `scheduled` invocation: it claims up to 20 due rows under a 60 s lease,
runs each target's processor, marks the row processed with a safe outcome code,
and turns the operation's receipt `published` once no row of that operation is
unprocessed. A failure records a safe code (`Error`, never an exception
message), releases the lease and backs the row off exponentially, up to five
attempts.

| Target                | Processor today                                                                                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity-projection` | Runs a bounded `identitySweep`. The sweep only creates identity runs that are missing and seals them once, so a duplicate delivery changes nothing. Outcome `identity_swept`.                                                                                                                                     |
| `balance-projection`  | Probes for A07's `balance_projection_scopes`. Absent → `skipped_no_projection`. Present but with no invalidation rule in this build → `deferred_to_projection_owner`; A07 replaces the processor through `dispatchDecisionOutbox`'s `processors` argument rather than this file growing a guess about its schema. |
| `agent-notify`        | No transport exists yet: `skipped_no_consumer`. The commit does not enqueue this target.                                                                                                                                                                                                                          |

Delivery is assumed duplicated, out of order and interrupted. Nothing claims
exactly-once from a queue id; the guarantees come from the durable row, the
lease, the `processed_at` condition and the processors' own idempotence.

## Who writes what

Addendum 12 §2 asks for one write owner per area. The **observation pipeline**
is that owner for the decision, approval, receipt and outbox tables. The
evidence browser has a D1 binding, but a binding is not a business write
permission: it authenticates the human with the Access JWT, decides the grant,
and forwards to the pipeline's private `POST /command/v1/*` routes over a
`PIPELINE` service binding (the same pattern the importer uses for
`kogane-ingest`). Without that binding the browser answers
`503 command_executor_unavailable`; there is no fallback write path from the
reader.

Both sides check the grant. The browser refuses an agent's `approve`/`commit`
before forwarding; the pipeline refuses it again from the
`x-kogane-actor-kind` header, at the same private trust level as `/sweep` and
`/identity-revise`.

The identity mutation is not re-implemented. `prepareIdentityCommand` in
`identity-commands.ts` hands `executeIdentityCommand`'s own statements to the
commit, which puts them in its own batch under its own receipt guard. There is
one definition of what an identity command writes.

## HTTP contract

```
POST /api/command/v1/plan       { kind, payload, baseContextId? }  -> { plan, created }
POST /api/command/v1/simulate   { planId }                          -> { report }
POST /api/command/v1/approve    { planId, planDigest, scope? }      -> { approval, plan }
POST /api/command/v1/commit     { operationId, planId, approvalId,
                                  idempotencyPayloadDigest? }       -> { receipt, replayed }
POST /api/command/v1/operation  { operationId }                     -> { receipt }
```

- Access JWT required on every route; the actor is the verified `sub`, never a
  body field or a header the client controls.
- POST only, on exactly these five paths. Everything else in the evidence
  browser stays GET-only; any other non-GET request is still `405`.
- No query string, body bounded to 16 KiB, `no-store` on every answer.
- Only the upstream status and JSON body cross back to the client: no upstream
  headers, no exception text, no provider content.

### Grants

`AGENT_GRANTS` is a JSON array of verified subjects that are **agents**: they
hold `interpretation.propose` and may plan and simulate. Every other
authenticated subject is the human operator and holds
`interpretation.accept` as well. An agent's `approve`/`commit` is
`403 approval_required`; an agent sending `approved: true` is not an approval
(addendum 10 §5). A malformed or absent list yields no agents, which only ever
_removes_ capabilities from listed subjects.

### Error codes

The nine machine-useful codes of addendum 10 §9 —
`needs_scope_resolution`, `incomplete_evidence`, `unsupported_semantics`,
`needs_rule_verification`, `stale_context`, `approval_required`,
`idempotency_conflict`, `budget_exceeded`, `evidence_restricted` — plus the
lifecycle codes `invalid_command`, `commands_disabled`, `plan_not_found`,
`plan_expired`, `plan_not_open`, `approval_not_found`, `approval_expired`,
`approval_exhausted`, `approval_scope_mismatch`, `receipt_not_found`,
`target_missing`, `target_ambiguous`, `commit_failed`.

Statuses: 400 invalid input, 403 refusal (`approval_required`,
`commands_disabled`, `evidence_restricted`), 404 not found, 409 conflict
(`stale_context`, `idempotency_conflict`, approval/plan state), 429
`budget_exceeded`, 500 `commit_failed`. No error text carries provider content,
an amount, a token or an exception string; `refs` holds safe identifiers only.

## UI

`/confirm/:planId` (`poc/observation-pipeline/web/src/pages/Confirm.tsx`) shows
the plan's targets, the server-computed diff (counts and identifiers only — no
amounts), the staleness of the plan and the re-simulated plan id when it went
stale, and Approve / Commit buttons. The buttons act only when the API
advertises `commands: true`; without it the screen is read-only and says so.
After a commit the receipt panel distinguishes `受理` (accepted) from
`反映済み` (published) and offers a re-check rather than claiming completion
(addendum 11 §5).

One operation id is derived per approval, so a resend of the same confirmation
is the same operation and a lost response never commits twice.

## Capability

`commands` is a new field of `ApiCapabilities`
(`poc/observation-pipeline/shared/api-schema.ts`). It is `false` in both shared
constants; the evidence browser overrides it on `/api/meta` from the running
deployment's `COMMANDS_ENABLED` flag. It is a display capability, not an
authorization decision.

## Flags, deploy order and rollback

`COMMANDS_ENABLED` (wrangler var on the evidence browser) is off unless it is
exactly `"true"`. While off, every command path answers
`403 commands_disabled` and `/api/meta` advertises `commands: false`.

1. Apply `0031_operations.sql`. Additive; independent of 0029 (which it needs
   for `decision_revisions` and `entity_relations`) and of 0026/0035.
2. Deploy `services/observation-pipeline` — the writer: the command routes and
   the outbox dispatcher. The dispatcher is a no-op until rows exist.
3. Deploy `services/evidence-browser` with `COMMANDS_ENABLED` unset. The
   command paths are closed; nothing else changed for readers.
4. Enable by setting `COMMANDS_ENABLED=true`.

**Rollback: unset the flag.** The command paths close immediately and the
reader is exactly what it was. The previous pipeline build ignores the new
tables. Receipts and outbox rows are additive and are never deleted; a decision
already recorded is never undone by a DELETE — an undo is a new revision
(addendum 07 §7). A plan or approval that is no longer wanted is left as
`stale`/spent, not removed.

## Verified locally (synthetic data only)

- `services/observation-pipeline/test/change-lifecycle.test.ts` (15 tests):
  plan contents and server-computed impact; SC17/AT69 (approval refused with
  `stale_context` after a concurrent change, plan marked stale, re-simulation
  yields a new digest); a stale plan refused at commit with **no rows written
  anywhere**; same principal + operation id + payload → the same receipt with
  no second mutation; a different payload under the same key →
  `idempotency_conflict`; an expired approval on a committed operation still
  returning the receipt, and a receipt invisible outside its principal's
  namespace; two parallel commits of one approved plan → exactly one succeeds;
  a resent identical commit racing itself → one receipt, one mutation; typed
  relations with their own decision and no derived `same_account` (SC06); an
  agent refused approval and commit; approval digest/expiry/scope binding; the
  outbox publishing once and a duplicate delivery changing nothing; a throwing
  target retried with backoff, never marked processed, with the receipt staying
  `accepted`; the private routes' actor requirements; append-only enforcement
  on all four tables; migration 0031 applied on a seeded 0017–0035 schema with
  no existing row touched.
- `services/evidence-browser/test/command-api.test.ts` (9 tests): 401 without
  a JWT, 403 with the flag off or set to anything but `"true"`, POST-only and
  404 for unknown command paths, the rest of the Worker still GET-only, an
  agent refused approve/commit before forwarding, `503` when the writer binding
  is absent, body and query-string bounds, `no-store` and no credentials in the
  answer, and the capability advertised from the flag.
- `packages/application/test/command.test.ts` (11 tests): the closed kind list,
  payloads that reject a caller-supplied impact/approval/revisions, digest
  sensitivity to every input, grants, and the error table.
- `poc/observation-pipeline/test/confirm.browser.test.ts` (3 tests): read-only
  without the capability, no action on a stale plan, and accepted vs published
  shown distinctly.

Not verified: production data; the balance projection invalidation (A07's
tables do not exist yet, so the processor records `skipped_no_projection`);
behaviour under more than two concurrent Workers (the receipt reservation and
the in-batch revision guard are the arbiters, and the tests exercise two).
