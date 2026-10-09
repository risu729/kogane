# ADR 0063: The AI is a delegated operation path: a verified MCP principal the owner names may apply operations within capability, scope, confirmation and audit

- Status: proposed (accepted when its pull request merges). Nothing it decides
  is implemented; the slices are in the
  [plan](../plans/2026-10-ai-operation-path.md#8-implementation-slices-in-dependency-order).
- Date: 2026-10-09
- Amends: [ADR 0013](0013-agent-card-purchase-read.md) (the read-only
  premise), [ADR 0039](0039-alarm-schedule-management.md) ("agents and service
  tokens cannot edit settings"), ADR 0046 (#564, open: its framing of the agent
  maintenance write), ADR 0047 (#565, open: the agent-only attenuation where it
  makes MCP read and propose only), and the AGENTS.md rule "Agents never
  approve or commit a change".
- Depends on: ADR 0047 (#565) for authentication and the `mcp-client:<sub>`
  principal; [ADR 0064](0064-common-audit-log.md) for the audit record.

## Context

On 2026-10-09 the owner changed the requirements:
「条件を限定してAIが直接反映できるようにする」 (let the AI apply changes
directly, under limited conditions) and
「基本的に人間ができることはすべてAIができてほしい。AI経由で使うのがメインになる予定なので」
(the AI should be able to do basically everything a human can, because using
the system through the AI will be the main way). The owner added that #564's
maintenance tools are no longer "proposal required", that an authenticated
owner can explicitly delegate the web UI's permissions to the AI as an
operation path, that excluding confirm, reject, accept, commit and settings
operations merely because the path is AI is to be re-examined, and that this
is neither full power for an anonymous agent nor permission to change grants
or Access now.

What the code does today (`origin/main` `c4f611d`, and the two open PRs):

- Three allow-lists grade a verified Access subject. `OPERATOR_SUBJECTS` is the
  human operator, the only principal that approves, commits, requests
  operations and edits settings. `AGENT_GRANTS` makes a subject a
  change-lifecycle agent that may plan and simulate and is refused approve and
  commit (`approval_required`). `AGENT_API_GRANTS` says what an agent may read
  and whether it may propose; its vocabulary has no acceptance, by
  construction ([agent API](../agent-api.md#grants)).
- ADR 0013 gives agents card purchases through a read-only tool that strips
  `actions` and `relation` and answers `decisions: "operator-only"`.
- ADR 0039: "Agents and service tokens cannot edit settings."
- ADR 0046 (#564) adds `schedules.read` and `schedules.maintenance.update` to
  the agent-API vocabulary and adopts an agent maintenance revision when it is
  saved, bounded by a 7-day joined deferral and 30 revisions per principal per
  day, with a free-text reason.
- ADR 0047 (#565) authenticates MCP clients through a dedicated Access
  application with Managed OAuth, accepts only its audience on `/mcp`, and
  turns whoever signs in, the operator included, into the agent-only
  `mcp-client:<sub>` whose grant is only that name's `AGENT_API_GRANTS` entry;
  operations tools are no longer served on `/mcp`.
- The change lifecycle knows two principal kinds, `human` and `agent`
  (`PRINCIPAL_KINDS`; the Processor's `principalOf` accepts only those).
- The owner confirmed read-only on 2026-10-09: a dedicated Access application
  on the `/mcp` path with Managed OAuth can connect while the UI keeps its
  Gateway gate; an MCP Portal is likely unnecessary; today there is no Managed
  OAuth, no MCP audience and no grant; nothing is configured before a concrete
  approval; the read-only connection test is the first stage, not the final
  limit.

The invariants that bound the answer: authentication stays Cloudflare Access
(no custom authentication); default deny; scope; revocation; concrete
confirmation for important operations; idempotency; stale checks; rollback as
a new revision; INV07 (heuristics only propose); one implementation per
command; no bare-`sub` fallback and no audience confusion (the defect ADR 0047
removed: an MCP caller re-graded as the operator).

## Options considered

1. **Keep MCP read and propose only; the AI prepares and the owner confirms
   everything in the UI.** The status quo. Rejected: it is what the owner
   changed.
2. **Grade an MCP caller as the operator when its subject is in
   `OPERATOR_SUBJECTS`.** Rejected: it is the bare-`sub` fallback ADR 0047
   removed; the AI would hold every operator power with no scope, expiry,
   per-operation confirmation or audit, and the browser and MCP audiences
   would again mean the same thing.
3. **Add operator capabilities to `AGENT_API_GRANTS`.** Rejected: that table
   cannot name an acceptance by construction (a tested invariant), it has no
   delegator and no expiry, and any principal listed in it — not only the
   owner's own MCP identity — could then be given decisions.
4. **Store delegations in D1, editable from the UI.** Rejected for now: a
   delegation would become an in-application operation, and changing authority
   is exactly what is not delegable (R4). A configuration entry the owner
   writes through a reviewed change keeps authority outside the application.
5. **A separate owner-declared delegation table keyed by the attenuated MCP
   principal, naming its operator delegator, with closed capabilities, scope,
   expiry and a per-operation risk class, executed through the existing
   services, with a common audit record.** Chosen.

For how a delegated decision is recorded in `decision_revisions.method`:

- `ai`: rejected. `active_manual_overrides` (CORE 0029) protects only `manual`
  and `legacy-migration` assignments from automatic identity policy, so an
  `ai` assignment the owner delegated would be silently overwritten by the next
  rule pass; and `ai` already means a proposal or a heuristic.
- A new method value: rejected. It needs a rebuild of an append-only table and
  of the views that read it, for information the actor and the audit record
  already carry.
- `manual`, with `actor_id = mcp-client:<sub>` and the audit record's
  `path = mcp`, `principal_kind = delegated`: chosen. `method` says how the
  judgement was reached (a reviewed command, not a rule); who and through which
  path is said by the actor and the audit record. The discriminator in the
  decision log itself is `actor_id`'s `mcp-client:` prefix, which no human
  actor can carry (`principalFor` and `browserCaller` refuse that namespace,
  ADR 0047); a reader that presents `method` to the owner shows a decision by
  such an actor as delegated, not as the owner's own.

For the confirmation of settings and operations writes, which have no plan:

- a client-side confirmation dialog: rejected, it is not a server control
  ([agent API](../agent-api.md#why-the-application-service-exists));
- a signed (HMAC) confirmation token: rejected, it needs a new secret;
- a stored prepare record that the confirm must cite by digest, single use by a
  unique index in the same batch as the effect: chosen (it is an audit record,
  ADR 0064).

## Decision

**1. Authentication is unchanged.** ADR 0047's dedicated MCP Access
application, audience separation and `AgentCaller` stand. This ADR adds no
authentication, token or key.

**2. A delegated principal exists only by the owner's declaration.** A new
App variable `MCP_DELEGATIONS` (a JSON object; shipped `""`, meaning none)
maps `mcp-client:<sub>` to `{delegatedBy, role, capabilities?, scopes,
issuedAt, notAfter, budget}`. An entry is valid only if its key is
`mcp-client:` + `delegatedBy`, `delegatedBy` is in `OPERATOR_SUBJECTS` (the
owner delegates only to their own MCP identity), the role and capabilities
are in the closed vocabulary, every scope axis is inside the same principal's
`AGENT_API_GRANTS` entry, `notAfter - issuedAt` is at most 90 days and
`budget.writesPerDay` is 1–200; at most 8 entries. One invalid entry makes the
table `delegation_misconfigured` (503 for every delegated operation). Outside
`[issuedAt, notAfter)` the entry is inert. `resolveDelegation(env, caller)`
resolves only from an `AgentCaller` of kind `mcp-client` and answers a
`DelegatedPrincipal` with `delegationRef` = `dlg_` + the canonical digest of
the entry.

**3. Never through another door.** A browser-audience token, the HTTP agent
route `/api/agent/v1/*` and the bare subject never yield a delegation.
`principalFor` keeps refusing any `mcp-client:` string. A delegated principal
never reaches the browser operator routes (`/api/command/v1/*`,
`/api/ops/v1/*`, the schedule settings routes). `AGENT_GRANTS` is not
consulted. `PRINCIPAL_KINDS` gains `delegated`; the App forwards
`x-kogane-actor-kind: delegated`, the principal, the delegated command
families and the `delegationRef` to the Processor, which refuses a family it
was not forwarded.

**4. Closed capabilities and roles.** Read capabilities stay in
`AGENT_API_GRANTS` (gaining `reviews.read` and `audit.read` beside #564's
`schedules.read`). Operation capabilities exist only in `MCP_DELEGATIONS`:
`commands.plan`, `commands.decide.card-settlement`,
`commands.decide.relation`, `commands.decide.identity`,
`schedules.maintenance.update` (moved from #564's agent-API vocabulary),
`schedules.survey.decide`, `schedules.job.update`,
`operations.import.request`, `operations.replay.request`,
`operations.projection.request`, `operations.collection.request`,
`operations.session.refresh`, `operations.read`. Roles are closed bundles:
`maintainer`, `reviewer`, `operator-delegate` (the plan, section 3.3, lists
them). Nothing in the vocabulary names an R3 or R4 operation. **Write scope:**
an entry holding any `commands.*` capability or
`operations.projection.request` is valid only with `"*"` on both `sources` and
`accounts`, because plan targets and a projection rebuild span sources and
accounts and no per-target scope check is proven yet; the source-bound
operations requests (collection, import, replay, session refresh) check the
requested source against `scopes.sources` before anything is stored, and
schedule writes check `scopes.scheduleSources`. Narrower command scopes come
with per-target checks in their own pull request.

**5. Every operation has a risk class, and the class decides the
confirmation.**

| Class | Meaning                                                                                                                                            | Delegated                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| R0    | read                                                                                                                                               | allowed, no confirmation                                                |
| R1    | bounded, reversible by a further operation, no adopted financial state, no provider contact                                                        | direct: one call with an idempotency key and the expected revision      |
| R2    | changes adopted state or a collection schedule, or contacts a provider                                                                             | two-step: prepare → confirmation digest → confirm with the same payload |
| R3    | needs a runtime judgement the server cannot verify, with no reverting operation; or held for the owner's decision (deferral beyond 7 days, item 8) | not delegable now; the operator in the UI                               |
| R4    | authority, secrets, deployment                                                                                                                     | never; no tool and no route                                             |

The assignment of every operation is the plan's mapping (section 5): plans,
proposals, imports, replays, projection rebuilds, survey rejections and
maintenance revisions inside the direct envelope are R1; job edits, survey
acceptances, card-settlement, relation and identity decisions, collection
requests and session refreshes are R2, the target class the owner's direction
sets (「基本的に人間ができることはすべてAIができてほしい、AI経由がメイン」); the
plan's question 1 asks only at which stage financial adoption, provider
contact and long deferrals become delegable at R2, and until the owner answers
they stay R3 (no delegation entry is proposed with those capabilities;
deferrals as item 8 states). Stopped-execution lease release, and maintenance
deferrals beyond the 7-day bound until the owner answers that question (item
8), are R3; grants, Access, delegations, secrets, service tokens,
deployment, migrations, feature flags, collector dispatch connections, session
refresh policy, maintenance-survey page enablement, schedule bootstrap,
`economic-event.resolve-identity` and identity-epoch rewrites are R4.

**6. Two-step confirmation.** For change-lifecycle commands the lifecycle is
the confirmation, unchanged: the plan id is its digest, approve must present
it and re-checks every expected revision, commit presents the approval and an
`operationId` and verifies the revisions inside its batch. For settings and
operations writes, `step: "prepare"` takes the caller's expected revision,
refuses `revision_conflict` when the target has moved, and answers a preview
and `cfm_` + `canonicalDigest({v: "kogane-confirm-v1", operation, principal,
delegationRef, targetRef, expectedRevision, payloadDigest, idempotencyKey,
expiresAt})`, valid at most 10 minutes, and records it (ADR 0064, `prepared`);
`step: "confirm"` resends the identical payload, key and digest, and the
`applied` record that cites the prepare is the last statement of the writer's
batch under a unique index, so a confirm applies at most once. The digest is
not a bearer credential: it only binds a confirm to a prepare the server
recorded. A collection or session-refresh request targets a source, which has
no revision: its prepare checks scope, policy and connection, and a repeat
under the same key is the same operation.

**7. Stale checks, idempotency, rollback.** Every versioned write carries the
expected revision, and the writer's compare-and-set inside its batch decides.
Every delegated write carries an idempotency key; writers that have their own
(operations requests, commit receipts) keep it, the others get it from the
audit table's unique index (`replayed` for the same payload,
`idempotency_conflict` for another). A rollback is a further operation —
another revision, `card-settlement.withdraw`, `relation.reject` of an accepted
relation, `identity.release-override` — recorded with `reverts_audit_id`.
Provider contact cannot be rolled back, which is why it is R2.

**8. #564 is re-shaped, not replaced.** Its one writer and bounds stay. The
write capability moves to `MCP_DELEGATIONS`; the actor kinds become `operator`
and `delegated`; the free-text reason becomes a closed code
(`MAINTENANCE_CHANGE_REASONS`, enforced by #564's own unmerged CORE 0067
CHECK, following #575's closed-reason pattern); a revision is R1 inside the
direct envelope (granted source, rule of that source or new, no new joined
deferral over 7 days, budget unspent, closed reason, registered https host,
expected revision). Beyond the 7-day bound the target is R2 up to a hard
ceiling of a 31-day joined deferral; the plan's question 1 asks only whether
that applies from the first delegated stage or after earlier audit records
exist and have been read. Until the owner answers, it is **R3**: the tool
refuses it (`maintenance_deferral_too_long`) and the operator makes it in the
UI. A deferral longer than 31 days stays the operator's in every case. A spent
budget, an unregistered host or an out-of-scope source never escalates.
Rewriting 0067's CHECK also rewrites its partial index
`maintenance_agent_writes` to `actor_kind='delegated'`.

**9. One implementation per command.** `OPERATION_CATALOGUE` and
`executeOperation` in `packages/application/src/operation-path/` are the only
entry for the UI's operator routes, the HTTP agent routes and the MCP
dispatcher; they authorize and then call the existing service or writer
(`createPlan`/`approve`/`commit`, `requestCollection` and the other operations
services, `updateSchedule`, `writeMaintenanceRevision`,
`decideSurveyProposal`). No tool carries validation or SQL of its own.

**10. Reads.** Each new read tool calls the route's own reader and is
whole-store only (a listed source or account grant is refused before any read)
until a scoped version is proven under the plan's leakage rule (section 7):
scope before any window, per-source aggregation, identical answers for denied
and absent, metadata inside the scope, whole-response negative tests. ADR
0013's stripping of `actions` and `relation` stays for every caller without
`commands.decide.relation`; a delegated holder of that capability receives
them, because it may decide.

**11. Revocation.** Remove the entry or empty `MCP_DELEGATIONS`; let
`notAfter` pass; remove the delegator from `OPERATOR_SUBJECTS`; remove the
`AGENT_API_GRANTS` entry; remove the person from the MCP Access application's
policy or unset `ACCESS_MCP_AUDIENCE`. Each takes effect on the next request;
nothing applied is deleted.

**12. INV07 and the agent rule.** INV07 is unchanged: heuristics, rule
proposal passes and AI proposals only propose. The rule "agents never approve
or commit a change" becomes: an agent without an explicit delegation only
reads and proposes; a delegated principal may apply operations within its
capabilities, scope, expiry and class, through the common command layer, with
an audit record; R4 is never delegated. A delegated decision is recorded with
`method = 'manual'`, `actor_id = mcp-client:<sub>`.

**What changes in the amended records.**

- ADR 0013: `decisions: "operator-only"` and the stripped `actions`/`relation`
  remain the answer for every caller without `commands.decide.relation`.
- ADR 0039: settings are edited by the operator or by a delegated principal
  holding the setting's capability; service tokens still edit nothing.
- ADR 0046 (#564): "Adopted when saved, not proposed" stands inside the
  direct envelope, under a delegation instead of an agent-API grant, with a
  closed reason; its statement that the path "is not an exception to the agent
  invariants" is replaced by item 12.
- ADR 0047 (#565): the attenuation stands; what an `mcp-client` may do beyond
  its `AGENT_API_GRANTS` entry is now decided by its delegation. `principalFor`
  stops being the only gate in front of the command and operations writers:
  `resolveDelegation` is a second one, which can only ever yield a `delegated`
  principal with the entry's capabilities, never the operator. Operations
  tools are published on `/mcp` again only to a delegated principal holding the
  capability.

## Consequences

- With `MCP_DELEGATIONS` empty — its shipped value — nothing changes: every
  MCP caller is the agent-only principal of ADR 0047.
- The owner's own MCP identity is the only principal that can ever be
  delegated decisions, and it is a different principal from the owner's
  browser session: an approval it records says `mcp-client:<sub>`, and the audit
  record says `path = mcp`.
- A delegation that would see more than its read grant is a configuration
  error, not a widening.
- An R2 operation costs the client two calls; an R1 operation one. The
  confirmation does not prove that a person looked at the preview; it proves
  the confirm is the prepared operation, at the prepared revision, once.
- Delegated command reasons remain the free text the command payload already
  requires (`decision_revisions.reason`, as for the operator); the audit record
  never copies them.
- Two concurrent writes can exceed `budget.writesPerDay` by the number in
  flight: the count is read before execution.
- **Trade-off of `method = 'manual'`.** No migration is needed, and delegated
  identity assignments keep the protection `active_manual_overrides` gives
  manual ones. The price: `method` alone no longer separates the owner's own
  decision from a delegated one. Every reader and page that presents `method`
  must derive "delegated" from the `mcp-client:` actor prefix, and the
  implementation slice tests each of them; a reader that does not would show
  a delegated decision as the owner's own.
- A delegation covers every MCP client the owner signs in with (claude.ai,
  ChatGPT, Codex, Claude Code), because ADR 0047 makes them all the same
  `mcp-client:<sub>`; neither the server nor the audit record can tell which
  client acted. This is a limit the owner is asked to accept (plan,
  question 2).
- Merging this ADR answers none of the plan's owner questions 1–3, grants
  nothing and enables nothing: no Access application or policy, grant,
  `MCP_DELEGATIONS` entry, session length, authentication or production
  change.
- The ADRs of #564 and #565 are amended by reference here; those PRs should
  add a line pointing to this ADR when they next change.
- Stopped-execution lease release stays the operator's until the server can
  verify that an execution stopped.

## Verification

This ADR is a design record; its pull request changes documentation only.
The slices are verified by the tests the plan lists (section 8, the delegation
matrix of thirteen items), on synthetic data, with an independent review per
slice. Not verified: anything in production; no delegation, grant or Access
setting exists.
