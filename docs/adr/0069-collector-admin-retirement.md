# ADR 0069: Retire collector-local public admin bearer entrypoints in bounded slices

- Status: proposed (accepted when this PR merges)
- Date: 2026-10-10

## Context

Collector-local admin bearers bypass the common operation request, principal,
confirmation and audit boundaries. Ordinary collection already has a fixed-action
private Service Binding entrypoint, with the same schedule lease used by scheduled
execution. SMBC Direct instead has an existing human Access-protected UI and no
runtime admin-token consumer. A repository and caller audit identified 15
collector-local registrations: fourteen `ADMIN_TRIGGER_TOKEN` and SBI VC's
`ADMIN_TOKEN`.

The existing operation contract does not implement arbitrary date ranges,
individual cards, browser/container probes, supplied bank sessions, forced SBI VC
reauthentication or St.George saved-run resume. Removing a bearer is not permission
to publish its old handler without authentication. Nor is an operation request's
intent scope a new collector range override.

## Options considered

1. Keep all collector admin tokens: preserves duplicate, unaudited public control
   surfaces and unnecessary secret lifecycle work.
2. Remove bearer checks but keep public handlers: rejected; this grants anonymous
   callers collection, state inspection and credential operations.
3. Add a new shared token, Access application, JWT configuration, grant or
   credential transport: rejected; outside this retirement's authority.
4. Retire unused public operations, preserve current internal execution and
   existing human recovery, and split unresolved recovery consumers: selected.

## Decision

This first slice retires the admin bearer dependency in 13 collectors:
GLOBAL PASS, Vpass, MyJCB, SBI Securities, SBI Shinsei, Sony Bank, Mobile Suica,
Money Forward, V Point, Mizuho, PRESTIA Bank, V Point Pay and SMBC Direct.

Public trigger, individual-card, arbitrary-window, probe and credential-status
routes in these collectors return 404 regardless of bearer or forged Access
headers, before reading environment bindings. V Point Pay's previously disabled
trigger/probe/reset routes keep returning 410; app collection remains disabled.
Bare health behavior stays unchanged. GLOBAL PASS's existing egress diagnostic
and the existing authenticated relay routes are unchanged.

The ordinary private `ScheduledCollection.runOperation/runScheduled` contract,
source allowlist, lease and underlying collection are unchanged. There is no new
RPC method, public URL, permission, grant or agent capability. Module-only executor
exports let synthetic tests exercise the same execution functions without
retaining a test-only HTTP bypass; schedule entrypoints do not re-export those
functions as RPC methods.

SMBC Direct keeps its verified runtime Access context, per-identity state,
same-origin/action-header checks and encrypted-session UI. V Point keeps email
authentication completion, notification collection and forwarding. All provider
credentials, session encryption keys and GLOBAL PASS/Shinsei/St.George relay
tokens remain outside this retirement.

SBI VC and St.George are explicitly deferred. SBI VC forced human reauthentication
and St.George saved-run resume have necessary semantics absent from the current
operation RPC. A read-only owner audit of all 17 Access applications on 2026-10-10
found no exact/path/wildcard match for either collector hostname. This slice
therefore preserves their current authenticated routes and both admin tokens.
A later, independently reviewed design must use the existing App human operator
and audit boundary with narrowly scoped private RPC, without creating Access
configuration or expanding agent authority.

## Consequences

### St.George saved-only preparation amendment (2026-10-10)

`CollectionCoordinator.retryPending({ expectedRunId })` is a module-only internal
method, not a public route, Durable Object RPC, schedule or App/MCP operation.
It is not connected to production callers. The exact input is copied before the
first await; the existing UUID identifies the intended pending run, not an
authorized principal. No new UUID, provider callback, login, collection fallback,
credential read or authentication unblock occurs through this method.

The new path strictly decodes owned pending metadata: original UUID and attempt
UUID, canonical ordered timestamps, exact fields, and either a snapshot with
1–32 chunks or a known failure reason with zero chunks. It reads state and all
32 bounded chunk slots through a storage transaction handle. Snapshot bytes stay
bounded at 2 MiB, each nonempty chunk at 64 KiB, and pass fatal UTF-8, JSON and the
existing strict snapshot parser. Unexpected populated slots in that bounded
namespace are refused without deletion. Other run keys and indices outside
0–31 are not inspected, attributed to the run or deleted; this is not an orphan
cleanup or general storage-integrity scanner.

Persistence uses the existing writer outside any transaction, preserving the
original run/attempt/timestamps and snapshot. An incomplete/conflicting/thrown
write retains pending evidence. After a persisted or already-persisted terminal,
a new transaction rechecks every metadata field and every bounded slot byte for
byte against the selected evidence before cleanup. A changed state or chunk
refuses cleanup and preserves current evidence, even if the selected terminal
was saved meanwhile. Transaction replay cannot repeat external persistence.
Cleanup failure rolls back pending cleanup; retrying the same run can receive
`already_persisted` and finish. A saved failure terminal leaves an authentication
block, never a successful-collection result. Closed results expose no exception
text or financial data. The existing instance busy guard excludes trigger,
resume and retry while any one is active; transactional comparisons protect
cleanup across intervening durable-state changes, not external-write rollback.

Existing trigger and resume behavior is deliberately unchanged. Trigger can
start a fresh bank login when no pending state exists; resume refuses pending
state and can clear an authentication block. Neither is a saved-only substitute.
The private audited human recovery adapter, authorization, route/RPC wiring and
auth-unblock replacement still need separate design/review before retiring the
St.George admin secret. SBI VC forced reauthentication remains deferred too.

Synthetic tests cover both pending outcomes, restart/identity preservation,
strict refusal and byte limits, mutation during persistence, transaction-handle
use/replay/rollback, same-run idempotent completion, and all three busy paths.
Poisoned provider callbacks and UUID spies prove this method does not collect or
invent a new identity. These tests do not establish hosted or real-data recovery.

- Old trigger/backfill/admin-token synchronization scripts are removed, not
  silently pointed at a semantically different API.
- Arbitrary SBI/Sony ranges, Vpass card selection, GLOBAL PASS backfill/probes,
  Mobile Suica as-of/probes and Mizuho supplied-session injection are retired.
  Fixed-action collection is not claimed as an equivalent replacement.
- Configuration, hand-authored environment types, generated resource ledgers and
  active operator documentation no longer require the 13 admin secrets.
- This code change does not delete remote or local secrets. Only the sole deploy
  owner may remove exact eligible registrations after deployed-code verification
  and zero dependency evidence. No bank login or provider experiment is part of
  this verification.
- Thirteen retired dependencies are not completion of the fifteen-secret goal.
  The two necessary recovery consumers remain tracked in the
  [retirement plan](../plans/2026-10-collector-admin-retirement.md).

## Verification

Synthetic public-route tests cover missing, wrong and formerly valid bearers,
forged Access headers, five HTTP methods and RPC-shaped paths with a poisoned
environment: no secret, DATA, DO, browser or provider binding can be read.
Collection persistence/diagnostic tests use module-only executors; the production
private RPC and schedule tests remain in their native suites. Relay bearer/target
restrictions and SMBC Access/origin guards are independently exercised.
Resource identity snapshots change only for removed required admin secrets;
Worker, R2, DO, tunnel and email identities do not change. Native workspace CI,
root guards, formatting and an independent reviewer gate publication.
