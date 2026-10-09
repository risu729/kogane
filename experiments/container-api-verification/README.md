# Container API synthetic verification

Hosted SDK baseline attempts are in progress. Native and rollback phases have
not completed, so runtime equivalence is still unverified. Cleanup runs after each
attempt; failed or interrupted cleanup requires separate absence confirmation. The dedicated token and GitHub environment remain until
the verification session closes.

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
a 35-second delayed response, a 40-second stream, and a 35-second paused consumer
at the SDK/native controller response boundary with a bounded 256 MiB upstream
cap and observed backpressure plateau,
cancellation, stream failure, eventual idle stop, destroy/reallocation, SIGTERM,
nonzero exit and SDK alarm recreation where applicable. `native_recovered`
verifies the same still-running process after a revision switch. The harness
responses and driver reports contain closed codes, revisions,
status and counts. The Worker discards non-200 SDK response bodies/headers.
The original SDK may still write its own internal runtime error messages;
observability is disabled and no bank data, bearer key or API token reaches
that SDK/container request. No global SDK logging override changes the baseline.

The backpressure source emits fresh random 64 KiB chunks and sets
`Cache-Control: no-transform` to avoid a zero-filled compression confounder.
The required `/backpressure-check` request pauses the response body returned by
the actual SDK `containerFetch` or native `ContainerController.fetch` inside the
synthetic DO. It preserves the 4096-chunk cap, one-second initial sample,
35-second plateau interval and lifetime/POST/process assertions. The process is
checked before every restart-capable stats request. A bounded internal deadline
and cancellation cleanup fit within the driver's existing 120-second request
ceiling. The public response contains only a strictly validated finite report;
no UUID, payload bytes or arbitrary diagnostic text is returned.

The earlier public-client pause requested identity encoding and rejected an
explicitly encoded response, but the SDK baseline still reached the 256 MiB cap
in run 37882808848. This remains an unresolved public-path observation, not a
passed gate. It does not identify which transport layer buffered the bytes.
The in-DO check removes outer Worker, edge and client buffers from the measured
boundary; it proves no end-to-end public backpressure, eviction or billing
claim. Its active DO invocation may itself keep the DO resident, which is why
separate Container running-state, idle, cancellation and recovery checks remain
required.

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
