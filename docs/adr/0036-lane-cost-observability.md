# ADR 0036: Observe covered D1 costs and failures per Processor lane

- Status: accepted (merged 2026-10-04 in #418)
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

## Amendment 2026-11-12: Observe platform-limit rejections before recovery

- Status: proposed
- Tracking: [recovered platform-limit observation](https://github.com/risu729/kogane/issues/1333)

### Context and options

The binding meter observes a rejected D1/R2 call even when a parse job or
registration recovers internally, but previously discarded its limit
classification. The existing `limitErrors` counts exceptions escaping a lane
or queue-message handler. Changing that field to count binding calls would
change its meaning, while adding classifiers to individual recovery catches
would duplicate policy and miss future recovery paths.

### Decision

Keep `limitErrors` unchanged and add `d1PlatformLimitCalls` and
`r2PlatformLimitCalls` to operation-meter summaries. Classify the original
rejection transiently at the shared binding observation boundary, passing
only a boolean to the settled observer. The shared classifier also supplies
the Processor's existing escaped-failure classification. Retain no Error,
message, SQL, key or provider field in a meter or log.

Count one classified rejected executing call, including a synchronous throw
or Promise rejection. A rejected D1 batch is one call; its existing failure
metric still counts N statements. Separate calls reusing the same Error are
separate rejected calls. First settlement wins; hostile thenable setup is
unavailable observation rather than a manufactured source rejection. Error
introspection is total and nonthrowing, including inaccessible or malformed
messages and revoked proxies, and preserves the original return, Promise and
exception identities.

Invocation, lane and registration meters observe their own overlapping
scopes once per call. Never sum those scopes or add escaped-failure
`limitErrors` to rejected-call counts. A binding rejection escaping a lane
can contribute one call and one existing lane failure without representing
two binding calls. Queue acknowledgement failures can contribute only the
existing lane count because they are outside the metered D1/R2 bindings.

No budget, reserve, query, retry, cursor, publication, authority, flag or
persistent tick contract changes. Registration's compact budget summary
retains its existing shape; invocation and lane summaries expose the new
counts. The [current D1 batch-limit contract](https://developers.cloudflare.com/d1/platform/limits/#batch-limits)
counts a batch as one invocation query. The retained per-statement threshold
comparison is conservative accounting, not proof of an enforced query limit
being exceeded.

### Consequences and verification

A normally returned lane can now report a classified platform refusal from
an internally recovered binding failure. Zero means no positively classified
observed rejection; it does not establish that every exception was
classifiable, that platform capacity remains, that collection succeeded, or
that an invocation killed before its final log was measured.
Existing platform-limit spellings remain a closed allowlist, and generic
binding failure and metadata-coverage counters retain their meanings.

Synthetic regressions use the actual `parseJob` / `executeParseJob` recovery
path and `collectionScan` registration recovery. They verify safe persisted
failure state, later job and stage progress, unchanged scan continuation,
old escaped-failure counts and invocation/lane rejected-call attribution.
Additional tests cover a rejected N-statement batch, D1 session methods,
nested meters, reused Error objects, exact return/Promise/error identities,
hostile error shapes and thenables, non-limit controls, outer catches and
queue acknowledgements. Error markers are absent from complete emitted logs
and summaries. These checks do not establish a production platform-limit
incident.
