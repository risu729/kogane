# ADR 0046: Maintenance windows as a separately granted agent capability

Status: proposed until this PR merges; accepted upon merge
Date: 2026-10-08

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
2. **Maintenance changes as proposals the operator accepts.** The safest flow,
   but no maintenance proposal/acceptance path exists, and #560's completion
   condition is that the client itself saves and reads back the window. The
   re-survey line (#561) can add such a flow on top of the same writer
   (`decisionRef` below).
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
missing one) or create one under a writer-chosen id; refuses a revision that
lengthens the source's longest joined deferral past seven days
(`maintenance_deferral_too_long`, measured over dated windows at any date and
recurring windows within 92 days, so windows that chain without end are
refused; a revision that leaves an operator's longer window as it was is not);
and caps each principal at 30 revisions per rolling day
(`maintenance_write_budget_exceeded`, checked inside the INSERT).

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
not grant fields. The schedule model keeps its own Intl-based calendar
arithmetic; this change only caches its formatters.

Nothing changes in production until the owner adds a grant: `AGENT_API_GRANTS`
ships `""`. CORE 0067 must be applied before the Processor that writes the new
columns, which is the existing migration-first deploy order.

## Verification

Synthetic tests only. `packages/application/test/grants.test.ts`: vocabulary,
scope parsing and that no financial grant implies a schedule capability.
`packages/collection/test/schedule-review.test.ts`: the joined-deferral
measure, including windows that never end.
`services/processor/test/schedule-agent-maintenance.test.ts`, through the real
Processor under workerd with native Durable Object alarms: revisions with
actor and reason, readback of next run and armed reservation, a three-day
window followed by exactly one collection and no replay, stale revisions,
invalid timezone/pattern/period/reference/reason, cross-source rule ids, the
deferral bound, the budget, header separation, the store CHECK and the
importable writer's closed codes. `services/app/test/schedule-tools.test.ts`,
through the real App Worker wired to the Processor's route and alarm code:
publication by capability and flag, closed schemas, scope isolation without
leakage, refusals for read-only, financial and out-of-scope callers, a saved
revision with the verified principal and its readback, and the operator routes
still refusing agents and serving the operator. No production client, grant
or deployment was exercised.
