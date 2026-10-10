# Experiment: direct Container API verification

- Owner: risu729
- Started: 2026-10-05
- Expires: 2026-10-13
- Status: Run 38017948414 at 0441c1df failed the first SDK baseline POST /initialize with an unmarked HTTP 404 after authenticated GET /state readiness. Runtime cleanup and independent Worker/application/namespace absence checks passed. The 404 cause remains unclassified; SDK startup diagnosis and later acceptance stages were not reached.

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
