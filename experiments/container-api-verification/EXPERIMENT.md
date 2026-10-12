# Experiment: direct Container API verification

- Owner: risu729
- Started: 2026-10-05
- Expires: 2026-10-13
- Status: Run 38031502897 at 904e40b6 passed the SDK baseline (one phase), then failed native_http_ready with verification_state_timeout and a validated baseline_sdk response before native_verify. Cleanup four resources, separate zero-remaining readback and independent absence checks passed. The outer Worker revision diagnostic is a source follow-up; native/recovery/rollback runtime acceptance remains pending.

## Question

Can the production Container controller replace SDK 0.3.7 while preserving
30-second idle shutdown, long responses, restart behavior and the same Durable
Object storage through exact-version rollback?

## Scope

Use only the fixed temporary Worker `kogane-container-api-verification`, its
`VerificationContainer` class and one default/basic/APAC Container. Both source
variants deny outbound Internet access. The synthetic image has no bank code,
credentials or VPC binding. Every endpoint authenticates before DO lookup.
The reader-lifetime gate observes the actual SDK/native response boundary inside
the DO with unpaced finite frames and no activity lease. Separate pause/resume
and pause/cancel checks must preserve the running process and permit normal
idle stop and restart after release. The earlier public and in-DO SDK pauses
exhausted 256 MiB. A conclusive SDK/raw comparison in run 37888089319 also
exhausted that cap on both paths under a diagnostic activity lease. Those
failed plateau observations remain recorded; they do not identify a buffering
layer or prove lifetime, idle behavior or memory bounds. The revised criterion
must pass on the actual hosted SDK and native implementations before merge.
Run 37895813457 stopped at the earlier public stream-error check. Local TCP
and workerd probes distinguished internal reader errors from public clean EOF.
Run 37915871908 reproduced that distinction in hosted Containers: public clean
EOF after 35 bytes, SDK and raw-port reader errors inside the same DO after
35 bytes and more than 35 seconds. The diagnostic retained process identity,
POST count and released source streams under its explicit activity lease.
The original acceptance stage remained failed and all owned resources were
cleaned up. This supports a measurement-boundary correction, not a Cloudflare
defect claim. The revised acceptance check reads the actual SDK/native response
inside the DO without a lease, requires the complete delayed error sequence,
rejects timeouts and aborts, and verifies process and stream release. It still
requires successful hosted execution. No diagnostic may promote failed or
unreached reader/native/recovery/rollback stages to success.
The renewed hosted attempt at `becff3cc` (run 37957689144) failed with
`verification_stream_check_streams` in the SDK baseline. One instance remained
running and none had failed; native and later stages were not reached. The same
error code covers before and after stream counts, so the failure does not yet
identify the release boundary. All runtime cleanup checks and independent API
absence checks passed at 2026-10-10 01:20 JST. That authorization bounded the temporary token and
GitHub environment by 2026-10-10 02:45 JST; the experiment's longer research
expiry did not extend that historical authorization.

After reviewed release-condition hardening and integration of main `6e2fe858`,
normal CI and CodeQL passed on `430691a6`. Run 37963677064 then failed the initial
SDK concurrent POST gate at 2026-10-10 02:05:58 JST with
`verification_http_once_concurrency_upstream_unavailable` (HTTP 503), before the
stream-release gate. Control-plane observation showed one inactive instance,
zero running instances and zero failed instances. All four runtime cleanup
checks and the separate cleanup step passed; independent API reads at 02:09 JST
confirmed Worker/application/namespace absence. SDK 0.3.7 has a fixed HTTP 503
response for `NoInstanceError`, and also preserves a TCP fetch response status;
status alone cannot identify the branch or establish a Cloudflare defect.

Normal CI and CodeQL passed at `0441c1df`. The next hosted attempt
(run 38017948414) failed its first SDK baseline `POST /initialize` at
2026-10-10T02:43:41.4629923Z with
`verification_http_initialize_outer_not_found`, an HTTP 404 lacking both owned
HTTP failure markers, after authenticated `GET /state` readiness. Runtime
cleanup completed for four resources, and the separate always-run cleanup
passed with zero resources remaining. Independent API reads confirmed
Worker/application/namespace absence. The existing SDK startup
classifier, concurrency, reader, native, recovery and rollback gates were not
reached. Neither successful state readiness nor absent owned markers locates
the source of the 404.

A failure-only header observation now retains closed categories from that same
baseline `POST /initialize` response only: the documented `cf-error-type`
whitelist or missing/other, `cf-error-origin` and `cf-ray` presence, a closed
content-type category, expected/other/absent response URL and redirect boolean.
No body or free header/URL value is read into the record. The private first
observation is written synchronously before preserving the original failure.
Asynchronous observation settlement and optional no-read response cancellation
waits share a fixed monotonic one-second budget; synchronous file persistence
cannot be preempted by that timer. Neither observation nor cancellation replaces
the original failure.
There is no additional request, retry, warm-up or activity lease. Cloudflare's
[error-header documentation](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-error-headers/)
describes its generated error pages; missing headers remain limited evidence
and cannot prove a non-Cloudflare cause or route failure.

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

A separate GitHub environment and a dedicated scoped token isolate this check
from production credentials. The normal CI and production release never deploy
this experiment. The manual verification job requires explicit selection.

On 2026-10-10, the user explicitly renewed the same three-role scoped
credential and dedicated GitHub environment through 2026-10-13 13:00 JST
(04:00 UTC). The replacement credential handoff was saved at
2026-10-10T02:20:51Z. This approval permits necessary reviewed re-verification
and reuse of that dedicated credential within the approved window, until the
work is complete. It does not expand resource, role or production scope.
The research expiry is extended to cover this bounded re-verification.

## Stop condition

After every successful or failed hosted attempt, remove only its temporary
application, Worker, namespace and image tag and verify their absence. The
dedicated credential and GitHub environment may remain for necessary reviewed
re-verification within the approved window. Retire both when the work is
complete or by 2026-10-13 13:00 JST (04:00 UTC), whichever comes first.
Image cleanup does not run account-wide registry garbage collection; underlying
blobs may remain until normal registry collection.
On failure retain closed diagnostics, stop the verification and confirm cleanup;
never declare a failed or skipped stage successful. A forcibly terminated runner
can prevent its cleanup step; resource absence must be read back separately.
Retire the experiment after the direct API rollout and rollback evidence are
recorded, or revisit its scope at expiry. Extending expiry requires a reason.

No runtime, billing or browser/VPC equivalence is established by source tests.
The approved production API migration preserves existing configuration and
source routing; this experiment never initiates a real collection.

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
