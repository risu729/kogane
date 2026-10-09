# Container API synthetic verification

The latest completed SDK baseline attempt, run 37895813457 at `2c9ed3b1`,
failed the stream-error check before reader-lifetime, native and rollback phases.
Runtime equivalence remains unverified. Its owned resources, dedicated tokens
and GitHub environment were removed and absence was verified. Any new hosted
session requires its own reviewed temporary setup. Cleanup runs after each
attempt; failed or interrupted cleanup requires separate absence confirmation.

The SDK and native configs intentionally have the same Worker, exported class,
SQLite migration, binding, explicit app name, basic/APAC/max1 configuration and
Docker image. Only the Worker entrypoint and revision marker differ. The native
variant uses the actual shared ContainerController, with a thin adapter forcing
Internet access off. The labelled unmonitored comparison omits native monitor()
through that adapter; it does not represent the production monitor behavior.
The SDK also disables Internet access. The synthetic image has no dependencies,
outbound fetch, bank hostname, secrets or VPC binding. Its HTTP server uses a
finite 60-second socket idle timeout so the deliberate 35-second quiet windows
can complete. This is separate from the 30-second Container idle policy and
the driver's unchanged 120-second request deadline. Real loopback TCP tests
cover the delayed response and paused consumer.

The public Worker requires a separately approved HARNESS_KEY before any DO lookup.
It strips headers before the fixed named DO reaches the image. Configuration
contains no key. An empty key refuses every request. The driver accepts only the
fixed temporary Worker on a supplied workers.dev subdomain and uses manual
redirects; bearer credentials cannot follow an arbitrary host redirect.

## Approval and integration prerequisites

The current deployment token is scoped to seventeen existing Workers and cannot
create this Worker. Temporary creation, exact temporary Worker Admin scope,
Container application/registry write, SQLite namespace creation and eventual
cleanup must be separately reviewed. The driver needs only read access to the
temporary Worker version/bindings and Container application, plus its synthetic
endpoint key. No permission expansion, secret retrieval or deployment is built
into the driver. Account/application selectors are supplied after an approved
creation; they are never logged. Do not reuse bank or collector secrets.

The workspace is registered in the lockfile, CI task graph and resource ledger.
The CI workflow exposes an opt-in `container-verification` dispatch input and a
dedicated `container-api-verification` environment. Normal CI does not run the
remote job. Docker build and both dry-runs need hosted Docker, since local Docker
is absent. Synthetic/local tests are distinct from actual Container verification.

## Controlled sequence

After independent review and explicit temporary-resource approval, deploy SDK
wrangler.sdk.jsonc, set HARNESS_KEY without exposing it, and record the synthetic
app ID. Configure HARNESS_SUBDOMAIN, HARNESS_KEY, CLOUDFLARE_ACCOUNT_ID,
HARNESS_API_TOKEN and HARNESS_APPLICATION_ID in a protected runner; never print
them. The hosted job creates a unique mode-0700 temporary directory and shares its
path with the always-run cleanup step. The runner requires that owned private
directory, then invokes the driver once per HARNESS_PHASE with RUNNER_TEMP
pointing to it. State files use mode 0600 and reject symlinks and multiple links. baseline_sdk writes only
validated synthetic app ID, namespace ID and immutable image reference to
container-api-verification-baseline.json (mode 0600); later stages compare this
same baseline. It contains no credentials and is not printed or uploaded.
Before each phase, the runner verifies that the authenticated public state URL
serves the expected revision. This shares the existing 180-second deployment
readiness budget with control-plane rollout checks. The driver receives that
same absolute deadline for its first state read and bootstrap sentinel read.
Those readiness probes retry only unmarked public 404/503 responses and known
different revisions; each accepted state must pass the full schema and
exact-revision checks. Worker-owned authentication, revision and route errors
carry closed markers and fail immediately. Unknown or inconsistent error-response
metadata also fails immediately; response bodies and arbitrary headers are not
logged. The baseline initialization POST runs exactly once between them and
retains its existing 120-second request timeout; time spent there cannot reset
the readiness deadline. Later runtime state reads and all application POSTs
retain their single-request behavior. Readiness probes send no Container request.
The driver performs no deployment:

1. Deploy SDK with HARNESS_REVISION=baseline_sdk, then verify baseline_sdk.
2. Deploy native with HARNESS_REVISION=native and HARNESS_MONITOR=enabled;
   verify native.
3. Deploy native with HARNESS_REVISION=native_unmonitored and monitor disabled;
   verify native_unmonitored.
4. Run node driver.mjs recovery-hold in the background against that revision.
   Wait for the closed verification_recovery_stream_open marker. It holds one
   synthetic stream for at most five minutes. While it is active, deploy native
   with HARNESS_REVISION=native_recovered and monitor enabled, then verify
   native_recovered. Stop the holder with SIGTERM and await its exit.
5. Roll back to the exact original SDK Worker version at 100%, keeping the
   immutable application image unchanged; verify phase rollback_sdk. It expects
   the original baseline_sdk revision marker and exact baseline Worker version,
   as well as class/app/namespace/image and sentinels.
6. The runner deletes its application and waits for absence, deploys an empty
   teardown Worker with a `deleted_classes` migration, confirms namespace
   absence, deletes the fixed Worker and unique image tag, and checks absence.
   The workflow runs a separate cleanup step even after verification failure.
   Registry cleanup deletes only the owned image tag and verifies tag absence
   using the OCI manifest HEAD operation with a bounded 90-second wait;
   it does not run account-wide garbage collection or prove blob removal.
   Retire the temporary token and GitHub environment after resource readback.

`run-hosted.mjs` stops on any unsuccessful stage and attempts cleanup on failure.
It never translates a failed stage into runtime success. Forced runner
termination can prevent cleanup and requires separate absence confirmation. Worker,
class, application, binding, migration and image stay fixed. Each state wait is
bounded, and there is no application-request retry. Deployment flags, temporary
credentials, workflow/job permissions and cleanup are outside this driver.

Every phase verifies identity and persistent synthetic KV/SQL sentinels. All
phases except `native_recovered` also verify concurrent startup and POST counts,
a 35-second delayed response, a 40-second stream, and separate 36-second paused
reader resumption/cancellation checks at the SDK/native response boundary,
subsequent idle stop and explicit restart, stream failure, destroy/reallocation, SIGTERM,
nonzero exit and SDK alarm recreation where applicable. `native_recovered`
verifies the same still-running process after a revision switch. The harness
responses and driver reports contain closed codes, revisions,
status and counts. The Worker discards non-200 SDK response bodies/headers.
The original SDK may still write its own internal runtime error messages;
observability is disabled and no bank data, bearer key or API token reaches
that SDK/container request. No global SDK logging override changes the baseline.

The reader-lifetime gate uses an unpaced finite deterministic framed source
through `GET /reader-resume-check` and `GET /reader-cancel-check`. The internal
`/reader-lifetime` source contains 64 frames of 64 KiB each.
It reads the first returned bytes from the actual SDK/native Response inside the
DO, requires unread payload to remain, pauses for 36 seconds (at least 35
measured) without an activity lease, and checks running state before
any restart-capable Container request. One arm resumes, validates ordered bytes
and EOF, and releases the reader. A separate arm cancels after the pause. Both
must permit the normal idle stop under DO-only state observation and explicit
restart. Bounded per-request observation and cleanup stay within the 120-second
request ceiling. Public reports contain closed codes and finite counts, never
UUIDs, payload bytes or arbitrary diagnostic text.

The separate backpressure source still emits random 64 KiB chunks with a
4096-chunk cap, identity encoding and origin `no-transform`. The earlier public
pause reached that cap in run 37882808848, and the in-DO SDK pause reached it in
run 37884921868. Run 37888089319 reproduced the SDK failure, then its separate
comparison observed both SDK and direct `ctx.container.getTcpPort(8080).fetch()`
reaching the cap on the same process: early counts 421 and 336, late counts 4096,
first reads 1888 bytes, elapsed pauses 35000 ms, POST count 2 unchanged and
cancellation complete in both arms. Both source streams finished.

That comparison renewed SDK activity every ten seconds without Container
traffic, preventing raw transport from stopping solely because it bypasses SDK
request tracking. Its report was conclusive for the bounded comparison, but
provides no idle or reader-lifetime proof. The plateau is not an observed
baseline property and is replaced as the acceptance criterion by the direct
reader-lifecycle checks above. Failed runs remain failures and did not advance
native/recovery/rollback. A finite upstream producer may finish before its body
is consumed, so a baseline `reader_process` failure would not by itself prove
that the buffered body cannot resume; that result requires separate
characterization. The original backpressure helpers and diagnostic route
remain available; they are not relabelled as passed tests.

Neither the replacement gate nor the comparison establishes upstream write
blocking, memory bounds, public-path backpressure, eviction or billing. Its
active DO invocation may itself keep the DO resident. Separate recovery and
exact-version rollback checks remain required.

The stream-error diagnostic keeps the source that emits 35 bytes at one-second
intervals and then errors. A local real-TCP check with Bun 1.4.2 and Node 26.11.1
clients observed the expected reader exception; the public hosted failure did
not distinguish an absent body from clean EOF at that revision. A separate
local workerd 1.20261001.1 probe read the expected 35-byte error inside the
Worker through both direct fetch and SDK-shaped IdentityTransformStream paths,
while both public HTTP responses ended at clean EOF. This suggests a measurement
boundary issue but does not establish hosted Container behavior. The follow-up
records that distinction and compares SDK and raw-port readers inside one DO,
under a diagnostic-only activity lease and bounded deadlines. It records closed
response/encoding/outcome categories and finite counts with running, process
identity, POST and stream-release checks. It changes neither the producer nor
the required reader-exception condition. The runner retains the failed stage,
attempts cleanup and never treats diagnostic success as phase success.

Idle observations are bounded process-state checks. They do not establish
billable runtime or DO eviction. Compare independently read aggregate billing
and lifecycle observations before asserting cost/timing equivalence. Collector
browser/relay compatibility and real old-source rollback remain separate gates.
The recovery helper records a synthetic process UUID in a protected ephemeral
file, never stdout. A held HTTP stream may disconnect during Worker replacement;
that alone is not failure. Recovery requires the same still-running synthetic
process UUID after redeploy. This does not assume an old HTTP response survives.

References:

- [OCI manifest existence checks](https://specs.opencontainers.org/distribution-spec/#checking-if-content-exists-in-the-registry)
- [Bun HTTP socket idle timeout](https://bun.sh/docs/runtime/http/server#idletimeout)
