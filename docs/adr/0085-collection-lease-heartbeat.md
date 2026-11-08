# ADR 0085: A collection execution lease proves its holder alive; the Processor frees a lease whose holder went silent

- Status: proposed
- Date: 2026-11-07
- Decided by: the owner, 2026-11-07 06:01 UTC (option C of the proposal in the
  "Fix stuck collection leases" thread)
- Carried by: `packages/collection/src/schedule-lease.ts`
  (`withCollectionLease`, `LEASE_TIMING`), CORE migration
  `0082_collection_lease_heartbeat.sql`,
  `services/processor/src/schedule-store.ts` (`expireStaleLeases`, called by
  `bootstrapSchedules` on every `processor-tick`),
  `packages/application/src/audit/automatic.ts` (`leaseExpiryWrite`),
  `packages/application/src/operation-path/catalogue.ts`
  (`alarm.lease.expire`),
  `services/processor/src/schedule-alarm.ts` and
  `services/processor/src/operations/dispatch.ts` (the uncertain outcome)
- Amends: [ADR 0039](0039-alarm-schedule-management.md) (a stopped execution's
  lease is released only by the operator), [ADR 0063](0063-delegated-ai-operation-path.md)
  ("until the server can verify that an execution stopped")
- Related: [ADR 0064](0064-common-audit-log.md) (audit record),
  [ADR 0048](0048-operation-collector-dispatch.md) (operations-API dispatch
  under the same lease), [schedules](../schedules.md)

## Context

Every collector runs a provider attempt inside `withCollectionLease`: one
conditional UPDATE claims `collection_execution_leases` for the source, and the
same invocation clears it in `finally`. ADR 0039 chose that a lease never
expires: "a process death leaves a lease blocked; only the operator, after
verifying that the previous execution stopped, may release that exact lease".
The reason was that a lease which expires on age alone could let a second
provider login start while the first execution is still alive.

In production that rule stopped two sources for weeks. `vpass` was held from
2026-10-12 21:00 UTC: its occurrence ended `uncertain` with no `finished_at`, so
the Processor alarm awaiting the collector stopped and the collector's
`finally` never ran. `sbi-vc-trade` was held from 2026-10-23 18:15 UTC: its
keepalive finished `collection_failed` 0.25 s after the claim. Every later
occurrence failed `collection_busy`, about 1390 for SBI VC, and nobody was
told. Both were cleared on 2026-11-07 with the owner's go-ahead.
[#1022](https://github.com/risu729/kogane/pull/1022) stops a live call from
leaking its lease on a failed D1 statement. It cannot help an execution that
stopped, because the server has no way to know that it stopped.

## Options considered

- **A. Keep the operator-only rule and show held leases on the attention
  list.** Simple, but a person must notice and press 停止した実行を解除 every
  time, for a fact the server can know.
- **B. Expire a lease on `started_at` age.** Age alone does not prove an
  execution stopped; a slow live one would be overtaken.
- **C. The holder proves it is alive, stops itself well inside a bound, and
  the Processor frees a lease that has gone silent** (chosen).

## Decision

1. **Heartbeat.** `collection_execution_leases` gains `heartbeat_at`
   (additive migration 0082). The claim writes it, and the holder rewrites it
   every 60 s while its action runs, with
   `WHERE source=? AND lease_ref=?`. Both times are taken on D1's clock
   (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), so the holder's isolate clock does
   not decide when its lease turns stale (item 4 compares the heartbeat with the
   isolate-written `started_at` only to tell an older build's claim apart).
   Every release clears it.
2. **The holder stops itself.** The action receives an `AbortSignal`. It is
   aborted:
   - 13 minutes after the claim (`collection_deadline_exceeded`), below the
     15-minute alarm limit, so a live alarm caller still records the outcome;
   - when a heartbeat finds the lease gone, released by the operator or freed
     by the tick (`collection_lease_lost`);
   - when no heartbeat has been written for 3 minutes (`collection_lease_lost`).
     The holder counts from the moment it sent the last heartbeat that was
     written, and checks every minute, so a heartbeat whose answer never comes
     counts as missing. A new heartbeat is sent every minute even while an
     earlier one is unanswered.

   Once the signal is aborted, both a fulfilled and a rejected action report
   that stop code. An action that settles during the grace period cannot turn
   a stopped collection into a successful occurrence.

   If the aborted action has not settled 30 s later, the call fails with that
   code and `forceStop` (given the code) ends the execution: the SBI VC session
   Durable Object resets itself with `ctx.abort(code)`, which fails its
   in-flight calls with the code as their error message, so its Worker still
   reports the code. A plain Worker call needs no hook: its call fails and its
   invocation ends. St George's collection Durable Object passes no hook: its
   call fails after the grace period while its container request runs on.
   **The heartbeat keeps running until the action itself settles**, so a lease
   is freed only once its execution went silent: a call that failed by force
   but whose action is still alive keeps its lease alive too. Once the action
   settled, nothing more is aborted or forced, so a heartbeat answered after the
   release stops nothing.

3. **Uncertain, never replayed.** Both codes mean the provider may already have
   been contacted. The alarm records the occurrence `uncertain` with that code,
   and an operations-API execution ends `uncertain` with it, exactly like a lost
   dispatch answer. Nothing replays it. St George is the exception: its
   coordinator turns every error of a collection into a failed run and keeps
   the stop as that run's reason (`deadline-exceeded`,
   `collection-interrupted`), so its occurrence ends `failed` with
   `st_george_deadline_exceeded` or `st_george_collection_interrupted`. The
   next scheduled run tries again (amended 2026-11-08: such a run no longer
   blocks the source; only a refused, challenged or unrecognised login does, see the
   [St George README](../../services/collector-st-george/README.md#configuration-and-operations)).
4. **The Processor frees a silent lease.** On every `processor-tick` (every
   5 minutes), next to the abandon sweep, `expireStaleLeases` frees each held
   lease whose `heartbeat_at` is older than 10 minutes. A lease claimed by a
   build without heartbeats (before migration 0082, or after a rollback) is
   freed when its `started_at` is older than 60 minutes: it has no heartbeat,
   or one older than its claim, left behind by an older build's release. For a
   claim by a build with heartbeats, a skew between the claiming isolate's clock
   (`started_at`) and D1's can only move its lease to this longer rule. An older
   build's claim under a leftover heartbeat is judged by the shorter rule only
   if its isolate clock lags D1 by more than the time between that heartbeat
   and the claim, which is at least the time until a person released the
   lease. The release names the exact reference it
   read and re-checks staleness in the same statement, so a heartbeat or an
   operator release that lands in between wins.
5. **Each release is recorded.** In the same batch, right after the UPDATE, an
   `applied` audit record: path `alarm`, principal `alarm:processor-tick` (kind
   `automatic`), operation `alarm.lease.expire`, risk class R2 (freeing a lease
   lets the next execution contact the provider), target
   `collection-lease:<source>`, scope the source, diff
   `{"kind":"release","released":true}`. It is written only when the UPDATE
   changed the row (`changes()=1`) and left the source unlocked. Like the
   operator's release it carries no lease reference and no time. The operation
   is a third Processor-only entry of `OPERATION_CATALOGUE`, beside ADR 0064's
   `alarm.occurrence.claim` and `lane.tick`: on the `alarm` path only, never a
   tool, and labelled on the audit page. No other audit vocabulary and no table
   changes.
6. **Collectors still claim only a free lease** (`lease_ref IS NULL`), and the
   operations API's lease check is unchanged: a silent lease blocks for at most
   one tick after it turns stale.
7. **The operator's release stays** as it is (R3, UI only); it now also clears
   `heartbeat_at`, and a live holder whose lease was released aborts within one
   heartbeat. Over MCP it stays refused as R3 (`operation_not_delegable`, ADR
   0084): the lease frees itself, so nothing is added to the MCP path.

The timing leaves margin: a live holder that cannot write stops itself after
3 minutes and its call fails by 3 minutes 30 seconds, at least 6 minutes 30
seconds before its lease can be called stale, and a live holder's call returns
within 13 minutes and 30 seconds while D1 answers its release (an action that
settles inside the grace period still waits for its release, at most three
attempts). Its lease stays held for as long as its action
runs and its heartbeat is written.

## Consequences

- A stopped execution no longer blocks its source until a person notices: the
  source is free again within 10 to 15 minutes, and the release is recorded.
- A collection that legitimately needs more than 13 minutes fails
  `collection_deadline_exceeded` (uncertain). The alarm path could never run
  longer than 15 minutes anyway.
- Only `vpass` checks the signal between provider steps today (once per card)
  and only the SBI VC keepalive passes it to its provider request; other
  collectors rely on the 30-second force stop and on the heartbeat following
  the action's real lifetime. Passing the signal further is follow-up work, not
  a safety gap: their leases stay held while their actions live and their
  heartbeats are written (the next limit is the exception).
- **Open limit: a holder that ignores its stop and cannot write.** When a
  holder's heartbeats fail for 10 minutes while the Processor still reaches D1,
  the lease is freed. The SBI VC object has reset itself by then; a plain Worker
  is assumed to have ended with its call; but an action that ignores the abort
  in an object without `forceStop` (St George) can still be running.
- **Open limit: container collectors** (GlobalPass, SBI Shinsei, St George).
  Whether a container keeps contacting the provider after the Worker that
  drives it died is not verified; if it does, the Worker's heartbeat stops with
  the Worker and the lease is freed while the container may still run. Their
  container servers' own time limits are to be checked in a follow-up.
- The token-gated HTTP routes of SBI VC and St George get the same deadline,
  since it lives in `withCollectionLease`.
- Deployment: the migration is applied before any Worker uploads, as for every
  CORE migration; an older collector writes no heartbeat, and its lease is
  judged by the 60-minute rule.

## Verification

- `packages/collection/test/schedule-lease.test.ts`: the heartbeat on D1's clock
  while the action runs and its end with the action; the deadline abort and its
  code, including the finite matrix of fulfilled and rejected actions before a
  stop and after either stop code; an action that ignores the abort is stopped
  by force and keeps its lease
  and heartbeat until it settles; a lost lease and a failing heartbeat abort
  with `collection_lease_lost` before the deadline, also when a heartbeat's
  answer never comes; `forceStop` receives the code; a heartbeat answered after
  the release stops nothing; the failed-statement cases of #1022.
- `services/processor/test/lease-expiry.test.ts` (Miniflare D1, every CORE
  migration): a silent lease and a legacy old lease are freed and recorded; a
  live and a young legacy lease are kept; freeing starts and replays nothing; a
  heartbeat that lands between the read and the release wins with no record; an
  operator release in between records nothing although the source is unlocked,
  so `changes()` in the record's statement is the release's own; a claim by an
  older build under a heartbeat left behind is judged by its age; a live
  holder's heartbeat is written and cleared on real D1.
- `services/collector-st-george/test/worker-policy.test.ts`: a stop fails with
  its own reason and does not block the next run.
- That a Durable Object reset by `ctx.abort(code)` fails its in-flight call
  with `code` as the error message, and leaves the lease held with its
  heartbeat stopped, was checked on workerd during review with a throwaway
  test; no test in the repository pins it.
- `services/collector-sbi-vc-trade/worker-test/lease-stop.test.ts`: a keepalive
  stopped at its deadline rejects with `collection_deadline_exceeded`, records
  no failure in the session's health and frees its lease.
- `services/processor/test/schedule-alarm-review.test.ts` and
  `test/collector-dispatch.test.ts`: both codes end `uncertain` and are not
  dispatched again.
