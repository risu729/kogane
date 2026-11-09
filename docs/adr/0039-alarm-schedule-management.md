# ADR 0039: Alarm scheduling and public maintenance rules

Status: accepted (merged 2026-10-04 in #430)
Date: 2026-10-04

## Context

Twelve daily collectors, SBI VC session maintenance and the Processor tick were
configured as Worker Cron triggers. Changing a time required a deployment,
maintenance windows were not centrally represented, and saved collection
history did not explain which scheduled occurrence produced a run.

## Options considered

Keep Cron plus a database gate; add an external scheduler; or use one SQLite
Durable Object alarm per job in the existing private Processor. A Cron gate
cannot execute immediately after a variable maintenance end without repeated
polling. A new scheduler adds another privileged deployment and identity.

## Decision

Use the Processor's ScheduleAlarm objects, the existing CORE D1 store and private
named collector RPC entrypoints. CORE 0065 seeds the existing times, fourteen
active jobs and two explicitly unsupported sources; migration alone arms nothing.
Cron arrays are empty. Collector RPC accepts only the job's historical trigger
shape, with the original nominal occurrence timestamp.

The operator edits strict, versioned schedule settings and public maintenance
rules through the App's existing Access and principal resolver. Agents and
service tokens cannot edit settings. Writes require same-origin JSON and a custom
header. A separately allowlisted deployment token may only reconcile reservations
through a bodyless bootstrap route after App/Processor release identities match.
It cannot request immediate collection or change configuration.

Maintenance revisions include an official URL, verification timestamp, timezone,
weekly/monthly/date pattern and explicit scope. Partial unrelated feature outages
do not block collection. Unknown windows are marked unknown. Research is a
reviewed snapshot, not automatic scraping; the operator updates it from official
announcements. Overlapping and adjacent windows are joined. A collection delayed
across several days runs once after the union ends, then resumes its next nominal
schedule. Times use the configured timezone; UI timestamps use Japan time.

Each occurrence is atomically claimed by (job, original nominal timestamp) before
provider contact, and the next alarm is reserved first. Provider uncertainty does
not trigger automatic replay/login. Shared D1 execution leases also guard manual
collection. A process death leaves a lease blocked; only the operator, after
verifying that the previous execution stopped, may release that exact lease.
Abandoned receipts become uncertain without replay. History links use exact
persisted run IDs, never the most recent unrelated collection.

## Consequences

Collectors' named RPC exports must exist before the Processor binds them. CD
uploads collectors, Processor and App in explicit dependency order; the existing
acquisition/terminal format is unchanged and remains compatible with the previous
Processor during the uploads. All health checks precede alarm bootstrap. First
activation waits at least twenty minutes, covering the documented fifteen-minute
Cron propagation interval. This is a deliberate transition gap. A partial release
may leave some sources without scheduling until recovery; no immediate catch-up
bank call is issued by deployment. Later bootstrap preserves operator settings
and nominal identity, and the processor tick repairs pending reservations.

Saved configuration and actual Durable Object reservation are reported separately.
A failed reservation RPC leaves a visible pending state. A disabled processor
tick cannot repair other pending objects until deployment/bootstrap or another
successful setting write reconciles them. Recovery of crashed collection leases
requires operator inspection; automatic expiry would allow duplicate provider
sessions. Dates not published in the researched official pages remain unknown.

## Verification

Synthetic model tests cover timezone/DST, overnight and nth-weekday maintenance,
union deferral and nominal occurrence preservation. Runtime tests cover unique
claiming, reservation ordering, uncertain dispatch, configuration changes and
lease overlap. App tests cover grants, service-token bootstrap isolation, release
matching, same-origin writes and body limits. Browser tests cover desktop/mobile
schedule editing and exact history links. Full repository and hosted CI verify
all collectors, schema/resource ledgers and deployment order. Production release
postchecks read back actual reservations without issuing a manual bank request.

Scheduling/storage failures reserve a one-minute bookkeeping wakeup rather than
exhausting only native alarm retries. Receipts still in `started` after one hour
are reported as uncertain; this neither expires leases nor repeats collection.

The trusted workflow refuses pre-alarm release/rollback targets before checkout
and before any production mutation. Removing the ScheduleAlarm class requires a
separate retirement migration; it is not an ordinary old-commit rollback.

## Amendment: repeated stopped-execution release

Status: accepted (merged 2026-10-09 in #566)
Date: 2026-10-09

A confirmed stopped-execution release can be resent after a lost response or a
second click. Previously its second request conflicted even though the first
request had already emptied the lease. Return the same successful result when
the existing source lease is empty, using one conditional UPDATE that accepts
either the requested reference or NULL. A different current reference, or a
missing lease row, still conflicts. Input confirmation, reference validation and
human-operator authorization are unchanged. No expiry or collection is added.

An alternative read-after-failed-update would separate the empty-state check
from the release statement. The single statement defines the result at the
write's serialization point and cannot clear a lease acquired under another
reference. An empty lease has no historical reference, so this is desired-state
idempotency, not proof that a particular previous request performed the release.

The UI takes a per-source synchronous guard before confirmation, disables the
button during submission and readback, and reads current state after either a
successful or failed response. Cancellation sends no write. A successful release
does not claim the source remains unlocked, since a new execution may acquire it
before readback. The result remains visible when its old lease disappears.

Verification covers concurrent duplicate releases, a later acquisition racing
an old retry, the new reference and start time remaining intact, rejected input,
confirmation cancellation, pending UI, successful and failed response readback,
and existing Access/operator/same-origin boundaries.

## Amendment: settings edits by a delegated principal (2026-10-09, ADR 0063)

Status: accepted (ADR 0063 merged 2026-10-09 in #601). Implemented in #660
(merged 2026-10-10) for `schedules.job.update` and
`schedules.maintenance.update` (`services/app/src/delegated-schedule-tools.ts`,
`services/app/src/delegated-maintenance-tools.ts`); `schedules.survey.decide`
has no delegated adapter. The committed `MCP_DELEGATIONS` is empty, so no
principal holds a delegation and no agent edits a setting.

[ADR 0063](0063-delegated-ai-operation-path.md) replaces "Agents and service
tokens cannot edit settings" with: settings are edited by the operator, or by
the owner's own MCP principal when the owner delegated it the setting's
capability (`schedules.job.update`, `schedules.maintenance.update`,
`schedules.survey.decide`), within its schedule-source scope, under the
operation's confirmation class, with an audit record
([ADR 0064](0064-common-audit-log.md)). Service tokens still edit nothing; the
bootstrap token still only reconciles reservations. Stopped-execution lease
release stays the operator's alone (class R3): only a person who checked the
execution can confirm it stopped. The operator routes keep their Access
operator check, same-origin JSON, settings header and body bound; a delegated
principal reaches the same writers through the MCP tools, never these routes.

## Amendment: a silent lease is freed by the Processor (2026-11-07, ADR 0085)

Status: proposed (ADR 0085)

[ADR 0085](0085-collection-lease-heartbeat.md) replaces "a process death leaves
a lease blocked; only the operator … may release that exact lease": a holder
writes a heartbeat on D1's clock while it runs and stops itself within 13
minutes, and the Processor's tick frees a lease whose heartbeat is 10 minutes
old, with an audit record. Uncertain occurrences are still never replayed, and
the operator's release is unchanged.

## Amendment: a durable pre-RPC dispatch marker (2026-11-08)

Status: proposed
Date: 2026-11-08

### Context and options considered

A claimed occurrence advances its next nominal before collector RPC. Previously,
any stop after that claim became uncertain after one hour, even when the call
never started. The owner selected option B on 2026-11-08 at 06:59 UTC in
[issue 1144](https://github.com/risu729/kogane/issues/1144): a durable D1 marker.
Option A keeps losing a collection day on a pre-call stop. Option C stores a
marker only in the alarm object, which the tick and shared read side cannot see.

### Decision

CORE migration 0085 adds `dispatch_protocol`, `dispatched_at`, `attempt_ref` and
`retry_claimed_at` to the operational occurrence table and admits the closed
`not_dispatched` status. The status CHECK requires replacing that table inside
the migration; every existing receipt and its outcome is copied unchanged.
No financial evidence or adopted state changes.

Only a new alarm claim explicitly opts into protocol 1. Historical rows and rows
claimed by an older deployed Processor default to protocol 0. An absent marker
on those rows proves nothing: abandonment still makes them `uncertain` with
`dispatch_uncertain`, never eligible for automatic replay. There is no automatic
historical proof backfill, even if old logs suggest a call did not happen.

Before any scheduled RPC the alarm awaits a conditional D1 marker UPDATE and
requires exactly one changed row: status `started`, protocol 1, its own attempt
reference, and no previous marker. Only after that acknowledgement does it call
the same collector entrypoint as before. Thus no marker on a protocol 1 attempt
proves that this attempt made no collector call. A marker can exist without a
call, including a lost D1 answer or a stop between the marker and RPC; this false
positive deliberately remains uncertain.

The one-hour abandonment scan uses the retry's claim time, when present. It
closes an unmarked protocol 1 attempt as `not_dispatched`; the unknown finish
time remains null. The next processor tick's reservation repair arms that job's
alarm for a retry, deferred by current maintenance. An alarm also checks for a
retry before its next normal nominal. Only enabled collection jobs retry.
The retry conditionally replaces the attempt reference and writes the immutable
`retry_claimed_at` in the same UPDATE. That UPDATE also requires the enabled
schedule, revision and next nominal reservation read before the alarm write;
a concurrent settings or reservation change consumes no retry and makes no call.
It consumes the single retry even if it
stops before its own marker. A delayed original cannot mark or dispatch under
the new reference; two retry handlers cannot both acquire ownership. Completion
also checks the attempt reference. A claim conflict leaves another owner's row
alone. Markers and consumed retry timestamps cannot be cleared.

The retry calls the normal collector `runScheduled` RPC with the original
nominal, hence uses the existing `withCollectionLease`, heartbeat and provider
limits. A retry racing the next nominal cannot overlap provider work for that
source. A busy lease or a present marker is never grounds for another replay.
The normal next reservation is set before retry claiming. A retry is the same
occurrence, so its existing once-per-occurrence accepted audit record remains
the claim record; the closed `retry_claimed` log and timestamp name the extra
attempt without adding provider text.

### Read surfaces and operations API

The schedules page displays `not_dispatched` as a pre-call stop and explains the
one-retry limit. Collection quality exposes the same status and a distinct
`occurrence_not_dispatched` reason, through its shared validated UI/MCP contract.
`kogane.schedules.read` already uses the same snapshot as the page; no new tool,
authority or operation is added.

Operations-API requests remain conservative under ADR 0048: their durable
`dispatched` claim already precedes RPC, and ambiguous dispatches become
uncertain without replay. They do not lose a daily schedule slot and have an
explicit request/operation history. This amendment adds no automatic request
retry and changes no operations-API state or permission. Adopting a recoverable
pre-RPC attempt protocol there would require its own request ownership and
once-only policy, rather than reusing schedule receipts.

### Consequences and verification

One safe retry can recover a new-protocol pre-call stop. Stops after a marker,
legacy claims, disabled jobs and a second pre-call stop remain unreplayed.
Migration rollout must precede code rollout; mixed old/new claims retain their
own protocol. Reverting code does not restore the old schema CHECK and cannot
turn an old unmarked claim into proof. The migration still requires the owner's
per-PR approval before merge. This PR neither deploys nor merges itself.

Synthetic D1/runtime tests cover a failed pre-RPC marker write, a call whose
completion is lost, an exhausted retry, a delayed original racing a retry and
the next alarm through the real lease, old-build claims, and an upgrade of an
existing started receipt. Shared-contract tests verify the distinct closed
reason with no fabricated terminal or provider payload.
