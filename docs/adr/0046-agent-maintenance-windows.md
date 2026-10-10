# ADR 0046: Maintenance windows as a separately granted agent capability

Status: accepted (#564 merged on 2026-10-10 JST); the S3 execution amendment remains proposed until its integration PR merges
Date: 2026-10-08
Amended by: [ADR 0063](0063-delegated-ai-operation-path.md) item 8, as
[the amendment below](#amendment-a-delegated-operation-not-an-agent-grant-2026-10-09)
records (slice S4 of the
[AI operation path plan](../plans/2026-10-ai-operation-path.md)). The
Decision that follows is this ADR's first form; where the amendment differs,
the amendment is what the code does.

## Context

ADR 0039 gave the human operator versioned, provenance-carrying maintenance
edits through operator-only HTTP routes, and stated that agents and service
tokens cannot edit settings. Issue #560 asks for an AI client to update
maintenance windows under a limited permission, read back what was saved and
how the next collection was rescheduled, and be refused for conflicts,
out-of-scope sources and everything else — without weakening the operator
routes.

Neither existing authority fits. `OPERATOR_SUBJECTS` grades the human
operator, who may also edit job times, enable or disable jobs and release
execution leases. `AGENT_GRANTS` makes a subject a change-lifecycle agent that
may only propose. The agent-API vocabulary (`AGENT_API_GRANTS`) held three
financial read capabilities and one proposal capability, scoped by financial
sources and accounts.

## Options considered

1. **Admit agents to the operator routes.** Rejected: those routes also edit
   jobs and release leases, and their same-origin/header checks are browser
   protections, not a permission model for a remote client.
2. **Maintenance changes as proposals the operator accepts.** The safest flow.
   A proposal/acceptance path now exists for the Processor's own re-survey
   readings ([ADR 0050](0050-maintenance-survey-proposals.md), #561), through
   the same writer (`decisionRef` below), but #560's completion condition is
   that the client itself saves and reads back the window, which a proposal
   the operator later accepts does not meet; and the owner's direction of
   2026-10-09 (ADR 0063) is conditional direct application by a delegated
   principal, not proposal-only. Rejected for the client's own changes; the
   survey keeps its proposals.
3. **Reuse `scopes.sources`.** Rejected: it couples financial read scope with a
   settings write scope, and schedule source ids are a different namespace
   (`config/alarm-jobs.json`).
4. **New agent-API capabilities with their own source scope, through the
   Processor's existing settings service.** Chosen.

## Decision

**Vocabulary.** `AgentCapability` gains `schedules.read` and
`schedules.maintenance.update`. No financial capability implies either, they
imply none, and the update capability does not imply the read one. Job edits,
enable/disable, lease release and collection have no name in the vocabulary;
`packages/application/test/grants.test.ts` asserts that a grant naming one is
invalid. A grant's `scopes` gains an optional `scheduleSources` (a scope set of
source ids from `config/alarm-jobs.json`); absent means no source. A schedule
scope without a schedule capability reaches nothing.

**Tools.** `kogane.schedules.maintenance.read` and
`kogane.schedules.maintenance.update` are MCP tools on the existing `/mcp`
transport, graded by the agent-API grant like the financial tools, with no
`/api/agent/v1` route. They exist while `SCHEDULES_ENABLED` is on (otherwise
`unknown_tool`, as the settings routes are 404), and a tool is listed only to
a grant holding its capability; a call without it is `403 unauthorized`. Any
source outside `scheduleSources`, existing or not, is `403
source_not_granted`. Argument shapes are Zod schemas, published through
`z.toJSONSchema` and enforced with the same schema, as the operations tools do.

**One writer.** `writeMaintenanceRevision` in
`services/processor/src/schedule-store.ts` is the only code that appends a
maintenance revision. Its input is a source, a rule id (or `null` to create
under an id the writer chooses), the expected revision, the change (timezone,
pattern, enabled, scope), the provenance (reference URL, verified-at, optional
`decisionRef`), the actor (`operator` or `agent` with its verified id) and a
reason. It answers `ok` with the rule id, revision and whether reservations
were reconciled, or one closed code from `MAINTENANCE_WRITE_CODES`. The
operator route and the agent tool are adapters over it, so both are held to
the same field, timezone, period, reference-host and version checks. The App
relays agent calls to `/internal/schedules/agent/read` and
`/internal/schedules/agent/maintenance` with the principal in
`x-kogane-agent`; the Processor refuses a request carrying both that and the
operator header, and nothing else is reachable under the agent prefix.

**Agent-only limits.** For an `agent` actor the writer also requires a one-line
reason of 1-500 characters; lets it revise only an existing rule of the named
source (another source's rule is `maintenance_rule_not_found`, exactly like a
missing one) or create one under a writer-chosen id; refuses a revision after
which the source has a joined deferral longer than seven days that its rules
did not already cause (`maintenance_deferral_too_long`, measured per union from
up to seven days before the revision, over dated windows at any date and
recurring windows up to 92 days ahead, so windows that chain without end are
refused and a running window cannot be kept going by extending it; a revision
that leaves an operator's longer window as it was, or shortens it within its
span, is not refused, but a separate long window is, even while a longer one
exists elsewhere);
and caps each principal at 30 revisions per rolling day
(`maintenance_write_budget_exceeded`, checked inside the INSERT).

**Adopted when saved, not proposed.** An agent revision takes effect when it
is saved: it becomes the rule's current revision, which the alarm code reads at
the reconcile that follows, exactly like an operator's. Nothing proposes it
first and nothing accepts it afterwards; the agent tool has no `decisionRef`
argument, so `decision_ref` is `NULL` on every agent revision. That is this
decision, taken because #560, the owner's issue, sets as its completion
condition that the permitted AI client itself updates the target maintenance
time and reads back the saved state and the rescheduling; Option 2 is the
proposal flow it does not take. It supersedes ADR 0039's "agents and service
tokens cannot edit settings" for maintenance rules only: job settings,
enable/disable and lease release stay operator-only.

It is not an exception to the agent invariants as this repository states them.
INV07 (ADR 0001) concerns adopted economic state; a maintenance window decides
when a collector may contact a provider and changes no observation, relation,
decision or figure. "Agents never approve or commit a change" concerns the
change lifecycle: this path plans, approves and commits nothing, consults
neither `AGENT_GRANTS` nor `OPERATOR_SUBJECTS`, and `kogane.capabilities` still
reports `writes.adoption: false`. What bounds the write instead is the
capability and its source scope, the limits above, the provenance columns and
the append-only history; an operator undoes an agent revision with a further
revision.

**Provenance.** CORE 0067 adds `actor_kind`, `change_reason` and
`decision_ref` to `provider_maintenance_rules`. Revisions written before it
keep `NULL` ("not recorded"); a CHECK refuses an agent revision without a
reason. The append-only triggers of 0065 stay, so every correction is a new
revision. The operator route now records `actor_kind='operator'`. The
reference URL must be https on the source's already registered maintenance
host; it is stored, never fetched. A source with no registered reference
cannot take a rule from either path.

**Reads.** The read view queries only the requested, granted sources: the
registered reference; per schedule the original next occurrence, the saved
maintenance-adjusted due time, the actual alarm, `armed`/`pending`/`disabled`
and the latest receipt's outcome (no run or evidence ids); per rule up to 20
revisions with actor kind, reason and whether the caller wrote it. It never
returns another principal's identity or lease state. An update answers with
the same view of its source after the save.

**Revocation.** Remove the capability or the principal's entry from
`AGENT_API_GRANTS`, or set it to `""`: the tools disappear, or the transport
answers `403 agent_api_not_configured`. Revisions already written stay; they
are undone by a new revision.

**Unchanged.** The operator routes keep their Access-operator check,
same-origin JSON, `x-kogane-settings` header and 16 KiB bound; an agent grant
reaches none of them. A collection deferred across windows still runs once
after their union ends and then resumes its nominal schedule (ADR 0039),
whoever wrote the window. Identity comes from the agent API's verified
principal (#559); this decision adds no authentication.

## Consequences

`kogane.capabilities` reports `scopes.scheduleSources` and
`writes.maintenanceRules`. A granted agent can defer a source's collection by
up to seven days per joined window, or withdraw a window and let collection
run during it; each such revision is visible with its kind and reason on the
read tool and remains in the table. Like the operator path, an agent revision
confirms the source's reference status and replaces the reference URL's path
on the same host. Recurring windows beyond the 92-day horizon (a fifth-weekday
monthly rule) are not part of the bound, and the bound reads the source's
rules before the INSERT, so two concurrent revisions of different rules of
one source can each pass it; the budget limits how often, and both show on
the read tool. The bound and budget are constants,
not grant fields. A running union is measured from its start, at most seven days
back, so a window an agent records after it began counts the time before the
revision too, although it deferred nothing then. The operator's management page
shows each rule's current revision but not its actor kind or reason; those are
on the read tool and in the table. A principal named in `AGENT_API_GRANTS` is
recorded as `agent` whoever it is: that the principal is an agent and not a
person is the identity contract of #559, which this change does not check.
The schedule model keeps its own Intl-based calendar arithmetic; this change
only caches its formatters.

Nothing changes in production until the owner adds a grant: `AGENT_API_GRANTS`
ships `""`. CORE 0067 must be applied before the Processor that writes the new
columns, which is the existing migration-first deploy order.

## Verification

Synthetic tests only. `packages/application/test/grants.test.ts`: vocabulary,
scope parsing and that no financial grant implies a schedule capability.
`packages/collection/test/schedule-review.test.ts`: the joined-deferral
measure and its unions, including windows that never end.
`services/processor/test/schedule-agent-maintenance.test.ts`, through the real
Processor under workerd with native Durable Object alarms: revisions with
actor and reason, readback of next run and armed reservation, a three-day
window followed by exactly one collection and no replay, stale revisions,
invalid timezone/pattern/period/reference/reason, cross-source rule ids, the
deferral bound (including a separate or moved long window beside an
operator's longer one, and the extension of a running window), the budget,
header separation, the store CHECK and the importable writer's closed codes.
`services/app/test/schedule-tools.test.ts`, through the real App Worker wired
to the Processor's route and alarm code:
publication by capability and flag, closed schemas, scope isolation without
leakage, refusals for read-only, financial and out-of-scope callers, for an
empty or absent grant table, for the human operator (with operations on) and
for malformed arguments, none of which relays or writes anything, a saved
revision with the verified principal and its readback, and the operator routes
still refusing agents and serving the operator. No production client, grant
or deployment was exercised.

## Amendment: a delegated operation, not an agent grant (2026-10-09)

Status: accepted (#564 merged on 2026-10-10 JST). This section records the
S4 contract at that merge; the S3 execution amendment below supersedes its
statements about absent adapters, confirmation and separate budget batches.

The owner's direction of 2026-10-09 — conditional direct application by the
AI, and not anonymous-agent power
([ADR 0063](0063-delegated-ai-operation-path.md),
[plan](../plans/2026-10-ai-operation-path.md) sections 3, 4.6 and slice S4)
— re-shaped this decision before it merged. What #564 shipped:

- **Who may write.** `schedules.maintenance.update` is no longer an
  agent-API capability: `AGENT_CAPABILITIES` keeps `schedules.read` only, and
  a grant table naming the write is refused whole (`/mcp` answers
  `403 agent_api_not_configured`). The write is an operation the owner may
  delegate to their own MCP identity in `MCP_DELEGATIONS` (the `maintainer`
  role holds it), scoped by the delegation's `scheduleSources` inside the read
  grant's. The tool resolves the caller's delegation with #628's resolver,
  checks the capability, its closed argument schema and the delegation's
  scope, and then asks `delegationExecutionReadiness`, which answers
  `available: false` for every capability until slice S3 connects delegated
  execution (its audit record, the operation path and the Processor's
  delegation guards). So the tool is published to nobody, every call is
  refused with a closed code (`delegation_not_configured`,
  `delegation_misconfigured`, `delegation_not_yet_valid`,
  `delegation_expired`, `delegation_capability_denied`, `invalid_request`,
  `source_not_granted`, and last `delegation_execution_unavailable`), and no
  code relays a delegated write. The refusal code for a missing capability is
  #628's `delegation_capability_denied`, which the plan's matrix item 4 now
  names as well. It has no `/api/agent/v1` route: a browser
  session yields no delegation.
- **No bare agent.** The Processor's `/internal/schedules/agent/maintenance`
  route is removed; `/internal/schedules/agent/read` stays read-only and
  refuses a request carrying the operator header or a delegation reference.
  The writer's actor kinds are `operator` and `delegated` (an `mcp-client:`
  name only); there is no `agent` kind in the code or the table.
- **Closed reasons.** The free-text reason becomes a closed code,
  `MAINTENANCE_CHANGE_REASONS` (`packages/collection/src/schedule-model.ts`):
  a delegated principal chooses `official-notice-added`,
  `official-notice-changed`, `official-notice-withdrawn`, `outage-observed`,
  `owner-instructed` or `correction`; the operator's edit records
  `operator-edit`; an accepted survey proposal records
  `maintenance-survey-proposal-accepted` with its proposal as the decision
  reference (the only decision reference the writer accepts). The writer
  answers `invalid_reason` for anything else, in place of `reason_required`.
- **One writer, one batch, one record.** `writeMaintenanceRevision(env,
write, append)` stays the only code that writes a maintenance revision; it
  takes ADR 0050's `append` argument and sends the revision, its guarded
  provenance update and what the caller appends (the audit record of ADR
  0064, a survey acceptance row) as one D1 batch. The operator route and the
  survey route call it; the operator's record carries `reason_code`
  `operator-edit`. Both the read and the revision are catalogued operations
  (`OPERATION_CATALOGUE`): `schedules.maintenance.read` (R0, `agent-http` and
  `mcp`) and `schedules.maintenance.update` (`ui` and `mcp`; R1, and R3
  beyond the seven-day bound), and every call of either is recorded once
  through `executeOperation`.
- **Risk class and bounds.** A delegated revision is R1 inside the direct
  envelope: a source in the delegation's scope, a rule of that source or a
  new one, no joined deferral over seven days that its rules did not already
  cause, 30 revisions per principal per rolling day, a closed reason, a
  registered https reference host and the expected revision. Beyond the
  seven-day bound the writer refuses it (`maintenance_deferral_too_long`):
  it is R3 until the owner answers the plan's question 1, and the operator
  makes it in the UI. Its target class, R2 (prepare/confirm) up to a 31-day
  ceiling, is not usable: the writer's prepare and its trusted 31-day option
  exist (the contract below), but no confirm step does (slice S3), and a
  deferral longer than 31 days stays the operator's in every case.
- **Migration.** CORE 0067 never merged; it is renumbered CORE 0078, the
  next free number above main's 0077 (it was 0076 until #632 merged as 0077;
  numbered below an applied migration, it would have made the release
  workflow refuse a rollback to the commits between, see
  [rollout](../rollout.md#5-incident-controls-and-rollback); no file uses 0073,
  0074 or 0076) and rewritten: `actor_kind IN ('operator','delegated')`; a
  closed `change_reason` CHECK, required with every actor kind and
  `operator-edit` only for the operator; the partial index
  `maintenance_agent_writes` on `actor_kind='delegated'`, which the budget
  count reads inside the INSERT.
- **Reads.** The read tool is also served on
  `POST /api/agent/v1/schedules.maintenance.read`; one function answers both
  paths, so HTTP and MCP return the same object. Its `byCaller` marks the
  reader's own delegated revisions. `kogane.capabilities` no longer reports
  `writes.maintenanceRules`.

What this replaces above: the Vocabulary and Tools paragraphs' update
capability and its agent-API grant; the "Agent-only limits" (they hold for a
delegated principal, with a closed reason); "Adopted when saved, not
proposed" holds inside the direct envelope under a delegation, and its
statement that this path "is not an exception to the agent invariants" is
replaced by ADR 0063 item 12; Provenance's CORE 0067, its `agent` kind and
free-text reason; the Revocation paragraph (a delegated write is revoked by
the ways ADR 0063 item 11 lists); and the Consequences' agent grant and
`writes.maintenanceRules`, and their "`AGENT_API_GRANTS` ships `""`": since
#640 the committed configuration holds one entry, the owner's MCP reader,
which names no schedule capability. ADR 0039's amendment already states that settings
are edited by the operator, or by the owner's own MCP principal holding the
setting's capability once delegation exists.

**The writer's contract for S3** (owner-approved, the same day). Three
writer-side decisions give slice S3 a contract without executing anything:

- A delegated revision must carry `decisionRef`
  `delegated-audit:aud_<uuid>` — the audit record that authorizes it (ADR
  0064's `audit_id`), which S3 reserves before it calls the writer: the prepare
  record for an R2 confirm, the apply record for an R1 call. None, a survey
  reference or any other shape is `invalid_request`, so a delegated revision
  is never written without it; the column stores it whole. The operator's
  rules are unchanged.
- `prepareMaintenanceRevision(env, write, options?)` runs the write's
  validation chain and answers its codes, the rule's current revision, a
  deferral class (`within-7d`, `within-31d`, and for the operator only
  `beyond-31d`) and the remaining budget, writing nothing and drawing no
  random value; `currentMaintenanceRevision(db, ruleId)` is its
  current-revision read. The write runs the same chain again.
- `writeMaintenanceRevision` and `prepareMaintenanceRevision` take a trusted,
  in-process `options.deferralBound`: `"delegated-7d"` (default) or
  `"confirmed-31d"`, under which a delegated revision may leave a joined
  deferral up to 31 days and never longer. No request field, header, tool
  argument or grant sets it, and nothing passes `"confirmed-31d"` today; S3's
  R2 confirm handler is to, after verifying a confirm that references the
  prepare's audit record. The seven-day default, the operator (no bound), the
  budget inside the INSERT and the batch are unchanged.

Not done here, and why: delegated execution, the delegated audit record
(`principal_kind` `delegated` with a `delegation_ref`) and the reservation of
its id, the delegation's `budget.writesPerDay` count at the App chokepoint (a
separate atomic guard from the writer's own 30-a-day cap inside its INSERT,
not one transaction with it), and the confirm step are slice S3's; when the R2
path may first be used waits for the owner's answer to question 1. Until then
no delegated revision can be written outside a test.

Verification of the #564 slice at its merge (historical): synthetic only.
`services/processor/test/schedule-agent-maintenance.test.ts` exercises the
writer for a delegated principal directly (no route reaches it): revisions
with actor kind and closed reason, the readback of next run and armed
reservation, a three-day window followed by exactly one collection under
native alarms, the seven-day bound at its boundary (exactly seven days
accepted, one millisecond more refused), the existing deferral cases, the
budget and its query plan on the partial index without table statistics,
closed reasons and actor shapes, the closed decision reference per actor,
prepare ≡ write for every refusal code and both bounds on a fresh store per
case (prepare writes nothing and draws no random value), the deferral edges
7d, 7d+1ms, 31d and 31d+1ms under each bound, the option set by no request,
the CHECK and its list against the code, the
read route's refusals, and the batch both ways (an appended record that fails
leaves no revision; a revision that loses its version check inside the batch
leaves no record). `services/app/test/schedule-tools.test.ts`, through the
real App Worker and the Processor's route: HTTP and MCP reads answering the
same object, each recorded once; the update tool published to nobody and
refused under no, an invalid, an early, a late, a capability-less and a valid
delegation, in and out of scope, with nothing relayed, no revision, no
reference change and one record each; an agent grant naming the write refused
whole; the operator's edit recorded with its reason; and a deep scan of the
records and revisions for a token-shaped value and an amount. Not verified:
anything in production. No delegation exists; the committed configuration's
one agent-API grant (#640, the owner's MCP reader) names no schedule
capability, and no MCP client has called these tools.

## S3 maintenance execution and confirmation (2026-10-10)

Status: proposed until the integration PR merges. The implementation reuses
the reviewed S3/R2/jobs slices and #564's native writer. It was integrated
against main `f6fb5bdd`; #652's temporal refusal and #643's release guard are
preserved. The [integration plan](../plans/2026-10-mcp-maintenance-followups.md)
records the publication and activation boundaries. No grant or deployment is
implied by this implementation.

The closed MCP payload accepts `apply`, `prepare` and `confirm` plus an
idempotency key. R1 apply keeps the seven-day joined-deferral bound. R2
prepare validates with the trusted 31-day bound and records a capped,
expiring preparation; only a matching confirmation may use that bound to
write. A newly caused, moved or extended joined deferral over 31 days is
refused; pre-existing longer operator windows may remain unchanged or shorten.
A caller cannot supply `decisionRef`,
`deferralBound` or a rollback audit reference. The R1 rule references its
reserved effect audit id; the R2 rule references the verified preparation
audit id, and its effect record links the same preparation.

Current delegation capability and source scope are checked before looking
up a replay receipt. Exact retries return the original saved id/revision
without another writer call or alarm reconciliation. Changed payloads do not
reuse a receipt. Fresh writes revalidate at the private Processor adapter.
The common applied/accepted-effect audit count enforces the actual delegation's
`writesPerDay` across operation kinds and delegation-reference changes. It
shares one D1 batch with the native writer's 30-per-principal rolling-day cap,
revision guard, domain write and audit append; failure rolls back the batch.
Preparation reports the lesser remaining budget. It grants no authority by
itself.

The native writer captures the source's append-only revision count before
reading joined windows. Its delegated INSERT checks that count again inside
the batch, so concurrent edits to different rules cannot jointly exceed the
deferral bound. The count uses the existing covering maintenance source
index and scales with that source's history, not constant time. The immediate
provenance update also requires that INSERT to have changed a row, and the
append guard binds the decision reference: a same-millisecond losing retry
cannot replace a winner's official URL or append an effect.

The write result distinguishes `saved` from reconciliation `completed` or
`pending`; a replay returns reconciliation `null`. None asserts that a
reservation is armed. The maintenance read tool supplies the reservation and
next-run state. Audit rows keep digests, closed codes and references, not the
official URL or other provider text.

The tests use synthetic local D1 data and synthetic Access keys. They cover
signed MCP entry, revocation and scope-before-replay, both hard bounds,
prepare/effect linkage, shared daily budget, rollback, exact retries,
concurrent joined windows and losing-provenance writes. Production migration
state and real-client use were not checked. `MCP_DELEGATIONS` stays empty and
the committed MCP financial-reader grant receives no schedule authority.
S6 survey acceptance remains unavailable pending the separate owner decision;
no survey grammar, grants, Access, authentication or deployment is changed.
