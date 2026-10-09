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
confirmed Cloudflare defect, or permission to relabel the failed run. Hosted
same-DO comparison is still needed before revising the measurement boundary.

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

These attempts do not establish runtime equivalence. Final CI and the following
runtime gates are still pending:

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
