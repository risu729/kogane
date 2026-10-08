# ADR 0045: Use the direct Container API with existing applications

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
The latest completed attempt at commit `6d92b9b` stopped in the SDK baseline
with a closed HTTP error. Its application, namespace and Worker were removed;
registry readback disagreed between GET and HEAD. The runner now uses the OCI
manifest HEAD existence operation for both ownership and absence checks.
These attempts do not establish runtime equivalence. Final CI and the following
runtime gates are still pending:

1. Deploy SDK 0.3.7 with a fixed class/migration/image; seed synthetic KV and SQL
   sentinels and record application, namespace and exact Worker version.
2. Deploy the actual shared native controller on the same identity/image.
   Verify one startup for concurrent callers and one POST per caller.
3. Verify responses longer than 30 seconds, slow consumers/backpressure, cancel
   and stream failure. Observe idle stop with and without the native monitor.
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
