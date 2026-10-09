# Plan: AI as a delegated operation path, with a common audit log

- Status: **proposed**. Slice S1 (section 8) is implemented
  ([audit log](../audit-log.md)); of S3 only the inert declaration core
  (#628) is, and no delegated operation executes; S4 is on #564 up to the
  delegation gate (its tool refuses every call until S3 connects execution);
  no other slice is. The decisions it
  rests on are [ADR 0063](../adr/0063-delegated-ai-operation-path.md)
  (delegated AI operation path) and
  [ADR 0064](../adr/0064-common-audit-log.md) (common append-only audit log),
  both `proposed` until their pull request merges. Each implementation slice
  (section 8) is its own pull request with its own independent review; merging
  this plan approves none of them.
- Written: 2026-10-09, from `origin/main` `c4f611d`, by the AI-operation-path
  design agent, after the owner changed the product requirements the same day.
  Open PRs read: #564 (head `3b5c2c3`), #565 (head `9c25877`).
- Nothing here changes a grant, an Access application, a policy, a secret or a
  Wrangler configuration. No production data was read.
- Merging this pull request answers none of the owner questions 1–3 (section
  10), grants nothing and enables nothing: no Access application or policy,
  grant, `MCP_DELEGATIONS` entry, session length, authentication or
  production change.

## 0. Requirement

The owner's words (2026-10-09), and their translation:

| Owner (verbatim)                                                                             | Translation                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 「条件を限定してAIが直接反映できるようにする」                                               | Let the AI apply changes directly, under limited conditions.                                                                    |
| 「基本的に人間ができることはすべてAIができてほしい。AI経由で使うのがメインになる予定なので」 | Basically, I want the AI to be able to do everything a human can, because using the system through the AI will be the main way. |
| 「これは人間の操作もだけど、監査ログみたいなの記録してこれもAIから読めるようにしてね」       | Record something like an audit log — of human operations too — and make it readable from the AI as well.                        |

The owner's elaboration, as briefed:

- #564 (maintenance-window MCP tools) is no longer "proposal required": design
  conditional direct application by the AI.
- MCP is not permanently fixed to read and propose. An authenticated owner can
  explicitly delegate to the AI, as an operation path, the same permissions the
  web UI has. The premise that confirm, reject, accept, commit and settings
  operations are excluded merely because the path is AI is re-examined,
  operation by operation.
- This is not full power for an anonymous agent, and not permission to change
  grants or Access now.
- Kept: Cloudflare Access authentication (no custom authentication, ever); a
  verified subject mapped to an explicit role and capability set; default deny;
  source and account scope; revocation; concrete confirmation for important
  operations; idempotency; stale checks; rollback. No return of the bare-`sub`
  fallback or of audience confusion (ADR 0047, #565: a dedicated MCP Access
  audience and the attenuated `mcp-client:<sub>` principal). Every operation
  goes through the common application command layer; no command is
  implemented twice.
- An audit log common to the human UI and to AI/MCP: append-only records of
  subject, delegated principal, operation path (`ui` / HTTP agent route / `mcp`
  / `alarm` / `lane`), operation, target, result, time, correlation id,
  idempotency key and a safe change diff (closed codes, ids, revision numbers;
  never provider text or amounts). Refusals and failures are recorded. No
  credential, token, OTP or raw bank body is ever recorded. The AI reads it over
  MCP and HTTP according to its permissions.
- Read, search and detail are available over MCP according to permissions,
  without leaking an out-of-scope source, count or metadata (#565's P1 finding:
  a global `LIMIT 501` window before the scope filter let a denied source's
  activity change an in-scope count).
- The existing audit, decision and commit logs are inventoried and reused; no
  duplicate implementation.
- The new design gets an Opus/Codex fresh review; the initial implementation is
  not handed to Cursor. #565's P1/P2 fixes (P1: scope before the `LIMIT 501`
  window; P2: a grant built from the verified key, never from its body; both
  written out in section 8, S2) stay mandatory and are in progress separately.

## 1. Facts this plan starts from

Code on `origin/main` `c4f611d`, unless a PR is named.

**Who is graded, and by what.**

| Variable / object                                                 | Shape                                                 | Grades                                                                                                                                                                      | Where                                                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPERATOR_SUBJECTS`                                               | JSON array of Access subjects                         | the human operator: `interpretation.propose` + `interpretation.accept` on the five command routes, the six `/api/ops/v1` routes and the schedule settings routes            | `resolvePrincipal` (`packages/application/src/command/grants.ts`), `principalFor` (`services/app/src/grants.ts`) |
| `AGENT_GRANTS`                                                    | JSON array of Access subjects                         | change-lifecycle agents: plan and simulate, `403 approval_required` on approve/commit                                                                                       | same resolver                                                                                                    |
| `AGENT_API_GRANTS`                                                | JSON object, principal → grant                        | what the agent API lets a principal read (`summary.read`, `records.read`, `evidence.read`) and whether it may propose (`interpretation.propose`); the `/mcp` transport gate | `packages/application/src/grants.ts`, `agentGrant` (`services/app/src/agent-api.ts`)                             |
| `AgentCaller` (#565, ADR 0047)                                    | `{kind: "mcp-client", principal: "mcp-client:<sub>"}` | whoever signed in through the dedicated MCP Access application; its grant is only the `AGENT_API_GRANTS` entry of `mcp-client:<sub>`                                        | `mcpCaller` (`services/app/src/auth.ts` on #565)                                                                 |
| `schedules.read`, `schedules.maintenance.update` (#564, ADR 0046) | agent-API capabilities with `scopes.scheduleSources`  | the two maintenance MCP tools; an agent revision is adopted when saved, bounded by a 7-day joined deferral and 30 revisions per principal per day                           | `packages/application/src/grants.ts`, `services/app/src/schedule-tools.ts` on #564                               |

All of them deny by default. `AGENT_GRANTS` and `AGENT_API_GRANTS` are empty in
the committed configuration; `OPERATOR_SUBJECTS` names the human operator
([current status](../current-status.md#configured-enablement-and-api-access)).
The change lifecycle's principal kinds are exactly `human` and `agent`
(`PRINCIPAL_KINDS`, `packages/application/src/command/contract.ts`), and the
Processor's `principalOf` (`services/processor/src/change-commands.ts`) accepts
only those two.

**What the operator can do today**, in one list: section 5 maps every one of
these. The web app (`apps/web/src/pages/`) POSTs only from `Reconciliation`,
`CardOwnership` and `Purchases` (change-lifecycle `plan`), `Confirm`
(`simulate`, `approve`, `commit`, `operation`) and `Schedules` (job edit,
maintenance edit, survey decision, lease release). The operations API's six
routes have no page ("the web UI has no operations view",
[ops-api](../ops-api.md#collector-execution-adr-0048)); `identity.assign` and
`identity.release-override` are plannable over HTTP with no page. The other ten
`CHANGE_KINDS` (`card-purchase.*`, `card-refund.*`, `card-installment.*`,
`economic-event.*`) are vocabulary only: `REVIEW_PLANNERS` and
`ECONOMIC_EVENT_PLANNERS` (`packages/application/src/operations/targets.ts`)
register no planner, so planning one is `unsupported_semantics` for every
principal and no operator can perform it. They have no row in section 5 and no
delegated capability; a planner that ships for one of them adds its capability
and risk class in its own pull request, and until then no delegation names it.

**Cloudflare facts, confirmed read-only by the owner on 2026-10-09.**

- A dedicated Access application on the `/mcp` path with Managed OAuth can
  connect MCP clients while the existing UI keeps its Gateway gate.
- An MCP Portal is likely unnecessary.
- Today there is no Managed OAuth, no MCP audience (`ACCESS_MCP_AUDIENCE` is
  unset) and the grants are empty.
- No configuration or permission is added before a concrete approval.
- The read-only connection test (#565's hand-off step 10) is the first stage,
  not the final capability limit.

**Numbers.** CORE migrations on main reach 0071. CORE 0067 is #564's; 0072 is
the financial G3 migration; 0073 and 0074 are UI candidates. This plan's audit
migration is **"0075 or later (candidate; fixed after root coordination: CORE
0072 is the financial G3 migration, 0073/0074 are UI candidates, 0067 is #564's;
re-check latest main and every open PR before the implementation PR)"**.
ADR numbers: 0057–0059 are reserved by another session, 0060 is the Container
PR's (#436), and 0061 and 0062 are the financial transfer session's (#550,
#546); this plan's ADRs are 0063 and 0064.

## 2. Goals and non-goals

Goals:

1. Every operation a person can perform in the web UI or on an operator HTTP
   route has a named MCP tool, or a written reason why it does not (section 5).
2. The AI performs an operation only as a **delegated principal**: Access
   verified it on the MCP application, the owner named it in a delegation entry
   with a role or capabilities, a scope and an expiry, and the operation's risk
   class allows delegation.
3. Each operation runs through the same application service as the UI does;
   the MCP tool only translates transport.
4. Every operation, from every path, leaves one append-only audit record
   (refusals and failures included) that the AI can read within its scope;
   reads, prepares and refusals past a principal's daily caps are aggregated
   into one record per day instead (section 6.4).
5. No read reveals an out-of-scope source, account, count or digest.

Non-goals (this plan and its first slices):

- No change to any grant, Access application, policy, audience, secret,
  service token or Wrangler variable value. Adding the empty
  `MCP_DELEGATIONS` variable is a reviewed configuration change in slice S3;
  filling it is the owner's concrete approval.
- No custom authentication, OAuth server, token, session or key handling.
- No delegation of authority itself: grants, Access, delegations, secrets,
  deployment, migrations and feature flags (class R4, section 4.5).
- No external money action (none exists; `CHANGE_KINDS` stays closed).
- No change to INV07: heuristics, rule proposal passes and AI proposals still
  only propose.
- No delegation on the browser-audience HTTP agent route
  (`/api/agent/v1/*`): it stays read and propose.

## 3. Delegation model

### 3.1 Authentication stays Cloudflare's

Unchanged from ADR 0047 (#565): the MCP endpoint has its own self-hosted
Access application with Managed OAuth; `/mcp` accepts only an assertion for
`ACCESS_MCP_AUDIENCE`; every other route accepts only the browser audience and
refuses one naming the MCP audience; the boundary builds the `AgentCaller`
`{kind: "mcp-client", principal: "mcp-client:<sub>"}` once and hands that
object, never the bare subject, to every tool. This plan adds nothing to
authentication.

### 3.2 The delegated principal

A new deployment variable on `services/app`, **`MCP_DELEGATIONS`** (a JSON
object; ships `""`, meaning no delegation), is the owner's explicit
declaration. Synthetic example:

```jsonc
{
  "mcp-client:owner-subject-0001": {
    "delegatedBy": "owner-subject-0001",
    "role": "maintainer",
    "capabilities": ["operations.collection.request"],
    "scopes": { "sources": ["sony-bank"], "accounts": "*", "scheduleSources": ["sony-bank"] },
    "issuedAt": "2026-10-10T00:00:00Z",
    "notAfter": "2026-12-31T00:00:00Z",
    "budget": { "writesPerDay": 30 },
  },
}
```

Validation (`packages/application/src/delegation/parse.ts`), all fail closed;
one invalid entry makes the whole table `delegation_misconfigured` (503 for
every delegated operation, as an unreadable grant list does today):

- the key is `mcp-client:` followed by exactly `delegatedBy`, and
  `delegatedBy` is currently in `OPERATOR_SUBJECTS`: **the owner can delegate
  only to their own MCP identity**; a bare subject, another person's
  `mcp-client:` name or a delegator who is not the operator is invalid;
- the entry body has exactly the documented keys (`capabilities` optional) and
  no other: a body naming a `principal`, or any unknown key, is invalid, and the
  delegated principal is always the verified map key (the lesson of #565's P2,
  section 8);
- `role` is one of the closed roles and `capabilities` (optional additions)
  are in the closed delegation vocabulary (3.3); an R3 or R4 operation has no
  name in it;
- `scopes` are within the same principal's `AGENT_API_GRANTS` entry, axis by
  axis (a delegation can never see more than its read grant);
- **write scope**: an entry whose effective set holds any `commands.*`
  capability or `operations.projection.request` is valid only with `"*"` on
  both `sources` and `accounts`, because a plan's targets (a card settlement
  joining a card and a bank source, a relation, a mapping) and a projection
  rebuild span sources and accounts, and no per-target scope check is proven
  yet; a listed scope with one of them is invalid. The source-bound operations
  requests (`operations.collection.request`, `.import.request`,
  `.replay.request`, `.session.refresh`; H2–H4, H6) check the requested
  source against `scopes.sources` before anything is stored, and an
  out-of-scope source is refused exactly like an unknown one. Schedule writes
  check `scopes.scheduleSources`. Narrower write scopes for commands come with
  per-target checks in their own pull request;
- `issuedAt < notAfter`, and `notAfter - issuedAt` is at most 90 days; before
  `issuedAt` the entry is inert (`delegation_not_yet_valid`), after `notAfter`
  it is inert (`delegation_expired`), and in both cases reads continue under
  `AGENT_API_GRANTS` alone;
- `budget.writesPerDay` is 1–200, counted over the principal's `applied` and
  `accepted` audit records of the last 24 hours, before execution; a write past
  it is refused `delegation_budget_exceeded` and changes nothing;
- at most 8 entries.

**Limit: a delegation is to the owner's MCP identity, not to one AI.** ADR
0047 makes every MCP client the owner signs in with — claude.ai, ChatGPT,
Codex, Claude Code — the same principal `mcp-client:<sub>`, so a delegation
applies to all of them at once; the server cannot tell them apart, and the
audit record cannot say which client acted. Separating clients would need
separate Access identities (a separate decision). Question 2 (section 10)
asks the owner to accept this.

The resolver (`resolveDelegation(env, caller)`) answers a
`DelegatedPrincipal {kind: "delegated", id: "mcp-client:<sub>", delegator:
"<sub>", capabilities, scopes, notAfter, delegationRef}` or a refusal.
`delegationRef` is `dlg_` + the canonical digest (`canonical-json-v1`) of the
entry, so every audit record names the exact entry that authorized it, and a
changed entry is visible as a new ref.

**What it composes with, and what it never does:**

| Mechanism              | Relationship                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR 0047 `AgentCaller` | A delegation resolves **only** from an `AgentCaller` of kind `mcp-client` built by `mcpCaller` from the MCP audience. A browser-audience token, the HTTP agent route and the bare subject never yield one.                             |
| `principalFor`         | Still refuses any `mcp-client:` string, whatever the lists say (#565). A delegated principal is never graded by it and never reaches `/api/command/v1/*`, `/api/ops/v1/*` or the schedule settings routes; those stay browser-only.    |
| `OPERATOR_SUBJECTS`    | Read only to check `delegatedBy`. Removing the operator from it invalidates the delegation table.                                                                                                                                      |
| `AGENT_GRANTS`         | Not consulted. A delegated principal is not a change-lifecycle agent; listing it there changes nothing for delegated operations.                                                                                                       |
| `AGENT_API_GRANTS`     | Still the `/mcp` transport gate and the read/propose table; its vocabulary still cannot name an acceptance. The delegation's scope must be inside it.                                                                                  |
| Change lifecycle       | `PRINCIPAL_KINDS` gains `delegated`. The App forwards `x-kogane-actor-kind: delegated`, the principal, the delegated command families and the `delegationRef`; the Processor refuses a family it was not forwarded (defence in depth). |

### 3.3 Capabilities and roles

Read capabilities stay in `AGENT_API_GRANTS` (its vocabulary gains
`reviews.read` and `audit.read`, beside #564's `schedules.read`); operation
capabilities exist only in `MCP_DELEGATIONS`:

| Delegated capability              | Allows (section 5 rows)                                                                         | Risk  |
| --------------------------------- | ----------------------------------------------------------------------------------------------- | ----- |
| `commands.plan`                   | `command.plan` (R1), `command.simulate` and `command.operation.get` (R0) (W7–W10, W13)          | R0/R1 |
| `commands.decide.card-settlement` | approve and commit `card-settlement.accept` / `.reject` / `.withdraw` (W11, W12)                | R2    |
| `commands.decide.relation`        | approve and commit `relation.accept` / `.reject`: pending-to-posted links, ownership (W11, W12) | R2    |
| `commands.decide.identity`        | approve and commit `identity.assign` / `identity.release-override` (H1)                         | R2    |
| `schedules.maintenance.update`    | maintenance revisions (W3); moved here from #564's agent-API vocabulary                         | R1/R3 |
| `schedules.survey.decide`         | accept (R2) or reject (R1) a re-survey proposal (W4, W5)                                        | R1/R2 |
| `schedules.job.update`            | job time, weekdays, interval, zone, enable/disable (W1, W2)                                     | R2    |
| `operations.import.request`       | H3                                                                                              | R1    |
| `operations.replay.request`       | H4                                                                                              | R1    |
| `operations.projection.request`   | H5 (whole store: needs `"*"` on both axes)                                                      | R1    |
| `operations.collection.request`   | H2 (provider contact)                                                                           | R2    |
| `operations.session.refresh`      | H6 (provider contact)                                                                           | R2    |
| `operations.read`                 | H7, the principal's own operations                                                              | R0    |

Every `commands.*` capability also needs `"*"` on both scope axes (3.2, write
scope). `schedules.maintenance.update` is R1 inside the direct envelope and R3
beyond the 7-day bound until question 1 is answered (4.6).

Roles are closed bundles in code: `maintainer` (`schedules.maintenance.update`,
`schedules.survey.decide`, `operations.import.request`,
`operations.replay.request`, `operations.read`; valid with listed scopes),
`reviewer` (`commands.plan`, `commands.decide.card-settlement`,
`commands.decide.relation`; needs `"*"`) and `operator-delegate` (every
delegated capability above; needs `"*"`). The effective set is
the role's bundle plus the listed additions. There is no capability for R3
(`schedules.lease.release`) or R4.

### 3.4 Revocation

Each is effective on the next request, and none deletes a record:

1. Remove the entry, or set `MCP_DELEGATIONS` to `""`: delegated tools are
   unpublished and refused `delegation_not_configured`; reads continue under
   `AGENT_API_GRANTS`.
2. `notAfter` passes: `delegation_expired`.
3. Remove the delegator from `OPERATOR_SUBJECTS`: the table is misconfigured,
   every delegated operation is `503 delegation_misconfigured`.
4. Remove the `AGENT_API_GRANTS` entry: `/mcp` answers
   `403 agent_api_not_configured` before any tool.
5. Remove the person from the MCP Access application's policy, or unset
   `ACCESS_MCP_AUDIENCE`: no MCP caller exists (ADR 0047).

What was applied stays applied; it is undone by a reverting operation
(section 4.4), itself audited.

### 3.5 Stages

1. Read-only connection test (#565 hand-off steps 1–10): `summary.read` on one
   source. No delegation. The test also confirms, by an equality check that
   copies no value, that the owner's subject on the MCP application is the
   subject `OPERATOR_SUBJECTS` names (ADR 0047's premise that Managed OAuth
   forwards the same identity); the `delegatedBy` rule depends on it, and if it
   does not hold no entry can be valid (fail closed) until a separate decision.
2. Read expansion (slice S5), one capability per release.
3. First delegated writes: the owner's concrete approval names the entry; the
   proposed first one is `maintainer` on one schedule source (R1 maintenance
   inside the direct envelope).
4. Further capabilities, one per release, each after the audit of the previous
   one has been read. No entry with a financial-adoption (`commands.decide.*`)
   or provider-contact (`operations.collection.request`,
   `operations.session.refresh`) capability is proposed before the owner
   answers question 1 (section 10).

## 4. Per-risk confirmation policy

### 4.1 Risk classes

| Class | Meaning                                                                                                                                                                                | Delegated confirmation                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| R0    | Read; nothing changes                                                                                                                                                                  | none                                                                                                    |
| R1    | Bounded and reversible by a further operation; changes no adopted financial state; contacts no provider                                                                                | **direct**: one call, with an idempotency key and, where the target is versioned, the expected revision |
| R2    | Changes adopted state or a collection schedule, or contacts a provider                                                                                                                 | **two-step**: prepare returns a confirmation digest; confirm presents it with the identical payload     |
| R3    | Needs a judgement about runtime state the server cannot verify, a wrong call having no reverting operation; or held for the owner's decision (maintenance deferral beyond 7 days, 4.6) | operator in the UI only; not delegable now                                                              |
| R4    | Authority, secrets, deployment                                                                                                                                                         | no tool, no route; never delegable                                                                      |

A delegation entry may make a class stricter for itself (never looser); that
is the only per-entry override, and it is a later addition, not part of S3.

### 4.2 Two-step confirmation

**Change-lifecycle commands (W11, W12, H1).** The lifecycle already is a
two-step confirmation, and the delegated path uses it unchanged:
`kogane.command.plan` returns the plan whose id **is** its digest
(`canonicalDigest({kind, payload, expectedRevisions, baseContextId})`);
`kogane.command.approve` must present that `planDigest`, re-checks every
expected revision and marks a moved plan `stale`; `kogane.command.commit` must
present the `approvalId` and an `operationId`, and the commit batch verifies
every expected revision inside the receipt reservation
([change lifecycle](../change-lifecycle.md#expected-revisions)). The approval
row records `approver_actor = "mcp-client:<sub>"`. Nothing new is stored.

**Settings and operations requests (W1–W4, H2, H6).** Their writers are single
step. A generic confirmation, `packages/application/src/delegation/confirm.ts`:

1. `step: "prepare"` validates the payload with the route's own schema,
   takes the caller's `expectedRevision` (the revision it read), resolves the
   target and its current revision, and refuses `revision_conflict` when they
   differ, before anything is recorded; the digest therefore binds the
   revision the caller saw, as section 4.3 requires. H2 (collection) and H6
   (session refresh) target a source, which has no revision: their prepare
   checks scope, the source policy and the connection only, `expectedRevision`
   is absent from their digest, and their protection against a repeat is the
   operation's own idempotency (same key, same `op_` operation). Otherwise the
   prepare answers `{confirmation: {digest, expiresAt}, preview}` where

   ```
   digest = "cfm_" + canonicalDigest({
     v: "kogane-confirm-v1", operation, principal, delegationRef,
     targetRef, expectedRevision, payloadDigest, idempotencyKey, expiresAt })
   ```

   `expiresAt` is at most 10 minutes ahead. `preview` is the safe diff the
   confirm would apply (closed field names, revisions, counts; section 6.2).
   The prepare writes one audit record with `result = "prepared"`, the digest
   and the expiry. No other row is written.

2. `step: "confirm"` resends the identical payload, the same idempotency key
   and the digest. The server recomputes the digest, requires an unexpired
   `prepared` record with that digest for this principal and delegation, runs
   the writer (whose own version check is the final stale check), and appends
   the `applied` audit record, which names the prepared record in
   `confirms_audit_id`, **as the last statement of the writer's own D1
   batch**. A unique partial index allows one `applied`/`accepted` record per
   `confirms_audit_id`, so a second confirm — raced or replayed — rolls its
   whole batch back.

Refusals: `confirmation_required` (R2 called without `step`),
`confirmation_invalid` (no matching prepare, other principal or delegation,
payload changed), `confirmation_expired`, `confirmation_used`, and the
writer's own `revision_conflict` / `stale_context`. A client confirmation
dialog is not relied on ([agent API](../agent-api.md#why-the-application-service-exists)).

No secret is involved: the digest is not a bearer token; it binds a confirm
to a prepare the server recorded.

### 4.3 Stale checks and idempotency

- Every versioned write carries the expected revision the caller read
  (schedule `revision`, maintenance rule `revision`, proposal base revision,
  plan `expectedRevisions`). The writer's compare-and-set inside its batch is
  the authority; a pre-read is only for a better error.
- Every delegated write carries an idempotency key
  (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, the operations API's pattern). Where
  a writer already has idempotency (operations requests: `op_` id from the key;
  commands: `operation_receipts` by `operationId`), it is used as it is. Where
  it has none (schedule and maintenance writes), a unique partial index on the
  audit table over `(principal, operation, idempotency_key)` for
  `applied`/`accepted` records gives it: the same key and payload digest
  answers the stored outcome as `replayed`; a different payload is
  `idempotency_conflict`.

### 4.4 Rollback

Evidence and decisions are append-only, so a rollback is a new operation that
restores the previous state, recorded with `reverts_audit_id`:

| Operation                               | Rollback                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| maintenance revision, survey acceptance | a further maintenance revision restoring the previous pattern/enabled/scope (same writer) |
| job edit, enable/disable                | a further job revision with the previous values (same writer)                             |
| `card-settlement.accept`                | `card-settlement.withdraw`                                                                |
| `relation.accept` (link or ownership)   | `relation.reject` of the accepted relation (its withdrawal)                               |
| `identity.assign`                       | `identity.release-override`                                                               |
| import, replay, projection request      | none needed: registration, a planned replay and a rebuild adopt nothing by themselves     |
| collection, session refresh             | none possible: a provider contact cannot be undone, which is why both are R2              |
| proposal, plan                          | none needed: inert                                                                        |

### 4.5 Never delegable now

R3, operator in the UI only: **stopped-execution lease release**
(`POST /api/ops/v1/schedules/leases/:source`). Releasing a lease whose
execution is still running permits a second provider session; only a person
who checked the execution can confirm it stopped
([schedules](../schedules.md)). It gets an audit record on the `ui` path.

R4, no tool and no route on any delegated path: changes to
`OPERATOR_SUBJECTS`, `AGENT_GRANTS`, `AGENT_API_GRANTS`, `MCP_DELEGATIONS`,
`ACCESS_AUDIENCE`, `ACCESS_MCP_AUDIENCE`, `HEALTH_PROBE_TOKENS`,
`DEPLOYMENT_SCHEDULE_TOKENS` or any Access application or policy; issuing a
secret, service token, collector credential or API key; deploying a Worker;
applying a migration; changing a feature flag, `OPS_COLLECTOR_DISPATCH_CONNECTIONS`,
`SESSION_REFRESH_POLICY`, `MAINTENANCE_SURVEY_ENABLED` or the page enablement
of `config/maintenance-survey.json`; the schedule bootstrap route; the reserved
`economic-event.resolve-identity` kind; any identity-epoch rewrite.

### 4.6 #564 re-shaped: conditional direct maintenance writes

The maintenance tool keeps #564's one writer (`writeMaintenanceRevision`) and
its bounds, and changes in four ways:

1. **Who.** The write capability moves from the agent-API vocabulary to
   `MCP_DELEGATIONS`; `schedules.read` stays a read capability. The writer's
   actor kinds become `operator` and `delegated` (CORE 0067 is #564's and is
   still unmerged, so its CHECK is rewritten before merge, not migrated
   again; S4 renumbers it CORE 0076). The same rewrite changes 0067's partial index
   `maintenance_agent_writes` from `WHERE actor_kind='agent'` to
   `WHERE actor_kind='delegated'`, so the daily budget check inside the
   `INSERT` keeps an index to read.
2. **Why, as a closed code.** #564's free-text `change_reason` (1–500
   characters) becomes a closed code, following #575's pattern
   (`ACCEPTED_REASON = "maintenance-survey-proposal-accepted"` and closed reason
   sets checked by the schema): `MAINTENANCE_CHANGE_REASONS` in
   `packages/collection/src/schedule-model.ts` — `official-notice-added`,
   `official-notice-changed`, `official-notice-withdrawn`, `outage-observed`,
   `owner-instructed`, `correction`, `operator-edit` (the UI path) and the
   existing `maintenance-survey-proposal-accepted` — enforced by 0067's CHECK.
   `decision_ref` of a delegated revision names its audit record; S4 settled
   the shape as `delegated-audit:<audit_id>` (the S4 status in section 8).
3. **Direct inside the envelope; beyond it, the operator for now.** Direct
   (R1) when all hold: the source is in `scopes.scheduleSources`; the rule is
   the named source's or new; after the revision the source has no joined
   deferral longer than 7 days that its rules did not already cause (#564's
   `deferralUnions` measure, unchanged); the principal's 30 revisions per
   rolling day are not spent; the reason is a closed code; the reference is
   https on the source's registered host; the expected revision matches. A
   revision outside the 7-day bound, and only that condition, is **R3 until
   the owner answers question 1** (section 10): the tool refuses it
   (`maintenance_deferral_too_long`, as #564 does today) and the operator
   makes it in the UI. Its target class is R2 (prepare/confirm) up to a hard
   ceiling of a **31-day** joined deferral, which applies once the owner has
   answered question 1 (it decides only the stage); a longer one stays the
   operator's in every case. A spent budget, an
   unregistered host or an out-of-scope source is refused with its code;
   nothing escalates them.
4. **Audited.** Each call writes one audit record; an applied revision's
   record is in the writer's batch.

## 5. UI operation ↔ MCP mapping

Common audit envelope on every row: subject, principal, principal kind,
`delegationRef`, path, operation, risk class, step, scope, result and closed
code, correlation id, idempotency key, payload digest, time. The last column
lists only the row's own target, diff and refs. Tool names keep the `kogane.`
prefix of the existing tools; the operation name in the audit record is the
tool name without it.

### 5.1 Writes the web UI performs

The command rows (W7–W13) need `"*"` on both scope axes for a delegated
principal (section 3.2, write scope).

| #   | UI action (page → control)                                            | Existing command / API → writer                                                                                | Proposed MCP tool                                       | Capability                                    | Risk                                                                                                                                 | Confirmation                                                                | Audit target · diff · refs                                                                                       |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| W1  | 収集スケジュール → schedule card → time/weekdays/interval/zone → 保存 | `POST /api/ops/v1/schedules/:id` → `updateSchedule` (`services/processor/src/schedule-store.ts`)               | `kogane.schedules.job.update`                           | `schedules.job.update`                        | R2                                                                                                                                   | two-step; expected `revision`                                               | `schedule:<id>` · revision from/to, changed field names · `collection_schedule_revisions` `<id>@<rev>`           |
| W2  | same card → enable/disable → 保存                                     | same route and writer (`enabled`)                                                                              | same tool                                               | `schedules.job.update`                        | R2                                                                                                                                   | two-step; expected `revision`                                               | same, field `enabled`                                                                                            |
| W3  | 停止時間を追加 / rule 編集 → 保存                                     | `POST /api/ops/v1/schedules/maintenance` → `updateMaintenance` (main); `writeMaintenanceRevision` (#564)       | `kogane.schedules.maintenance.update` (#564, re-shaped) | `schedules.maintenance.update`                | R1 inside the envelope (4.6); R3 beyond the 7-day bound until question 1 is answered, then R2 up to 31 days                          | direct with expected `revision` + key; beyond 7 days the operator in the UI | `maintenance-rule:<id>` · revision from/to, fields, reason code · rule `<id>@<rev>`                              |
| W4  | 公式サイトの再調査 → 採用                                             | `POST /api/ops/v1/schedules/proposals/:id {"decision":"accept"}` → `decideSurveyProposal` → maintenance writer | `kogane.schedules.survey.decide`                        | `schedules.survey.decide`                     | R2                                                                                                                                   | two-step; the proposal's base revision                                      | `maintenance-survey-proposal:<id>` · decision, rule revision · rule `<id>@<rev>`, `maintenance_survey_decisions` |
| W5  | 公式サイトの再調査 → 却下                                             | same route `{"decision":"reject"}`                                                                             | same tool                                               | `schedules.survey.decide`                     | R1                                                                                                                                   | direct + key                                                                | `maintenance-survey-proposal:<id>` · decision                                                                    |
| W6  | 停止した実行を解除                                                    | `POST /api/ops/v1/schedules/leases/:source` → `releaseCollectionLease`                                         | none (R3)                                               | —                                             | R3                                                                                                                                   | operator in the UI only                                                     | `collection-lease:<source>` · `released` (the only durable record of a release; the lease row is mutable)        |
| W7  | カード決済の照合 → 採用/却下/解除内容を確認                           | `POST /api/command/v1/plan` (`card-settlement.*`) → `createPlan`                                               | `kogane.command.plan`                                   | `commands.plan`                               | R1                                                                                                                                   | direct (a plan is inert; its id is its digest)                              | `plan:<planId>` · kind, target count · `card-settlement:<proposalId>@<rev>`                                      |
| W8  | 保有者の確認 → 採用/却下内容を確認                                    | same route (`relation.accept` / `.reject`, ownership)                                                          | `kogane.command.plan`                                   | `commands.plan`                               | R1                                                                                                                                   | direct                                                                      | `plan:<planId>` · kind · pinned mapping and ownership revisions                                                  |
| W9  | カード利用 → 候補 → 判断内容を確認                                    | same route (`relation.accept` / `.reject`, pending-to-posted link)                                             | `kogane.command.plan`                                   | `commands.plan`                               | R1                                                                                                                                   | direct                                                                      | `plan:<planId>` · kind · `card-purchase:<eventId>@<rev>`, `proposal:<id>`                                        |
| W10 | 確認画面 → 再試算                                                     | `POST /api/command/v1/simulate` → `simulate`                                                                   | `kogane.command.simulate`                               | `commands.plan`                               | R0: `simulate` reports `stale` and writes nothing (only `approve` calls `markStale`, `packages/application/src/command/simulate.ts`) | none                                                                        | `plan:<planId>` · stale yes/no, re-simulated plan id                                                             |
| W11 | 確認画面 → 承認                                                       | `POST /api/command/v1/approve` → `approve`                                                                     | `kogane.command.approve`                                | `commands.decide.<family>` of the plan's kind | R2                                                                                                                                   | the plan digest is the confirmation; revisions re-checked                   | `plan:<planId>` · approval expiry, uses · `approval:<id>`                                                        |
| W12 | 確認画面 → 確定                                                       | `POST /api/command/v1/commit` → `commit` (one guarded D1 batch)                                                | `kogane.command.commit`                                 | `commands.decide.<family>`                    | R2                                                                                                                                   | approval + `operationId`; commit guard                                      | `plan:<planId>` · simulation counts · receipt `operationId`, decision revision ids, economic `commit_seq`        |
| W13 | 確認画面 → 反映状況を再確認                                           | `POST /api/command/v1/operation` → receipt read                                                                | `kogane.command.operation.get`                          | `commands.plan`                               | R0                                                                                                                                   | none                                                                        | `operation:<operationId>` · receipt status                                                                       |

### 5.2 Actions with no page (HTTP only today)

H1–H7 are operator routes; H8 is the agents' existing proposal route.

| #   | Operator action                                    | Existing command / API → service                                         | Proposed MCP tool                              | Capability                                                      | Risk | Confirmation            | Audit target · diff · refs                                        |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------- | ---- | ----------------------- | ----------------------------------------------------------------- |
| H1  | identity assignment / release of a manual override | command routes, kinds `identity.assign` / `identity.release-override`    | `kogane.command.plan` / `.approve` / `.commit` | `commands.plan`, `commands.decide.identity`; `"*"` on both axes | R2   | as W11/W12              | `plan:<planId>` · mapping revision from/to · decision ids         |
| H2  | request a collection                               | `POST /api/ops/v1/collections` → `requestCollection`                     | `kogane.ops.collection.request`                | `operations.collection.request`; source in `scopes.sources`     | R2   | two-step                | `source:<id>` · status · `op_<id>`                                |
| H3  | re-register a persisted run                        | `POST /api/ops/v1/imports` → `requestImport`                             | `kogane.ops.import.request`                    | `operations.import.request`; source in `scopes.sources`         | R1   | direct + key            | `source:<id>` · status · `op_<id>`                                |
| H4  | replay a parse                                     | `POST /api/ops/v1/replays` → `requestReplay`                             | `kogane.ops.replay.request`                    | `operations.replay.request`; `scope.source` in `scopes.sources` | R1   | direct + key            | `source:<id>` · status · `op_<id>`, replay plan id                |
| H5  | rebuild the read model                             | `POST /api/ops/v1/projections` → `requestProjectionRebuild`              | `kogane.ops.projection.request`                | `operations.projection.request`; `"*"` on both axes             | R1   | direct + key            | none · status · `op_<id>`                                         |
| H6  | refresh a session                                  | `POST /api/ops/v1/sessions/{source}/refresh` → `requestSessionRefresh`   | `kogane.ops.session.refresh`                   | `operations.session.refresh`; source in `scopes.sources`        | R2   | two-step                | `source:<id>` · status (`waiting_for_human` included) · `op_<id>` |
| H7  | read an operation                                  | `GET /api/ops/v1/operations/{id}` → `readOperation` (own principal only) | `kogane.ops.operation.get`                     | `operations.read`                                               | R0   | none                    | `op_<id>` · status                                                |
| H8  | propose a relation (agents today)                  | `POST /api/agent/v1/reconcile.propose` → proposal store                  | `kogane.reconcile.propose` (exists)            | `interpretation.propose` (`AGENT_API_GRANTS`)                   | R1   | direct (inert proposal) | `proposal:<decision id>` · targets count                          |

The six `kogane.ops.*` names are the existing tools of
[ops-api](../ops-api.md#mcp), which #565 stops publishing on `/mcp`; S6
publishes them again **only** to a delegated principal holding the capability.

### 5.3 Reads, searches and details

"Whole-store only" means the tool refuses a grant listed on the source or
account axis with `403 evidence_restricted` before reading anything, as
`kogane.purchases.explain` does
([ADR 0013](../adr/0013-agent-card-purchase-read.md)), until a scoped version
is proven under section 7. Each tool calls the route's own reader function; no
query is copied. All are R0; MCP and HTTP agent calls write one audit record
each (`result = "read"`, a row count, no data).

| #   | UI page → API                                                                              | Proposed MCP tool                                                                 | Capability       | Scope mode                                                                                |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| D1  | 概要 → `/api/overview`, `/api/v2/query?intent=coverage`, `/api/meta`                       | `kogane.financial.query` `coverage` (exists), `kogane.capabilities` (exists)      | `summary.read`   | scoped, after #565's P1 fix (section 7)                                                   |
| D2  | 取引 → `/api/transactions`, `/api/filter-options`                                          | `kogane.transactions.search` (new)                                                | `records.read`   | whole-store only                                                                          |
| D3  | 残高 / 残高の推移 → `/api/balances`, `/api/v2/balances/latest`, `/api/v2/balances/history` | `kogane.balances.read` (new); `holdings` intent (exists)                          | `records.read`   | whole-store only; `holdings` is scoped                                                    |
| D4  | 保有 → `/api/positions`                                                                    | `kogane.positions.read` (new)                                                     | `records.read`   | whole-store only                                                                          |
| D5  | 指定日の状態 → `/api/v2/reported-state`                                                    | `kogane.reported-state.read` (new)                                                | `records.read`   | whole-store only                                                                          |
| D6  | 口座・銘柄の整理 → `/api/identity/{accounts,instruments,coverage,connections}`             | `kogane.identity.search` (new)                                                    | `records.read`   | whole-store only                                                                          |
| D7  | ポイント → `/api/v2/rewards/{holdings,expiry,simulations}`                                 | `kogane.rewards.read` (new)                                                       | `records.read`   | whole-store only                                                                          |
| D8  | カード決済の照合 → `/api/v2/reconciliation/card-settlements`                               | `kogane.reviews.card-settlements.read` (new)                                      | `reviews.read`   | whole-store only; plan payloads only with `commands.decide.card-settlement`               |
| D9  | 保有者の確認 → `/api/v2/reconciliation/card-settlements/ownership`                         | `kogane.reviews.card-ownership.read` (new)                                        | `reviews.read`   | whole-store only; plan payloads only with `commands.decide.relation`                      |
| D10 | カード利用 → `/api/v2/card-purchases`                                                      | `kogane.purchases.explain` (exists)                                               | `records.read`   | whole-store only (exists); `actions`/`relation` kept only with `commands.decide.relation` |
| D11 | 取得記録 → `/api/artifacts`, `/api/artifacts/:id`                                          | `kogane.artifacts.search`, `kogane.artifacts.get` (new)                           | `records.read`   | whole-store only                                                                          |
| D12 | 観測の詳細 → `/api/observations/:kind/:id`                                                 | `kogane.observations.get` (new)                                                   | `records.read`   | whole-store only                                                                          |
| D13 | 原本 → `/api/raw/:sha256`                                                                  | `kogane.evidence.raw.get` (new, last)                                             | `evidence.read`  | whole-store only; `evidence.read` stays a separate owner decision (ADR 0047)              |
| D14 | 取得履歴 (evidence browser) → `/api/evidence/v1/…`                                         | `kogane.evidence.runs.search` (new)                                               | `records.read`   | the route's single configured source; refused unless that source is granted               |
| D15 | 収集スケジュール → `GET /api/ops/v1/schedules`                                             | `kogane.schedules.read` (new; extends #564's `kogane.schedules.maintenance.read`) | `schedules.read` | scoped by `scheduleSources` (#564's read view); no lease state, no other principal        |
| D16 | 確認画面 (plan view)                                                                       | `kogane.command.simulate` (W10)                                                   | `commands.plan`  | the plan's own targets                                                                    |
| D17 | — → `/api/collection-quality`                                                              | `kogane.collection-quality.read` (new)                                            | `summary.read`   | whole-store only                                                                          |
| D18 | — → `/api/v2/reports/:id`, `/explanation`                                                  | `kogane.reports.read` (new); `/export` not exposed (`report.export` stays absent) | `records.read`   | whole-store only                                                                          |
| D19 | — → `/api/v2/activity`, `/api/v2/obligations`                                              | `kogane.events.read` (new)                                                        | `records.read`   | whole-store only                                                                          |
| D20 | 監査ログ (new page) → `GET /api/v2/audit`; `POST /api/agent/v1/audit.search`               | `kogane.audit.search`, `kogane.audit.get` (new)                                   | `audit.read`     | scoped by source (section 6.7); a listed account axis is refused                          |

Not exposed on any agent path: `GET /api/ops/v1/health` (the release
postcheck), `POST /api/ops/v1/schedules/bootstrap` (deployment service token),
`/api/v2/reports/:id/export`. The Processor's private service-binding routes
that no App route forwards — `/release/{register,compare,activate,rollback}`,
`/metadata/reextract`, `/sweep`, `/identity-sweep`, `/identity-revise` (the
legacy CLI) and `/replay/*` called directly — are not operations a person can
perform through the App today; they get no tool and stay unreachable from every
agent path (R4 by placement).

### 5.4 Count and gaps

41 rows: 13 UI writes (W1–W13), 8 actions with no page (H1–H7 on operator
routes, H8 the agents' proposal route) and 20 reads (D1–D20). Operations with
**no existing command or service** today:

1. Audit search and detail (D20): no table, service or route (ADR 0064, S1).
2. A confirmation step for settings and operations writes (W1–W5, H2, H6):
   their writers are single step (ADR 0063, S3).
3. A delegated principal kind in the change lifecycle and the Processor
   (`PRINCIPAL_KINDS` is `human | agent`).
4. Lease release (W6) records no actor, revision or idempotency key; the audit
   record will be its only durable trace. It stays R3.
5. Agent-facing contracts for the review queues (D8, D9): only the purchases
   page has one (`validAgentCardPurchasePage`).
6. D2–D7, D11–D14, D17–D19: the routes exist, no MCP tool does, and none is
   proven computable inside a listed scope.
7. W1, W2, W4, W5: the writers exist, no agent adapter does.
8. #564's tool exists only on its branch, with a free-text reason.

## 6. Audit log design

### 6.1 Inventory of what is recorded today

| Log (CORE migration)                                                                    | Records                                                        | Actor fields                                                      | Path fields                                | Append-only?                                | Readable by whom today                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------- |
| `decision_operations` (0029)                                                            | one decision operation: action, payload digest, result         | `actor_id`, `actor_verification`                                  | none                                       | yes                                         | no route; backs what the operator pages show                   |
| `decision_revisions` (0029)                                                             | each judgement: subject, revision, kind, reason, evidence refs | `actor_id`, `method` (`manual`/`rule`/`ai`/…)                     | none (`method` is how, not where)          | yes, except `superseded_by` set once        | operator review pages; agent proposals write it                |
| `change_plans`, `approvals`, `operation_receipts`, `decision_outbox` (0031, 0038)       | plan, approval, receipt, downstream delivery                   | `created_by`, `approver_actor`, `principal`                       | none                                       | no delete; status columns move forward only | command routes and the confirm page (operator)                 |
| `economic_commit_log` (0070)                                                            | one economic commit: sequence, members, claims, kind           | `principal`, `operation_id`                                       | none                                       | yes                                         | no route; the knowledge selector reads it                      |
| `ops_requests`, `ops_request_stages` (0040)                                             | an accepted operations request and its stage progress          | `principal`                                                       | none                                       | no delete; progress forward only            | `GET /api/ops/v1/operations/{id}`, own principal only          |
| `ops_collector_dispatches` (0068)                                                       | the execution of a collection or refresh request               | none (by `operation_id`)                                          | none                                       | no (`operational-mutable`)                  | through the operation record                                   |
| `collection_schedule_revisions` (0065)                                                  | each job setting revision                                      | `actor`                                                           | none                                       | yes                                         | no route (written, never read)                                 |
| `collection_schedules` (0065)                                                           | current job settings                                           | `updated_by`                                                      | none                                       | no (`operational-mutable`)                  | schedules page                                                 |
| `provider_maintenance_rules` (0065; +0067 on #564)                                      | maintenance rule revisions                                     | `actor` (+ `actor_kind`, `change_reason`, `decision_ref` on #564) | `actor_kind` (operator/agent) on #564 only | yes                                         | schedules page; #564's read tool                               |
| `maintenance_survey_fetches`, `_proposals`, `_decisions` (0069)                         | page readings, proposals, the operator's decisions             | `maintenance_survey_decisions.actor`                              | none                                       | yes                                         | schedules page, operator only                                  |
| `collection_schedule_occurrences` (0065)                                                | alarm occurrence receipts: status, run ids, failure code       | none                                                              | implicitly the alarm                       | no (`operational-mutable`)                  | schedules page                                                 |
| `collection_execution_leases` (0065)                                                    | which lease holds a source now                                 | none                                                              | none                                       | no; a release leaves no trace               | schedules page                                                 |
| `processor_lane_ticks` (0049)                                                           | one lane tick: outcome, closed error code, counts              | none                                                              | the lane                                   | no update, pruned to the latest day         | Processor `/internal/health`, relayed by the release postcheck |
| `publication_events` (0026), `release_activation_events` (0028), `report_events` (0034) | parser publication and activation, report lifecycle            | `actor`, `reason`                                                 | none                                       | yes                                         | no agent route                                                 |
| `account_connection_reviews`, `ingestion_attempts`, `raw_object_verification_events`    | rule-made reviews, ingest attempts, raw object checks          | verifier version, ingest client id                                | ingest client                              | yes                                         | identity and evidence pages, partly                            |
| Worker request log (`evidence_request` JSON line)                                       | route label, status, request id, error code                    | none                                                              | route label                                | not durable (Workers Logs retention)        | the Cloudflare dashboard                                       |

The effect tables those logs describe — `entity_relations`,
`card_settlement_decisions`, `settlement_relations`, `account_mappings` and
`instrument_mappings`, `economic_event_revisions`, and `reconciliation_proposals`
(rule and AI proposals, `method` `rule`/`manual`/`ai`) — are referenced by id
and revision in the same way and never copied.

**Conclusion.** Every log above stays the record of _what_ changed and is
reused by reference; none is copied. What none of them records, and what the
common record adds:

1. the **path** (`ui`, `agent-http`, `mcp`, `alarm`, `lane`): no table has one;
2. the **delegated principal and the delegation in force** (`delegationRef`);
3. **refusals and failures after authentication**: no table records a refused
   request; the request log is not durable;
4. one **correlation id** across the App and the Processor;
5. one **operation name and risk class** across paths;
6. a durable trace for operations whose own record is mutable or absent (lease
   release; schedule settings beyond the revision row);
7. **AI reads** (tool calls), as counts;
8. **prepare/confirm linkage** for two-step operations.

What must not be duplicated into it: decision content (subject, kind, reason,
evidence refs), plan payloads and simulations, operation stage progress, rule
contents and patterns, economic members and claims, lane tick counts, survey
page contents. The record holds their ids and revision numbers.

### 6.2 The record

CORE table `audit_records`, migration **0075 or later (candidate; fixed after
root coordination: CORE 0072 is the financial G3 migration, 0073/0074 are UI
candidates, 0067 is #564's; re-check latest main and every open PR before the
implementation PR)**. `STRICT`, classified `core-keep`, listed in
`REVISION_EXCLUDED_TABLES` (`packages/read-model/src/source-revision.ts`: an
audit write must not move the CORE source revision, or every MCP read would
invalidate the read models).

| Column                                      | Type and check                                                                                | Meaning                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `audit_id`                                  | TEXT PK, `aud_` + UUID                                                                        | the record                                                                                        |
| `recorded_at`                               | TEXT, canonical UTC `YYYY-MM-DDTHH:MM:SS.sssZ` (the `economic_commit_log.known_at` CHECK)     | time                                                                                              |
| `path`                                      | `ui` / `agent-http` / `mcp` / `alarm` / `lane`                                                | operation path                                                                                    |
| `subject`                                   | ACTOR_PATTERN, ≤ 256; NULL exactly when `path` is `alarm` or `lane`                           | the verified Access subject                                                                       |
| `principal`                                 | ACTOR_PATTERN-like, ≤ 256                                                                     | `<sub>`, `mcp-client:<sub>`, `alarm:<job id>`, `lane:<lane>`                                      |
| `principal_kind`                            | `human` / `agent` / `delegated` / `automatic` (the lifecycle's `human`, not `operator`)       | how it was graded                                                                                 |
| `delegation_ref`                            | `dlg_` + 64 hex; NOT NULL exactly when `principal_kind = 'delegated'`                         | the delegation entry in force                                                                     |
| `operation`                                 | `^[a-z][a-z0-9.-]{0,63}$`; the closed list is `OPERATION_CATALOGUE` in code                   | e.g. `schedules.maintenance.update`, `command.commit`                                             |
| `risk_class`                                | `R0`–`R4`                                                                                     | from the catalogue                                                                                |
| `step`                                      | `call` / `prepare` / `confirm`                                                                | two-step stage                                                                                    |
| `scope_namespace`, `scope_source`           | `core-source` / `schedule-source` and `^[a-z0-9-]{1,100}$`; both NULL or both set             | the source the target belongs to, for scoped reads                                                |
| `target_ref`                                | closed ref pattern, ≤ 300; NULL for a refusal before the target was resolved                  | `schedule:<id>`, `maintenance-rule:<id>`, `plan:<64 hex>`, `op_<64 hex>`, …                       |
| `result`                                    | `applied` / `accepted` / `prepared` / `read` / `replayed` / `refused` / `failed` / `overflow` | outcome (`overflow`: the daily aggregate of section 6.4)                                          |
| `result_code`                               | `^[a-z][a-z0-9_]{0,63}$`; NOT NULL for `refused` and `failed`                                 | the existing closed code (command, operations, schedule, agent API, delegation)                   |
| `reason_code`                               | closed per operation family (e.g. `MAINTENANCE_CHANGE_REASONS`), or NULL                      | why, as a code                                                                                    |
| `correlation_id`                            | UUID                                                                                          | the App's request id, forwarded to the Processor                                                  |
| `idempotency_key`                           | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` or NULL                                                 | the caller's key (`operationId` for a commit)                                                     |
| `payload_digest`                            | 64 hex or NULL                                                                                | canonical digest of the validated payload, never the payload                                      |
| `confirmation_digest`, `confirm_expires_at` | `cfm_` + 64 hex, canonical UTC; set exactly on `prepared` records                             | section 4.2                                                                                       |
| `confirms_audit_id`                         | FK `audit_records`; set exactly when `step = 'confirm'`                                       | the prepare it confirms                                                                           |
| `reverts_audit_id`                          | FK `audit_records` or NULL                                                                    | the operation this one rolls back                                                                 |
| `refs_json`                                 | JSON array, ≤ 16 strings, each a closed ref pattern                                           | ids in the existing logs: decision revision ids, `commit-seq:<epoch>:<n>`, `<rule>@<rev>`, `op_…` |
| `diff_json`                                 | JSON object, ≤ 2,048 bytes, one closed schema per `kind`                                      | the safe change diff                                                                              |

`diff_json` kinds (strict Zod schemas in `packages/application/src/audit/diff.ts`):
`revision` `{from, to, fields[]}` with closed field names; `decision`
`{decisionRevisions, commitSeq, counts}` with the simulation's counts;
`request` `{status}`; `read` `{rows, truncated}`; `lane` `{decisionRevisions,
proposals}` — only the sizes of the ranges its refs name (proposals by closed
proposal kind), never `processor_lane_ticks`' cost or progress counts;
`release` `{released}`; `overflow` `{of, count, cap}`; `none`.

Triggers, after 0029 and 0070: `audit_records_no_update`,
`audit_records_no_delete`, `audit_records_no_replace`. Indexes:
`(principal, recorded_at)`, `(scope_namespace, scope_source, recorded_at)`,
`(operation, recorded_at)`, `(target_ref)`, `(correlation_id)`; unique partial
`(confirms_audit_id) WHERE confirms_audit_id IS NOT NULL AND result IN
('applied','accepted')` and `(principal, operation, idempotency_key) WHERE
idempotency_key IS NOT NULL AND result IN ('applied','accepted')`.

### 6.3 One chokepoint, writers on every path

`packages/application/src/audit/` builds every record (`auditEnvelope`,
`auditStatement`, `auditRefusal`); `packages/application/src/operation-path/`
holds `OPERATION_CATALOGUE` (operation → capability, risk class, handler,
target and diff builders) and `executeOperation(ctx, operation, input)`, which
every adapter calls: the UI's operator routes, the HTTP agent routes and the
MCP dispatcher. `executeOperation` authorizes (grant or delegation,
capability, scope, class, confirmation), calls the **existing** service or
writer, and hands it the audit statement to append as the **last statement of
its own D1 batch**, so an `applied`/`accepted` record exists exactly when the
effect does. Writers that live in the Processor (commands, schedules) receive
the envelope over the private `PIPELINE` binding in closed headers
(`x-kogane-correlation-id`, `x-kogane-audit-path`, `x-kogane-delegation-ref`),
validated with the same schema, at the trust level the actor headers already
have; they call the same builder.

| Path         | Writer                                                                             | Records                                                                                                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui`         | operator routes under the browser audience: command, operations, schedule settings | every POST (W1–W13, H1–H7 sent from a browser session); UI GET page loads are not recorded                                                                                                                                                                                                    |
| `agent-http` | `/api/agent/v1/*` under the browser audience                                       | every tool call, reads included                                                                                                                                                                                                                                                               |
| `mcp`        | `/mcp` under the MCP audience                                                      | every tool call, reads included, delegated or not                                                                                                                                                                                                                                             |
| `alarm`      | `ScheduleAlarm` when it claims an occurrence of a `collection`-kind job            | one record per claimed collection occurrence (`alarm.occurrence.claim`); its outcome stays in the occurrence row. The `processor` tick and `keepalive` jobs write none                                                                                                                        |
| `lane`       | each Processor lane that writes decisions, proposals or settings                   | one record per tick that wrote any, carrying **refs only**: the decision-revision range, the commit-sequence range (`commit-seq:<epoch>:<from>-<to>`) when it committed economic events, and the proposals it wrote, by proposal kind; never `processor_lane_ticks`' counts. Idle ticks: none |

`ui` means "an operator route under the browser Access application": a script
using the operator's browser session is indistinguishable from a click and is
recorded as `ui`.

**One refusal writer.** For `ui`, `agent-http` and `mcp`, the App adapter
(`executeOperation` in `services/app`) is the only writer of `refused` and
`failed` records: it writes one after the Processor answers, carrying the
Processor's closed code, so a refusal the Processor makes is recorded once and
never by both Workers. The Worker that runs the writer writes the `applied`,
`accepted` and `prepared` records in its own batch (the Processor for commands
and schedule writes, the App for operations requests and proposals), and the
Processor writes the `failed` records of `alarm` and `lane`. If the Processor
applied an operation but its answer was lost, the store holds the Processor's
`applied` record and the App's `failed` record (`upstream_unavailable`) for
the same correlation id; the `applied` record is authoritative.

**What "in the writer's batch" requires.** A D1 batch rolls back only when a
statement raises; a guard that matches no row (`UPDATE … WHERE revision = ?`,
`INSERT OR IGNORE … SELECT … WHERE …`, as `updateSchedule` and the maintenance
writers use) leaves a committed batch with no effect. So the `applied` /
`accepted` statement is a plain `INSERT … SELECT … WHERE` joined to the
writer's own guard or to the row the effect wrote (the commit batch's
reservation, the new revision row at `revision + 1`, the released lease), never
`OR IGNORE` and never unconditional: a no-op guard then leaves no record, and
the adapter appends the `refused` record with the writer's code afterwards; a
unique-index violation raises and rolls the effect back. Writers that are not
one batch today become one in S1: `updateMaintenance` and #564's
`writeMaintenanceRevision` (the revision `INSERT` and the reference `UPDATE`
are separate calls), `decideSurveyProposal` (the accepted revision and the
decision row are separate writes today, and a failed decision row leaves the
revision standing) and `releaseCollectionLease` (one `UPDATE`). Alarm
reconciliation after a settings write stays outside the batch, as today.

### 6.4 Refusals and failures

After authentication, every refusal is recorded with its closed code:
authorization (`subject_not_granted`, `approval_required`,
`agent_api_not_configured`, `delegation_*`, `capability_not_delegated`,
`unauthorized`, `evidence_restricted`, `source_not_granted`), validation
(`invalid_request`, `invalid_query`), confirmation, stale and idempotency
codes, writer codes (`revision_conflict`, `maintenance_deferral_too_long`, …),
and `failed` with `internal_error` / `commit_failed` when the writer's batch
failed (then no effect and no `applied` record exist). The App adapter writes
these records (section 6.3). A refused value is
never echoed: the record holds the field path in `refs_json`
(`scope.source`), not the value (G3-08). A request refused before
authentication (401) has no subject and is not recorded; the Worker request
log keeps its line. Audit writing never changes the answer: if the refusal
record cannot be written, the refusal is still returned and the request log
carries `audit_write_failed`.

**Daily caps on the records that are not effects.** Per principal and UTC day,
code constants rather than grant fields: 200 `prepared`, 2,000 `read` and 500
`refused` records. `applied` and `accepted` records are never capped (writes
are bounded by `budget.writesPerDay`, and no write is applied without its
record).

- Past the `prepared` cap a prepare is refused (`audit_cap_reached`): an
  unrecorded prepare could not be confirmed anyway.
- Past the `read` cap reads are still served, and past the `refused` cap
  refusals are still answered, but neither is recorded one by one: each event
  increments a counter row in `audit_overflow_counters` (`principal`, `subject`,
  `path`, `day`, `result`, `count`; `operational-mutable`, in
  `REVISION_EXCLUDED_TABLES`, added by the same migration).
- The first Processor tick after the day ends appends **one aggregated
  record** per counter row — the counter's principal, subject and path,
  operation `audit.overflow`, `result = "overflow"`, `diff_json`
  `{of, count, cap}` — and deletes that counter row in the same batch, so each
  principal has at most one overflow record per capped result per day, and the
  count is exact.

### 6.5 Never recorded

Credentials, Access assertions, OAuth tokens, cookies, service-token ids,
OTPs, passkey or MFA material, session state, raw bank or provider bodies,
provider text (counterparties, descriptions, page text), amounts, account
numbers or labels, free-text reasons, request or response bodies, URLs,
SQL, exception text. Every column is an enum, a bounded pattern, a digest, a
count or a canonical time; there is no free-text column, and a test asserts
the schema admits none.

### 6.6 Reading the log

- **Operator:** `GET /api/v2/audit` (reader routes take query strings:
  `operation`, `path`, `principalKind`, `result`, `from`, `to`, `cursor`) and a
  `監査ログ` page (slice S8). Whole store.
- **AI:** `kogane.audit.search` / `kogane.audit.get` on `/mcp` and
  `POST /api/agent/v1/audit.search` / `audit.get`, graded by `audit.read` in
  `AGENT_API_GRANTS`:
  - a record is visible when its `scope_source` is in the grant
    (`scopes.sources` for `core-source`, `scopes.scheduleSources` for
    `schedule-source`); a record without a scope is visible only to a `"*"`
    source grant;
  - a grant listed on the account axis is refused `evidence_restricted`
    (`scope:account`) before anything is read, until per-account audit scope
    is proven;
  - `subject` is returned only when it equals the caller's own delegator;
    otherwise it is `subj_` + the first 16 hex of its SHA-256, and so is the
    subject inside `principal` (`<sub>`, `mcp-client:<sub>`), or the digest
    would be undone by the next column; `alarm:` and `lane:` principals are
    shown as they are;
  - the scope columns name one source, so a record whose target or read spans
    more than one source (a whole-store read, a card-settlement or relation
    decision joining a card and a bank source) is written with both scope
    columns NULL and is visible only to a `"*"` grant; otherwise a narrower
    reader would see a row count or a target that includes another source. A
    refused request stores only a server-resolved source in its scope columns,
    never the caller's value;
  - the filter is in the SQL `WHERE` before `LIMIT`; pages are 50 records;
    the cursor binds the grant's perimeter and the filters (a cursor from
    another perimeter is `stale_context`); no total over the unfiltered table
    is ever returned.

### 6.7 Retention and classification

`core-keep`, append-only, no pruning: the record is the history of who did
what, in the same family as the decision log (04 §2 "decisions and
relations"). Any pruning later needs its own ADR, because it would be an
exception to an append-only table.

Volume estimate, from `config/alarm-jobs.json` and the caps above:

- `alarm`: one record per enabled `collection`-kind occurrence, about 12 a day
  today. Recording every occurrence would add the `processor-tick` job (every
  5 minutes, 288 a day) and `sbi-vc-keepalive` (every 15 minutes, 96 a day):
  **about 400 records a day avoided** by recording collection occurrences
  only.
- `lane`: only ticks that wrote decisions, proposals or settings; at most one
  record per writing lane per tick (288 a day per lane in the worst case of a
  lane writing every tick), usually far fewer.
- `ui`: one per operator POST, a handful a day.
- `agent-http` and `mcp`: per principal and day, at most `budget.writesPerDay`
  (≤ 200) `applied`/`accepted`, 200 `prepared`, 2,000 `read` and 500 `refused`
  records, plus at most three `overflow` records.

After the first delegated stage the owner reads the row count with a
read-only aggregate query.

## 7. Out-of-scope leakage rule

Applies to every read tool, every audit read and every count inside a write's
preview:

1. **Scope before window.** Every count, window, page, `LIMIT`, `max`, digest
   input and cursor is computed after the scope predicate, inside the SQL
   `WHERE`; never `LIMIT` first and filter in TypeScript. The known instance is
   #565's P1: `OVERVIEW_FETCH_RUNS_SQL … LIMIT 501`
   (`packages/read-model/src/sql.ts`) is filtered by grant afterwards in
   `packages/application/src/query/execute.ts` (`coverage`), so a denied
   source's runs can lower an in-scope `collectionRunCount`.
2. **Per-source aggregation.** A listed grant is read source by source
   (`grantedSources`), and every figure is a sum of in-scope parts; no global
   total, gap count or "N more" leaves the perimeter.
3. **Same answer for absent and denied.** A denied id and a nonexistent id get
   the same code and the same refs; a refusal never echoes the value.
4. **Metadata is data.** Context manifests, publication and parser digests,
   `resultRef`, cursors and error refs are computed inside the scope (#565's
   `contextInputs`).
5. **Tests on the whole response.** For each tool: seed a denied source with
   more rows than any window in the path (at least 600, above `LIMIT 501`),
   then (a) deep-scan the complete JSON answer, errors included, for the denied
   source id, its account and source account ids and its row ids; (b) assert
   that every count, digest, `resultRef` and cursor of the scoped answer is
   identical before and after adding denied-source activity; (c) assert the
   refusal for a denied and a nonexistent target is byte-identical.
6. **Plan checks.** The scoped queries' plans lead with the scope column, shown
   by `EXPLAIN QUERY PLAN` without table statistics, as AGENTS.md requires of
   query rewrites.

## 8. Implementation slices, in dependency order

Each slice is one pull request with an independent fresh review (Opus or
Codex; the initial implementation is not handed to Cursor), and each states in
its body what the review checked.

Order and what is independent now: **S1 can start now** and needs nothing
else; **S2 is in progress** separately; S3 needs S1 and S2 merged; S4 and S6
need S3; S5 needs S2 (and S1 for its read records); S7 and S8 need S1.

**S1 — audit log for the existing paths** (can start now).

- What: `audit_records`, the builder (`packages/application/src/audit/`), the
  `OPERATION_CATALOGUE` skeleton and `executeOperation` for the existing
  paths: the command, operations and schedule routes (`ui`); the agent tool
  dispatcher `callTool`, which both `/api/agent/v1/*` and `/mcp` call
  (`agent-http`, `mcp`), coordinated with #565 at `agent-api.ts` (whichever
  merges second rebases); `GET /api/v2/audit` for the operator. No delegation.
- ADR: 0064. Migration: `audit_records`, 0075 or later (candidate; see
  section 6.2).
- Also in S1: `audit_overflow_counters` and the daily caps with their
  aggregation step in the Processor tick (section 6.4); the App adapter as the
  only refusal writer (section 6.3).
- Tests: migration guards (no update, delete or replace; the CHECK constraints
  refuse free text; both unique partial indexes); ledger regenerated, the
  table classified `core-keep` and the counter table `operational-mutable`;
  the `lanes.test.ts` migration pin; a Processor refusal recorded exactly once
  (by the App), and a lost Processor answer leaving the `applied` and the
  App's `failed` record; delegation matrix item 13 (caps and overflow);
  `REVISION_EXCLUDED_TABLES`; per route, a success record in the same batch as
  the effect (a failing guard leaves neither, and a guard that matches no row
  leaves no `applied` record, only the adapter's `refused` one), refusal and
  replay records, no echo of a refused value (G3-08); a deep scan of the stored
  records after seeding provider text with a token-shaped string and an amount.
- Review gate: fresh Opus or Codex reviewer; the review checks the batch
  atomicity on every wired writer and the never-recorded list.

**S2 — #565's P1/P2 fixes, then #565 merges** (in progress).

- What, on #565's branch (both are still open at its head `9c25877`):
  - **P1 — scope before the window.** The `coverage` intent counts
    `collectionRunCount` from `OVERVIEW_FETCH_RUNS_SQL`
    (`packages/read-model/src/sql.ts`): the store's newest 501 fetch runs
    (`ORDER BY id DESC LIMIT 501`, `PAGE_LIMIT`), filtered by the grant only
    afterwards, in TypeScript (`packages/application/src/query/execute.ts`).
    Runs of a denied source therefore push in-scope runs out of the window, so
    an in-scope count, and whether the answer reads as complete, change with
    activity the caller may not see. Fix: the scope predicate goes into the
    SQL `WHERE`, per granted source, before the `LIMIT` (section 7, rules 1 and
    2).
  - **P2 — the grant's principal is the verified key.** `parseGrants`
    (`packages/application/src/grants.ts`, line 162) builds each grant as
    `{ principal, ...body }`, so a configuration entry whose body carries its
    own `principal` key overrides the verified map key: the grant then names a
    principal other than the one it was looked up by (the server-derived actor
    contract is broken), and the malformed entry is accepted, because
    `validGrant` checks the merged object, which has exactly the expected
    keys. Fix, fail closed: an entry body with a `principal` key or any key
    outside `scopes`, `capabilities` and `budget` makes the table unreadable
    (empty, as for any invalid entry), and the grant is built from the verified
    key alone. `MCP_DELEGATIONS` follows the same rule (section 3.2).
- ADR: 0047 (#565). Migration: none.
- Tests: #565's matrix 1–9 plus section 7's differential test on `coverage`
  (at least 600 denied-source runs newer than the in-scope ones: the scoped
  count and completeness are identical before and after); for P2, an entry
  body naming another principal, naming its own key, and carrying an unknown
  key — each leaves the table empty.
- Review gate: #565's own independent review.

**S3 — delegation** (after S1 and S2).

S3 is split into **declaration core** and **execution integration**. The
core can be reviewed independently of unmerged S1 (#619): strict configuration
validation, role bundles, owner/read-grant scope attenuation, expiry,
canonical delegation reference, and a safe MCP capabilities status. It adds
only the empty `MCP_DELEGATIONS` variable. It connects no writer, adds no tool,
changes no read grant, and does not complete S3 or owner-equivalent delegation.
Even a valid declaration reports `available: false`; closed reasons distinguish
missing audit, operation path, Processor guards and confirmation. Inactive
reports disclose no other entry, identity, scope, expiry, budget or digest.
Existing legal read/proposal capabilities and browser/UI authority are unchanged.

**Required follow-up after #619 merges:** connect the resolver to S1's existing
`OPERATION_CATALOGUE`/`executeOperation` and common audit builders; add the
delegated principal kind and validated Processor family/ref forwarding;
prepare/confirm with atomic single-use audit/idempotency and budget checks;
scope-before-write guards and per-operation risk gates; then publish only the
actually executable delegated operations. Reconcile #564's schedule scope and
single maintenance writer as S4. Do not copy either unmerged implementation.
Until this integration is independently reviewed and ships, no delegated
operation is executable and the S3 matrix remains incomplete.
The parallel #546 instrument-resolution history service/read route also needs
a later S3/S6 agent/MCP parity adapter through this common audited path; the
declaration core does not expose or duplicate that history reader.

- What: `MCP_DELEGATIONS` (added as `""` in a reviewed configuration change),
  its parser and resolver (`packages/application/src/delegation/`), the roles,
  `PRINCIPAL_KINDS` gaining `delegated`, the Processor's `principalOf`, the
  risk classes in `OPERATION_CATALOGUE`, the prepare/confirm module, and
  `kogane.capabilities` reporting the delegation in force.
- ADR: 0063. Migration: none (S1's table).
- Tests: the delegation matrix below, items 1–10, 12 and 13, on a synthetic
  catalogue operation per risk class.
- Review gate: fresh Opus or Codex reviewer; the review re-runs #565's matrix
  1–9 to show the attenuation still holds.

**S4 — #564 re-shaped** (after S3; a rebase can be prepared now). Once the
AGENTS.md rule of section 9 is in force, #564 in its current form — an
`AGENT_API_GRANTS` capability that changes a setting without a delegation —
contradicts it, so #564 lands as this slice, not before it.

- What: section 4.6 — the capability moved to the delegation, closed
  `MAINTENANCE_CHANGE_REASONS`, the direct envelope, audit. Beyond the 7-day
  bound the tool refuses (R3) until question 1 is answered; an R2 path up to
  the 31-day ceiling is added only after that answer, in its own pull request.
- ADR: 0046, amended by 0063. Migration: #564's own CORE 0067, rewritten
  before merge: the `actor_kind` CHECK (`operator`, `delegated`), the closed
  `change_reason` CHECK, and the partial index `maintenance_agent_writes`
  (`WHERE actor_kind='delegated'` instead of `'agent'`).
- Tests: #564's suites, plus: free text refused by the CHECK; inside the
  envelope direct; beyond the 7-day bound refused with
  `maintenance_deferral_too_long` and nothing written; the budget check's
  query plan uses the rewritten partial index (no table statistics); a spent
  budget, an unregistered host and an out-of-scope source never escalate; one
  audit record per call.
- Review gate: fresh reviewer; the review checks that the writer is still the
  only path to a maintenance revision.
- Status (2026-10-09): implemented on #564 ahead of S3's execution
  integration, up to the delegation gate
  ([ADR 0046's amendment](../adr/0046-agent-maintenance-windows.md#amendment-a-delegated-operation-not-an-agent-grant-2026-10-09)).
  The migration is CORE 0076 (taken after main's 0075; #632 then took
  0077, and no file uses 0073 or 0074). The write capability is in `MCP_DELEGATIONS` only; the update
  tool resolves the delegation with #628's core, checks capability, closed
  arguments and scope, and is refused by `delegationExecutionReadiness`
  (`available: false`), so it relays nothing and is published to nobody; the
  read is served on both agent paths with one function. The writer takes
  `append` and the operator's edit records `operator-edit`. The writer's
  contract for S3 (owner-approved): a delegated revision must carry
  `delegated-audit:<audit_id>` as its decision reference;
  `prepareMaintenanceRevision` and `currentMaintenanceRevision` reuse the
  write's validation and current-revision read without writing; a trusted
  `deferralBound` option (`"delegated-7d"` default, `"confirmed-31d"` up to 31
  days) that no request sets and nothing passes yet
  ([schedules](../schedules.md#the-writers-contract-for-delegated-execution-plan-slice-s3)).
  Left to S3: the delegated audit record (`principal_kind` `delegated`,
  `delegation_ref`) and the reservation of its id, Processor family/ref
  forwarding, `budget.writesPerDay` at the App chokepoint, and the confirm
  that may pass `"confirmed-31d"`, and therefore the R2 path; the
  missing-capability code is #628's `delegation_capability_denied` (section
  8's matrix item 4 calls it `capability_not_delegated`).

**S5 — MCP read, search and detail** (after S2).

- What: D2–D19, each whole-store only first; a scoped version per tool, one
  per pull request, under section 7.
- ADR: 0063 (a new ADR only if a scoped version decides more). Migration:
  none.
- Tests: per tool, the UI route, the HTTP agent route and MCP deep-equal; a
  listed grant refused before any read; section 7's tests for each scoped
  version.
- Review gate: fresh reviewer; the review runs the leakage tests itself.

**S6 — command, schedule and operations tools** (after S3; W3 after S4).

- What: W1–W5, W7–W13 and H1–H7 through `executeOperation`; the operations
  tools published on `/mcp` again only to a delegated principal holding the
  capability.
- ADR: 0063. Migration: none.
- Tests: the delegation matrix items 4–13 per tool; the UI and MCP produce one
  stored effect for one request; every reader and page that presents a
  decision's `method` (found by searching `packages/read-model`,
  `packages/application` and `apps/web` for it, and listed in the pull
  request) shows a `manual` decision whose actor starts with `mcp-client:` as
  delegated, never as the owner's own.
- Review gate: fresh reviewer; the review checks that no tool carries its own
  validation or SQL.

**S7 — `alarm` and `lane` writers** (after S1).

- What: one record per claimed `collection`-kind occurrence; one per lane
  tick that wrote decisions, proposals or settings, carrying refs only.
- ADR: 0064. Migration: none.
- Tests: `processor` and `keepalive` occurrences and idle ticks write nothing;
  a lane record's refs name exactly the decision revisions, commit sequence
  and proposals the tick wrote, and it holds none of `processor_lane_ticks`'
  counts.
- Review gate: fresh reviewer.

**S8 — `監査ログ` page and delegation status** (after S1; status after S3).

- What: the audit page, and the delegation in force shown on the schedules and
  confirm pages.
- ADR: 0064. Migration: none.
- Tests: browser tests, desktop and mobile.
- Review gate: fresh reviewer.

**Delegation test matrix (S3, S6)**, modelled on #565's:

1. An `mcp-client` with no delegation: every delegated tool unpublished and,
   when called, `delegation_not_configured`; only the refusal record is written.
2. Invalid entries — bare-subject key, another person's `mcp-client:` name,
   delegator not an operator, validity longer than 90 days, unknown role or
   capability, scope outside the `AGENT_API_GRANTS` entry, more than 8 entries
   — make the table `503 delegation_misconfigured` for every delegated call;
   an entry before `issuedAt` or after `notAfter` is inert
   (`delegation_not_yet_valid`, `delegation_expired`) while reads continue.
3. A browser-audience token, both audiences, the HTTP agent route and the bare
   subject never resolve a delegation; `principalFor` still refuses
   `mcp-client:`; a delegated principal is refused on every browser operator
   route.
4. Each tool refused without its capability (`capability_not_delegated`),
   served with it; R3 and R4 have no tool, and the Processor refuses a
   forwarded family the App did not grant.
5. Out-of-scope and nonexistent targets get byte-identical refusals with no
   echo. Write scope: an entry holding a `commands.*` capability or
   `operations.projection.request` with a listed `sources` or `accounts`
   axis makes the table `503 delegation_misconfigured`; a collection, import,
   replay or session-refresh request for a source outside `scopes.sources` is
   refused like an unknown source and stores no `ops_requests` row; a maintenance,
   job or survey write outside `scopes.scheduleSources` is refused likewise.
6. R1: stale expected revision writes nothing; same key and payload is
   `replayed`; same key, other payload is `idempotency_conflict`; the write
   after `budget.writesPerDay` applied records is `delegation_budget_exceeded`
   and writes nothing but its refusal record.
7. R2: a prepare whose `expectedRevision` differs from the target's current
   revision is refused `revision_conflict` and records no `prepared` record;
   confirm without prepare, with another principal's or delegation's prepare,
   with a changed payload, after expiry, twice, and two raced confirms — each
   refused, the effect applied at most once; a target moved between prepare
   and confirm is refused with the writer's code. H2 and H6 prepare without a
   revision, and a repeat under the same key is the same `op_` operation.
8. Every call below the caps of item 13 writes exactly one record with closed
   fields (a lost Processor answer adds the App's `failed` record under the
   same correlation id, section 6.3); a writer failure
   leaves no effect and no `applied` record; deep scan of `audit_records`
   after seeding provider text containing a token-shaped string and an amount.
9. Revocation, each of the five ways: the next call is refused; earlier
   records remain.
10. INV07: a heuristic or AI proposal is not adopted without a decision; a
    delegated commit writes `method = 'manual'`, `actor_id = mcp-client:<sub>`
    and an audit record with `path = 'mcp'`, `principal_kind = 'delegated'`;
    every reader and page that presents `method` shows that decision as
    delegated, derived from the `mcp-client:` actor prefix.
11. HTTP and MCP return the same object; the UI and MCP produce one stored
    effect for one request.
12. The undelegated read-only connection (#565 matrix 1–9) is unchanged.
13. Record caps: the 201st prepare of a principal's day is refused
    `audit_cap_reached`; the 2,001st read is served and the 501st refusal is
    answered, but neither writes its own record; the next day's first tick
    writes exactly one `overflow` record per capped result with the exact
    count and removes the counter row; a second tick writes none; `applied`
    records are never capped.

## 9. AGENTS.md amendment

This pull request makes the edit below in [`AGENTS.md`](../../AGENTS.md),
marked effective when ADRs 0063 and 0064 merge; until slice S3 ships no
delegation can exist, and the amended text says so.

```diff
-- Agents never approve or commit a change
-  ([change lifecycle](docs/change-lifecycle.md#grants),
-  [agent API](docs/agent-api.md#card-purchase-explanation)).
+- Heuristics, rule proposal passes and AI proposals only propose (INV07
+  above), and an agent without an explicit delegation only reads and
+  proposes: it never approves, commits or changes a setting
+  ([change lifecycle](docs/change-lifecycle.md#grants),
+  [agent API](docs/agent-api.md#card-purchase-explanation)). Besides the
+  human operator, only a principal that Cloudflare Access verified on the
+  dedicated MCP application, and that the owner delegated by name, may apply
+  an operation: within its delegated capabilities, scope and expiry, under
+  the operation's confirmation class, through the common command layer, and
+  with an audit record. Grants, Access, delegations, secrets and deployment
+  are never delegated
+  ([ADR 0063](docs/adr/0063-delegated-ai-operation-path.md),
+  [ADR 0064](docs/adr/0064-common-audit-log.md)). Effective when those ADRs
+  merge; until the delegation resolver ships (slice S3 of the
+  [plan](docs/plans/2026-10-ai-operation-path.md)) no delegation exists,
+  so in practice no agent approves, commits or changes a setting.
```

## 10. Questions for the owner

Only what a design cannot settle. Merging this pull request answers none of
questions 1–3, grants nothing and enables nothing: no Access application or
policy, grant, `MCP_DELEGATIONS` entry, session length, authentication or
production change.

1. **The stage at which the R2 target applies.** Following your direction
   (「基本的に人間ができることはすべてAIができてほしい。AI経由で使うのがメインになる予定なので」),
   R2 — the AI confirms its own prepared operation, bound by digest, revision
   and idempotency key — is the stated target class for financial adoption
   (card-settlement decisions, link and ownership decisions, identity
   assignment), provider contact (collection requests, session refreshes) and
   maintenance deferral beyond the 7-day bound (up to the 31-day
   joined-deferral ceiling, which stays, and never beyond; section 4.6). That
   target is not in question. The only judgment left to you is the stage
   boundary: do these classes become R2 in the first delegated stage, or only
   after earlier stages' audit records exist and you have read them? Until you
   answer, the conservative default stays as written: R3 — the tool refuses a
   deferral beyond 7 days (section 4.6), no delegation entry is proposed with
   a financial-adoption or provider-contact capability (section 3.5), and you
   perform these operations in the UI.
2. **Device posture for write delegation.** The MCP Access application
   cannot carry the browser application's device posture (the clients call
   from their own clouds; ADR 0047). With writes delegated, the compensating
   controls are the delegation's expiry (at most 90 days), the Access session
   and token lifetime you set on the MCP application, two-step confirmation
   and the audit log. A delegation also covers **every MCP client you sign in
   with** (claude.ai, ChatGPT, Codex, Claude Code), not one specific AI: they
   are all `mcp-client:<sub>`, and neither the server nor the audit record can
   tell them apart (section 3.2). Is that acceptable, and which session length
   do you want on the MCP application?
3. **The first delegation entry.** After the read-only connection test, which
   role, sources and expiry should the first `MCP_DELEGATIONS` entry carry?
   The proposal is `maintainer` on one schedule source for 30 days.

## 11. What this plan does not do

It writes no code, migration, grant, delegation, Access setting, policy,
secret or Wrangler value. It does not merge, re-number or edit #564 or #565;
those PRs carry their own changes, and S2 and S4 say what is asked of them.
