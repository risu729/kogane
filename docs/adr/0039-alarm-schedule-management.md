# ADR 0039: Alarm scheduling and public maintenance rules

Status: proposed until this PR merges; accepted upon merge
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

Status: proposed until this PR merges; accepted upon merge
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
