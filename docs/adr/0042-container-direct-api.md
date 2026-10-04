# ADR 0042: Use the direct Container API with existing applications

- Status: proposed
- Date: 2026-10-05

## Context

GlobalPass, SBI Shinsei, and St.George currently extend `Container` from
`@cloudflare/containers`. Cloudflare will maintain this abstraction through
2026-12-31; existing deployments continue running afterward. The supported
replacement is a Durable Object using `ctx.container` directly.

All three existing applications use the default scheduling policy, the basic
instance size, APAC constraints, and maximum instance counts of 2, 2, and 1.
Their browser images use a local CONNECT proxy and authenticated WebSocket
relay through the Worker and its existing MESH/TAMIA VPC binding. The SDK's
outbound interception and scheduling helpers are not used by application code.

## Options considered

1. Keep the SDK until its maintenance ends. This postpones the lifecycle work.
2. Replace only the operation API, retaining existing applications and identity.
3. Also adopt `durable_object` scheduling. This requires new applications and DO
   namespaces, loses APAC constraints and the application-wide instance cap,
   and does not support the current basic instance size. It is a separate design.

## Decision

Choose option 2. Keep canonical Wrangler configuration, images, Worker names,
exported class names, DO bindings, migration tags, and named-object identities
unchanged. The API change adds no migration and performs no exports conversion.
GlobalPass keeps its fixed collection name; Shinsei and St.George keep run UUID
names. St.George's separate `StGeorgeCollectionState` and `SESSION_STATE`
namespace, persistent uncertainty, resume path, and leases are unchanged.

Each Container class now extends `DurableObject`. A controller in
`packages/collection` supplies the existing startup, fetch, stop, and destroy
RPC surface using the direct API. Concurrent startup calls share one promise.
After constructor recovery, allocation, inactivity-timeout configuration,
readiness GETs, and health-body cancellation share a hard 20-second deadline.
Each allocation/readiness await is bounded; a late result cannot resume a
canceled or timed-out startup. A late health response is canceled without
extending the deadline or affecting a newer process. The old SDK
used nominal 8-second allocation and 20-second readiness retry budgets; this
changes the allocation budget and bounds actual startup rather than reproducing
its retry-count timing. Application POSTs are sent
exactly once, even on a transport error. The health GET checks port 8080;
Internet access and each service's timezone remain unchanged.

Initialization uses the DO input gate to retire only the old SDK alarm and
reattach timeout/monitor to an already-running process. The Container-class
alarm handler also deletes this obsolete alarm. Neither SDK KV state nor the
`container_schedules` SQL table is modified or deleted. No alarm operation is
performed on St.George's collection-state class. Retaining the SDK state and
unchanged identity/configuration permits old-source rollback; the SDK
recreates its runtime alarm when that class starts again. Runtime rollback
continuity must still be verified before merging.

A separate monitor token prevents late results from an old process from
changing the new process's diagnostics. Readiness logs a start once per
observed process. SIGTERM is idempotent after a successful signal until the
next process starts; a failed signal remains retryable and never claims a
signal outcome. A failed
destroy reattaches monitoring when the same process remains running, without
reporting another start. Manual destroy logs the closed reason `destroyed`, with no invented exit code;
normal monitor completion and failures retain the observed native exit code.
Diagnostic callback failures cannot interrupt collection.

The existing collection callers retain their finally-destroy paths. HTTP body
consumption holds a promise on **DurableObjectState.waitUntil**, not the outer
Worker ExecutionContext. EOF, cancellation, and stream failure release that
promise. The long monitor has handlers but is not placed in this waitUntil.
A pending native monitor itself prevents eviction for up to 15 minutes,
regardless of waitUntil. Eviction and Container inactivity are separate; this
change does not claim identical idle timing or billing from mock tests.

## Consequences

This PR does not adopt the faster-start scheduling policy or filesystem
snapshots. It does not change Dockerfiles, browser/relay routing, secrets,
collection storage, production triggers, or deployment workflows. Native
operation semantics replace the SDK implementation, so real inactivity,
eviction, allocation-after-destroy, and old-source rollback remain runtime
verification gates. The direct API dependencies are already in the generated
Worker types from pinned Wrangler 4.146.0. The unused SDK dependencies are
removed from these three services.

## Verification

Focused tests cover shared startup, allocation/readiness retry without POST,
no application retry after failure, delayed/backpressured streams and cancellation/error
release, constructor recovery, alarm retirement, graceful stop, forced
teardown, bounded startup (including stalled timeout configuration and health
responses), old-monitor/new-process races, late startup completion behind a
destroy barrier, failed-destroy monitor recovery, and failed-signal retries. Existing
collection tests retain their failure/partial evidence, leases and teardown
contracts. Source typechecks cover the shared controller and three Workers. Lock updates
used `bun install --lockfile-only`; the automatic dependency check reported no
installed-package changes. Full checks are deferred while the shared host is busy.
The canonical configuration and Dockerfiles must be byte-identical to the
base revision; binding/namespace identity is therefore not changed by this PR.

Local Docker is unavailable (`docker: not found`). No real Container has been
built, run, uploaded or switched by this work. Mock tests do not prove native
idle timing, billable duration, Cloudflare allocation behavior, actual browser
network compatibility, or historical rollback continuity. Independent review,
full repository/hosted CI, and the following runtime checks remain required
before merge/deployment approval.

### Hosted synthetic verification plan

Use a separate temporary application and SQLite DO class, with synthetic-only
HTTP server image and no bank secrets, bank domains, or VPC bindings. Match the
current default/basic/APAC configuration. Authenticate the harness endpoint.
Keep one fixed named DO throughout the following test revisions:

1. Deploy the old SDK harness and write a synthetic KV/SQL sentinel. Record its
   DO namespace ID, application ID, and configuration. Trigger startup once.
2. Deploy the direct API harness with the **same** name/class/binding/image and
   migration tag. Confirm IDs and sentinels persist. Send concurrent requests;
   confirm one process startup and one POST per caller using closed counters.
3. Test a response delayed beyond 30 seconds and a backpressured stream lasting
   beyond 30 seconds. Neither may lose its process mid-response. Cancel and
   fail a stream; confirm eventual idle shutdown. With no requests, record idle
   stop timing and billable runtime, both with and without a pending monitor.
   Compare against the SDK harness; do not infer timing from DO eviction alone.
4. Redeploy during an active process and verify constructor recovery. Destroy
   and immediately allocate again. Retry only startup/readiness, never POST.
   Test SIGTERM, unexpected nonzero exit and forced destroy diagnostics.
5. Roll back to the exact old SDK revision using the same class/application.
   Confirm sentinels and identity, SDK alarm reinitialization, requests, idle
   stop, and teardown still work. Delete only the temporary app after review.

After those gates, deploy one actual collector without triggering a bank
login, verify IDs/config/image and health, then use the existing explicit
collection operation to verify browser/relay and persisted closed outcomes. GlobalPass probes have no
finally-destroy path and depend on idle shutdown; explicitly verify the
existing probe completes and its Container then stops without further requests.
Proceed to the other collectors only after the first is verified. Recheck
current main before rebasing: another GlobalPass migration may supersede this
collector. Merge and production operations are outside this draft's scope.

References:

- [API migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/)
- [Direct API and monitor semantics](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Scheduling policy migration constraints](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/)
- [SDK maintenance announcement](https://blog.cloudflare.com/faster-agent-sandboxes/)
