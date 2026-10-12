# ADR 0066: Use the direct Container API with existing applications

- Status: proposed
- Date: 2026-10-05

## Context

GlobalPass, SBI Shinsei and St.George extend `Container` from
`@cloudflare/containers`. Cloudflare maintains that abstraction through
2026-12-31 and recommends the direct Durable Object Container API for new work.
Existing deployments continue running after SDK maintenance ends.

The existing applications use the default scheduling policy, basic instance
size, APAC constraints and maximum instance counts of 2, 2 and 1. Their browser
images use a local CONNECT proxy and authenticated WebSocket relay through the
Worker's existing MESH/TAMIA VPC binding. Application code does not use the SDK's
outbound interception or scheduling helpers.

## Options considered

1. Retain SDK 0.3.7 until its maintenance ends.
2. Replace the operation API while preserving current applications and identity.
3. Also adopt `durable_object` scheduling. This requires new applications and DO
   namespaces, loses APAC constraints and the application-wide instance cap, and
   does not support the current basic instance size. It is a separate decision.

## Decision

Choose option 2. Preserve canonical production Wrangler/cf configuration,
Dockerfiles, Worker names, exported classes, bindings, migration tags and named
object identities. Add no production migration. GlobalPass keeps its fixed
collection name; Shinsei and St.George keep run UUID names. St.George's separate
`StGeorgeCollectionState`/`SESSION_STATE` namespace, leases, uncertainty and
resume behavior remain unchanged.

The three classes extend `DurableObject` and use a shared
`ContainerController`. Concurrent startup calls share a promise. After
constructor recovery, allocation, native timeout configuration, readiness GETs
on port 8080 and health-body cancellation share a hard 20-second deadline.
Only allocation/readiness are retried. Each application POST is forwarded once,
including on transport failure. Late startup and monitor results cannot alter a
new process or release an in-flight destroy barrier. Internet access and each
service's timezone are preserved.

### Idle lifetime

SDK 0.3.7 uses a wall-clock alarm to call SIGTERM after 30 seconds without an
in-flight request. `setInactivityTimeout(30_000)` alone is not equivalent: its
clock starts when the DO becomes inactive, and a pending native monitor can
prevent eviction for up to 15 minutes. This matters to GlobalPass probe paths
that do not explicitly destroy their Container.

The controller therefore retains the native timeout as a fallback and owns a
separate idle deadline and DO alarm. Startup and HTTP header/body consumption
are activity; the native monitor is not. EOF, cancellation and stream error
release activity. The alarm rechecks current activity and process generation
before requesting SIGTERM. A failed signal remains retryable. Destroy and
recovery preserve the barrier against old response/monitor completions.

The old SDK alarm is retired, but its KV values and `container_schedules` SQL
are preserved. Only a separate native idle key is owned by the new controller.
St.George's collection-state class receives no alarm operation. Exact SDK
version rollback must prove that its alarm resumes and both synthetic KV and
SQL state survive; source inspection alone does not establish this.

### Diagnostics and teardown

Normal monitor completion/failure reports observed native exit codes. Manual
destroy reports the closed `destroyed` reason without inventing an exit code.
A failed destroy restores monitoring and idle control if its process remains
running. Diagnostic callback failures cannot interrupt collection. Existing
collection callers retain their finally-destroy paths.

Response-body consumption holds a promise on DurableObjectState.waitUntil,
released on EOF/cancel/error. The long native monitor is not put in waitUntil.
The explicit idle alarm avoids relying on DO eviction to stop the process;
actual Container timing and resource usage still require hosted verification.

### Boundary of the hosted reader-lifetime check

The migration gate observes the response returned by the actual SDK
`containerFetch` or native `ContainerController.fetch` inside the synthetic
Durable Object. It uses an unpaced finite sequence of deterministic frames,
reads the first returned bytes and pauses for 36 seconds (at least 35 measured). There is no activity-renewal
lease and no producer delay intended to keep the request alive. The process
must still be running before any subsequent Container request can restart it.
Resuming must deliver all remaining frames in order and reach EOF. A separate
arm cancels after the pause. Both operations have bounded cleanup, followed by
DO-only observations of normal idle shutdown and explicit restart checks.

The earlier no-progress backpressure plateau was a proposed proxy for this
lifecycle contract, not an established property of the SDK baseline. Hosted
run 37888089319 observed both SDK and raw port readers exhausting the same
256 MiB source during a pause, even at the in-DO boundary. Its explicit
activity lease makes that comparison unsuitable as lifetime or idle evidence.
We retain the source, diagnostic and failed observations, and replace the
plateau acceptance condition with direct reader-lifecycle parity checks.
A changed test is not itself a pass: SDK, native, recovery and exact SDK-version
rollback must execute successfully under the new criterion before merge. A finite
producer may complete before its returned body is consumed; that body could
remain resumable after the process stops. Therefore a baseline `reader_process`
failure establishes only that the required process-lifetime condition was not
met. It is not evidence that the buffered reader is broken and requires separate
characterization before changing the criterion.

A successful check establishes only response lifetime, ordered resumption,
cancellation and subsequent idle behavior at this boundary. It does not prove
upstream write blocking, memory bounds, end-to-end public slow-consumer behavior,
DO eviction or billing equivalence. The invocation itself can keep the DO
resident. Bank/browser/VPC compatibility remains a separate limit.

## Consequences

This change does not adopt faster-start scheduling or snapshots. Production
images, browser/relay routing, secrets, collection storage and triggers are
unchanged. The native API types come from pinned Wrangler 4.146.0. The unused
SDK dependency is removed from the three production collectors and retained
only by the isolated verification experiment as its rollback baseline.

A temporary, authenticated synthetic Worker verifies behavior without bank
code, bank credentials or VPC bindings. Its Container denies outbound Internet
access. Its fixed identity, default/basic/APAC configuration and single-instance
cap are declared in `experiments/container-api-verification`. It is absent from
the production deployment order. Normal CI validates both configurations;
remote execution requires an explicitly selected manual job and a dedicated
GitHub environment/token, never production credentials.

The test runner owns only its fixed temporary Worker, application, namespace
and uniquely tagged image. It rejects pre-existing application/namespace state
and verifies cleanup. Registry cleanup deletes only the owned image tag, without
account-wide garbage collection or a claim of blob removal. Forced runner
termination can prevent cleanup; a failed
or interrupted job requires separate resource-absence confirmation. The
experiment's expiry and stop condition are recorded in its EXPERIMENT.md.

## Verification

Focused source tests cover bounded startup, no application retries, stream
lifetime, idle alarms, constructor recovery, stop/destroy failures and stale
process completions. Existing collector tests cover evidence, leases, teardown
and St.George persistence/resume. Shared package and Worker typechecks validate
the direct API integration. Production configuration and Dockerfiles must be
byte-identical to current main. Fresh independent review checks the final
controller, experiment and manual runner together.

The main-integration head `89d3a3ee614c2ff91e2dee73b2f37d3698ff671e` passed
[hosted CI](https://github.com/risu729/kogane/actions/runs/37259363263).
That result predates the idle-alarm correction and synthetic harness; it does
not validate those additions. Local Docker is unavailable. Hosted attempts have deployed the SDK baseline
and exposed harness defects; none has completed the native or rollback phases.
An attempt at commit `7cbff2d2`
([run 37823165303](https://github.com/risu729/kogane/actions/runs/37823165303))
passed SDK concurrent startup, a 35-second delayed response and a 40-second
stream, then failed `verification_backpressure_exhausted`: the bounded 256 MiB
source was exhausted while the reader was paused. DO running state and process
identity checks passed; the actual buffering or encoding cause remains unknown.
The subsequent test-only hardening emits random chunks, asks the public client
for identity encoding, sets origin `no-transform`, and rejects declared encoded
responses. It preserves the cap, sample timing and existing assertions. This
removes a compression confounder; it is not hosted evidence of a resolved cause.
A subsequent attempt at `5b902fe6`
([run 37880738165](https://github.com/risu729/kogane/actions/runs/37880738165))
failed a public state read with `verification_http_state_outer_not_found`
after readiness had succeeded. The diagnostic did not identify which state check
failed; this is not evidence of an SDK or Container failure. Attempt `6659814e`
([run 37882097799](https://github.com/risu729/kogane/actions/runs/37882097799))
passed the bootstrap state read, then failed the single initialization POST with
`verification_http_initialize_outer_not_found`, before Container startup. The
unmarked status alone does not distinguish a public routing response from the
Worker's own route rejection. The diagnostic follow-up assigns closed markers
to Worker-owned authentication, revision and route errors; malformed error metadata
fails closed, and marked errors are not retried as bootstrap propagation.
Attempt `a9cc3f6e`
([run 37882808848](https://github.com/risu729/kogane/actions/runs/37882808848))
passed initialization, concurrent startup, long delay and long stream, then
failed `verification_backpressure_exhausted_late` in the public-client pause.
The process remained running. This confirms the cap was reached despite the
compression controls; it does not establish a buffering cause.
Attempt `e8bf5e050`
([run 37884921868](https://github.com/risu729/kogane/actions/runs/37884921868))
also failed `verification_backpressure_exhausted_late` with the SDK response
reader paused inside the DO. The process was running, its identity matched,
and the count was below the cap at the early sample but reached the cap at the
late sample. The subsequent stream and POST assertions were not reached. This
is a failed controller-boundary gate. It removes the outer client path as a
sufficient explanation, but does not identify Bun, port transport, the SDK
wrapper or another buffering layer. It does not establish unbounded buffering.
The source, cap and timing remain unchanged; separate diagnostic observations
must not convert this failure into a pass or satisfy native/rollback gates.
The separate comparison repeats SDK and raw port reads under a diagnostic-only
SDK activity lease. Renewing the existing SDK idle deadline without Container
traffic makes raw transport observation possible across the 35-second pause;
this lease is absent from acceptance checks and provides no idle or lifetime
proof. Both comparisons retain the source, cap and timing limits.
The comparison at `7b97d481`
([run 37888089319](https://github.com/risu729/kogane/actions/runs/37888089319))
reproduced the original SDK gate failure and then completed both diagnostic
arms. Each read 1888 bytes first and paused for 35 seconds. The SDK source count
advanced from 421 to 4096 chunks; the raw port source count advanced from 336 to 4096. Both retained the same running process and unchanged POST count of 2,
finished their source streams and completed reader cancellation. The report
was conclusive for this bounded comparison under its explicit activity lease.
Thus the no-progress plateau is not an available baseline property of either
observed path. This does not identify which layer buffers, prove unbounded
memory, or provide reader-lifetime/idle evidence. The original gate still failed
and this run did not execute native, recovery or rollback verification.
All four cleanup checks passed for these attempts; separate API reads confirmed
Worker, application and namespace absence. The runner uses canonical OCI manifest HEAD for registry
ownership and absence, and shares the existing rollout deadline with public
HTTP readiness checks. Normal CI and CodeQL passed on the earlier reviewed
head `1f393a205`; current-head checks remain required.
The diagnostic follow-up preserved the original backpressure gate. The subsequent
reader-lifetime criterion observes DO-only process state before a request can
auto-restart a stopped process and retains the failed diagnostic evidence.
The integrated head `2c9ed3b1`
([run 37895813457](https://github.com/risu729/kogane/actions/runs/37895813457))
failed `verification_stream_failure` during the SDK baseline at
2026-10-09 06:55:13 UTC, before both reader-lifetime arms. The code at that
revision could not distinguish a missing public response body from clean EOF
without a reader exception. One Container instance was still running. Native,
recovery and rollback were not executed. All four owned resource cleanup checks
passed, separate API reads confirmed Worker/application/namespace absence, and
the temporary GitHub environment and all three verification tokens were retired.
Normal CI, CodeQL and the independent 117-test integration guard review passed;
these do not replace the failed runtime result.

A local loopback diagnostic with the unchanged synthetic source, Bun 1.4.2 server,
and Bun 1.4.2 and Node 26.11.1 clients returned HTTP 200 with a body. Each client
read 35 bytes in 35 reads and then received a reader exception at approximately
36 seconds. This does not reproduce the hosted failure or identify its cause.
In particular, it does not establish a Cloudflare defect from the public closed
failure code alone.

A separate local-only probe used Wrangler 4.146.0/workerd 1.20261001.1 with
the experiment's compatibility date and flags, no bindings, and the same Bun
source. Both a direct fetch response and an SDK-shaped IdentityTransformStream
response produced a reader exception when consumed inside the Worker after
35 bytes in 35 reads. Both public HTTP responses instead ended at clean EOF
after the same 35 bytes, approximately 36.4-36.5 seconds from request start.
The transformed path also logged the unhandled pipe rejection. This narrows
the public gate's interpretation: a public EOF need not mean the Worker-side
reader lost the source error. It is not a hosted Container API result, a
confirmed Cloudflare defect, or permission to relabel the failed run. The hosted
same-DO comparison below subsequently reproduced this boundary distinction.

The diagnostic follow-up distinguishes the original public response outcome
and separately compares SDK and raw port responses inside the same DO. It keeps
the source and request semantics unchanged. A diagnostic-only SDK activity lease
isolates the raw-port observation from SDK idle tracking; it provides no idle
or reader-lifetime evidence. Reports expose bounded counts and closed categories,
never process UUIDs, payloads or provider messages. Same-process and release
checks are prerequisites to a conclusive comparison. Failure, timeout or
incomplete cleanup makes the comparison inconclusive. Its result never replaces
the original acceptance failure or advances later phases. An SDK/raw difference
can narrow the next investigation, but is not by itself a vendor-confirmed bug.

The hosted comparison at `7d0e8bc6`
([run 37915871908](https://github.com/risu729/kogane/actions/runs/37915871908))
failed the original public gate with `verification_stream_failure_clean_eof`.
The public response had HTTP 200, a body, absent content encoding, 35 bytes in
35 reads and clean EOF after 36403 ms. Inside the same DO, both SDK and raw-port
responses had HTTP 200, a body, absent encoding and 35 bytes in 35 reads, then
raised reader errors after 36835 ms and 36663 ms respectively. Both arms retained
the same running process, POST count 2 and zero source streams after release.
The comparison was conclusive under its diagnostic activity lease. Cancellation
after the terminal error rejected in both arms; independent source statistics
confirmed release. All four cleanup checks passed, the separate cleanup step
found no remaining owned resources, and API reads confirmed Worker, application
and namespace absence. Native, recovery, rollback and the reader-lifetime arms
were not reached. The continuation was interrupted before a revised hosted run. After its
2026-10-09 23:00 JST authorization deadline, the unused replacement bootstrap
Worker, remaining temporary token and dedicated GitHub environment (including
its secret and variables) were retired. API/UI readback at 23:37 JST confirmed
Worker, application, namespace, environment and temporary-token absence.

This evidence justifies measuring stream-error propagation at the response
returned by actual SDK `containerFetch` or native `ContainerController.fetch`
inside the DO. It does not establish a Cloudflare defect or turn the earlier
public failure into success. The replacement acceptance check has no diagnostic
activity lease and leaves the producer unchanged. It requires HTTP 200, a body,
unencoded content, exactly 35 bytes, at least one read and a genuine reader error
at least 35 seconds after the stream request began. A deadline, outer abort,
early error, partial body, missing body or clean EOF fails. Running-state checks
before Container statistics prevent a restart from masking process loss;
same-process, unchanged POST count and released-stream checks remain required.
Observation and cancellation share the original 46-second request deadline.
Before the error arm and after terminal cleanup, a release-condition check may
poll a valid single owned stream for at most three seconds, with 100 ms spacing
and at most 31 samples. A count above one, stopped process, malformed response,
changed identity or changed POST count fails immediately. Every sample checks
running state before statistics; the first valid sample anchors identity and
POST count even when a stream is still releasing. The error arm runs once, and
its 35-second clock begins after the before-release check. No polling occurs
during the delayed error response. Persistent nonzero streams fail with a
closed before/after category and bounded state/count diagnostics. Waiting for
release never converts EOF, an abort or a deadline into a reader error.
The driver runs this check once per applicable phase and validates its closed
report. It does not add another public 36-second probe. The public route and
diagnostic remain available for characterization, outside phase acceptance.

Normal CI and CodeQL passed at `becff3cc`, which includes the current main
composition. After renewed authorization, the hosted attempt at that exact head
([run 37957689144](https://github.com/risu729/kogane/actions/runs/37957689144))
failed the SDK baseline with `verification_stream_check_streams`. The helper
used the same code for a nonzero stream count before and after its error arm,
so this result does not distinguish delayed release after the preceding public
reader cancellation from failed release after the producer error. At failure,
one instance was running and none had failed. Native, reader-lifetime, recovery
and rollback phases were not reached. All four runtime cleanup checks and the
separate cleanup step passed; independent API reads at 2026-10-10 01:20 JST
confirmed Worker, application and namespace absence. The temporary token and
dedicated environment were bounded by that renewed 02:45 JST stop deadline.

The reviewed release-condition hardening was published at `47f4da60`; its
single-stream wait remains bounded by three seconds / 31 samples and requires
unchanged running state, process identity and POST count on every sample. Main
`6e2fe858` was integrated in signed head `430691a6`; exact-head normal CI and
CodeQL passed. The hosted attempt at that head
([run 37963677064](https://github.com/risu729/kogane/actions/runs/37963677064))
failed the initial SDK concurrent POST gate at 2026-10-10 02:05:58 JST with
`verification_http_once_concurrency_upstream_unavailable` (upstream HTTP 503),
before the revised stream-release gate. Control-plane observation reported one
inactive instance, zero running instances and zero failed instances. All four
runtime cleanup checks and the separate cleanup step passed; independent API
reads at 02:09 JST confirmed Worker/application/namespace absence.

SDK 0.3.7 returns a fixed HTTP 503 response when its startup catches
`NoInstanceError`; it can also preserve an HTTP 503 returned by TCP fetch. The
recorded status cannot distinguish those branches or prove an allocation cause.
No retry, warm-up, lease or diagnostic can promote these failed or unreached
stages. That historical authorization was bounded by 02:45 JST.

A failure-only diagnostic classifies the existing SDK `POST /once` HTTP 503
response. It recognizes the pinned SDK's 337-byte literal only with complete
EOF, within 338 bytes / 338 read samples and one shared 1-second read/cleanup
budget. Only a closed category is retained; the primary upstream failure remains
unchanged. No additional request, readiness assertion or success promotion is
introduced. A literal match does not establish the underlying allocation cause.

On 2026-10-10, the user explicitly renewed the same three-role scoped
credential and dedicated GitHub environment through 2026-10-13 13:00 JST
(04:00 UTC); the replacement credential handoff was saved at
2026-10-10T02:20:51Z. Necessary reviewed re-verification may reuse this dedicated
credential within that window until the work is complete. Every successful or
failed attempt must still remove and independently verify absence of the owned
temporary Worker, application, namespace and image tag. Retire the credential
and GitHub environment when the work is complete or at the approved deadline,
whichever comes first. The research expiry is extended to 2026-10-13 for this
bounded re-verification; production, resource and role scope are unchanged.

Normal CI and CodeQL passed on `0441c1df` after integration of main
`f761630d` and the bounded authorization renewal. Its hosted attempt
([run 38017948414](https://github.com/risu729/kogane/actions/runs/38017948414))
failed the first SDK baseline `POST /initialize` at
2026-10-10T02:43:41.4629923Z with
`verification_http_initialize_outer_not_found`. Authenticated `GET /state`
readiness had passed; the HTTP 404 carried neither owned failure marker. Runtime
cleanup completed for four resources, and the separate always-run cleanup
passed with zero resources remaining. Independent API reads confirmed Worker,
application and namespace absence. The SDK startup
classifier, concurrency, reader, native, recovery and rollback gates were not
reached. A successful state GET and an unmarked 404 do not identify the response
source or establish a routing cause.

A header-only failure observation is added for that exact baseline initial
POST, canonical failure code, HTTP status and absence of both owned markers. It
retains only a closed documented `cf-error-type` value (1000, 1016, 1101, 1102,
521–526), missing/other, `cf-error-origin`/`cf-ray` presence booleans, closed
content-type category, response URL expected/other/absent and redirect boolean.
No response body, free header value or URL is retained. A separate mode-0600
artifact under the owned private directory uses synchronous O_EXCL first-writer
protection and strict validation. The runner emits it only for the matching
baseline primary failure; invalid or missing observations remain unavailable.
Asynchronous observation settlement and optional no-read response cancellation
waits share a fixed monotonic one-second budget; synchronous file persistence
cannot be preempted by that timer. Neither can replace the original 404. There
is no additional fetch, state GET, POST retry, warm-up or lease. The existing
SDK startup category observer and actual SDK/controller/producer stay unchanged.
Cloudflare's [error-header documentation](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-error-headers/),
updated 2026-04-23, describes Cloudflare-generated error pages. Missing headers
remain limited evidence; they cannot prove a non-Cloudflare cause.

The next hosted attempt, [run 38021681182](https://github.com/risu729/kogane/actions/runs/38021681182)
at signed head `d0d31f18` / tree `99c03cd8`, failed
`baseline_sdk_verify` with `verification_state_timeout` at
2026-10-10T03:52:33.1577022Z. No phase-complete report was emitted: zero
acceptance phases completed. The log did not identify the timeout substage;
neither the initialization-404 nor SDK-startup-503 category was reported.
The control-plane failure snapshot counted one running instance and zero in
the other closed state categories. Runtime cleanup completed for four
resources at 2026-10-10T03:53:34.685Z; the separate always-run cleanup passed
with zero remaining. Independent API reads confirmed Worker/application/
namespace absence. No later phase is promoted to success.

The same manual workflow's source Checks job separately failed the all-routes
CSP test in `experiments/observation-pipeline-local/test/production-browser.test.ts`:
immediately after `page.goto(..., { waitUntil: "networkidle" })`, its first
`h1.count()` assertion expected one element and observed zero. That browser
readiness failure is separate from the synthetic state timeout; no common
cause is established.

The browser test now waits at most ten seconds for its existing exact
single-heading and expected-body conditions after navigation, including the
provenance route. A synthetic deferred-metadata regression observes network
idle with no heading and requires readiness to remain false until metadata
is released. Removing only the new readiness wait makes that regression fail;
the restored final file passes nine tests / 174 assertions under the native
coverage wrapper with CI enabled. Existing CSP, API, content and request
assertions and the route test's 60-second deadline remain intact. This is
source-test readiness evidence; it does not resolve or classify the hosted
state timeout.

A failure-only state-wait observation now labels the four existing waits
`reader_resume_idle`, `reader_cancel_idle`, `signal_stop` and
`nonzero_exit_stop`. It projects only the last already-returned state into
running/alarm-presence bits and safe nonnegative startup, stop, error, signal
and exit counters. `startup` means SDK readiness callbacks or native start
callbacks according to the closed phase; it is not a new process-start claim.
No raw state, provider text, object identity, alarm deadline or private SDK
inflight count is retained. The minimal schema adds no required elapsed-time
or poll-count metadata.

The private mode-0600, at-most-1-KiB artifact uses synchronous O_EXCL
first-writer protection and strict validation. Invalid state or persistence
failure cannot replace `verification_state_timeout`. The runner reads it only
for that primary error at a matching verification phase; missing, malformed
or cross-phase records remain unavailable. The bootstrap readiness helper
can emit the same primary timeout without reaching these four waits, so an
absent record does not identify an idle or stop boundary. The existing
90-second wait, three-second polls, request order/count, predicate and late
response behavior remain unchanged. There is no extra GET, Container fetch,
POST retry, warm-up, lease or acceptance relaxation. SDK, native controller,
producer and timeout policies remain unchanged.

These attempts do not establish runtime equivalence or a Cloudflare defect.
The following hosted runtime gates remain pending:

1. Deploy SDK 0.3.7 with a fixed class/migration/image; seed synthetic KV and SQL
   sentinels and record application, namespace and exact Worker version.
2. Deploy the actual shared native controller on the same identity/image.
   Verify one startup for concurrent callers and one POST per caller.
3. Verify responses longer than 30 seconds, a paused consumer at the controller
   response boundary, cancellation and stream failure. Observe idle stop with and without the native monitor.
   Process-state timings are not billing evidence.
4. Redeploy during a bounded synthetic stream and verify process recovery;
   destroy and allocate again; test SIGTERM and nonzero exit diagnostics.
5. Restore the exact original SDK Worker version and verify its 100% allocation,
   sentinels, identity/image, requests, idle stop, alarm and teardown.
6. Remove only temporary resources and confirm absence. Record the actual
   production release separately after final review and merge.

No real bank collection, authenticated browser login or production rollback has
been performed for this API migration. Synthetic runtime evidence must not be
reported as proof of complete bank/browser/VPC behavior or billing equivalence.

References:

- [API migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/)
- [Direct API and monitor semantics](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Scheduling policy constraints](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/)
- [SDK maintenance announcement](https://blog.cloudflare.com/faster-agent-sandboxes/)

## Latest SDK baseline and native readiness result

[Hosted run 38023814368](https://github.com/risu729/kogane/actions/runs/38023814368)
used exact source 41aafd667842066dd6530561024b52f43e41d10f, tree
ae2aad299f3925a7132b206595226f0bb99be288. The SDK baseline completed
at 2026-10-10T04:28:11.7389877Z; reader resume/cancel idle observations were
30,388/30,382 ms and all baseline acceptance checks passed. Exactly one phase
completed. At 2026-10-10T04:31:15.1711082Z the runner failed
native_http_ready with verification_state_timeout; native_verify was
not entered. The existing result does not distinguish repeated unmarked
404/503, a validated older revision, or an unfinished response. Native,
recovery and rollback acceptance remain pending; the failure does not establish
a Cloudflare defect or runtime equivalence.

Cleanup reported four resources removed at 2026-10-10T04:32:19.1197763Z;
the separate always-run cleanup reported zero remaining at
2026-10-10T04:32:19.2099090Z. Independent Worker/application/namespace absence
checks returned zero. Source Checks, both processor shards and CI guards passed
on this source; those results are separate from the hosted failure and from
subsequent main integration.

Run 38031502897 at 904e40b6cec3fb6c2d115e41078e0542718ddb3c completed the SDK
baseline at 2026-10-10T06:41:59.642Z. At 2026-10-10T06:45:03.830Z it failed
native_http_ready with verification_state_timeout before native_verify. Its
closed observation reported validated_old_revision and baseline_sdk. Separate
private readbacks at 06:42:34 and 06:43:18 UTC recorded the native phase on the
100% active Worker version with the same HARNESS namespace and v1 migration.
That control-plane evidence and the completed SDK-shaped state response are
different observations; their disagreement does not establish which serving
Worker or Durable Object generation handled the public request.

Both state handlers return their environment revision, not a persisted
revision: storageState exposes only KV/SQL sentinel matches and alarm presence.
The native state schema always has starts; a validated baseline SDK state has
startCallbacks. The generated native configuration uses the absolute native
entrypoint, and its static import graph contains no SDK entrypoint or Container
class. These source checks exclude a configured SDK fallback or a persisted
sentinel as the revision source; they do not prove the uploaded bundle bytes
or identify the runtime cause. Cleanup removed four resources, the separate
cleanup readback reported zero remaining, and independent owned-resource checks
reported zero. Native, recovery and rollback runtime acceptance remain pending.

The failure-only readiness observation retains five closed fields: code, phase,
last completed response classification, observed DO revision, and outer Worker
revision. Classifications are none, unmarked 404, unmarked 503, or a strictly
validated older known revision. Only the older-revision classification permits
an observed DO revision value; it must differ from the expected revision, with
rollback expecting baseline SDK.

Only authenticated successful GET/state adds the closed
x-verification-worker-revision header from that Worker's HARNESS_REVISION.
A new Headers and Response preserve the existing body stream, status, status
text and other headers without a body read or tee. Other routes, application
POSTs, stream responses and existing failures retain their response behavior.
The timeout record maps missing or unrecognized outer markers to unknown; none
also requires unknown. It updates the outer marker atomically with the same
completed response classification and DO revision, after the existing body and
schema checks. A later unfinished request or body cannot replace any field in
that completed tuple.

The outer marker labels a Worker environment phase, not a Worker version UUID
or an acceptance condition. An outer native marker with a validated baseline
SDK body would distinguish an outer/DO revision disagreement from an older
outer marker, but neither result alone establishes the runtime cause. None
means no retryable response passed the existing classification checks and does
not identify a pending request's outcome.

The runner reads this private, exclusive-create record (at most 1 KiB) only
for an actual matching *_http_ready stage and primary state timeout. Missing
or invalid records report unavailable. The observer adds no request, body read,
POST, lease, retry, sleep or deadline change; synchronous persistence cannot
preempt timers, and its failure cannot replace the original primary error.
Driver bootstrap and later verification state waits remain separate. SDK,
native controller, producer and production configurations remain unchanged.
