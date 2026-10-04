# ADR 0036: Observe covered D1 costs and failures per Processor lane

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-04

## Context

The invocation probe counted D1 statements/batches and R2 operations across a
whole cron or queue batch. It could not attribute cost or a rejected binding
call to a lane, and statement counts alone do not reveal scanned rows.
Existing tick records contain job outcomes but lack provider cost metadata.
D1 first/raw methods return row values and do not expose result metadata.

## Options considered

1. Persist every query or run additional cost queries: adds load, storage and
   privacy risk to the measurement itself.
2. Replace first/raw with all/run to expose metadata: changes binding
   semantics and executes a different API just to measure it.
3. Extend the transparent binding meter and aggregate only available numeric
   metadata at fixed invocation and stage scopes.

## Decision

Use option 3. Observe the original binding return value and Promise without
replacing them; forward original statements into batches and preserve bind,
session bookmarks, results and thrown/rejected error identity. Never retry a
query or change its API to collect metadata.

For all/run/batch, accumulate numeric rows_read, rows_written, duration and
total_attempts minus one. Each metric reports its covered subtotal (null
without any observation), covered statement count and missing statement count.
Validate nonnegative finite values, and integer counts. Never estimate rows
written from changes. first/raw, rejected calls and absent fields have missing
coverage. Returned success:false and rejected batches count failed statements;
a rejected batch reports no assumption about individually executed members.

Measure caller elapsed time for D1 and R2 calls, and elapsed stage time.
Scopes are the fourteen fixed scheduled stage names and one aggregate queue
notification stage. Record ran/failed/skipped counts and platform-limit counts.
Copy only known returned numeric failed/error/retried/deferred job counts,
closed status/outcome code counts, and boolean deferred tick counts. A stage
reporting enabled:false or status:skipped, or a queue result flag_off, is
skipped. Returned business refused/blocked outcomes stay distinct from lane
exceptions and binding rejections. Queue acknowledgement/retry counters count
successful message action calls.

Emit these bounded aggregates in the existing invocation_budget log line.
Keep tick auditing outside stage scopes but within invocation totals. Keep
registration budgets and tick persistence unchanged. Add no migration,
persistent cost row, query, cursor or private value to the logs.

## Consequences

Covered row subtotals identify high-cost stages only with coverage alongside
them. first/raw-heavy lanes can have substantial unmeasured cost; missing
metadata is explicit rather than reported as zero. A successful query may
report an observed zero. Caller elapsed time includes binding wait and can
overlap; it is not CPU or money. Provider retries are available only when D1
returns total_attempts; stage job retries and queue retries remain distinct.

These costs are Workers Logs only. An invocation killed by the platform may
emit no final line. Tick-record writes are unallocated overhead in invocation
totals. D1 exec, R2 multipart handle operations and body reads, fetch routes
and retry behavior without returned metadata are outside measurement. This
change does not establish production completeness, savings or a billing total.

## Verification

Synthetic tests check first/raw metadata refusal, per-field coverage and
explicit zero versus unknown; all/run and batch metadata; malformed metadata;
provider retries; sync and async errors; original Promise/result/error
identity; nested meters and original batch statements; D1 session bookmarks;
lane attribution, skipped flags, failure isolation and private-field exclusion;
and real Miniflare cron plus budget-deferred queue registration behavior.
Focused application/Processor typechecks and invocation-probe/registration/
lane tests use the repository's native mise environment.
