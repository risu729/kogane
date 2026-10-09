# Experiment: direct Container API verification

- Owner: risu729
- Started: 2026-10-05
- Expires: 2026-10-12
- Status: Run 37963677064 at 430691a6 failed the initial SDK concurrent POST gate with upstream HTTP 503, before the revised stream-release gate. Runtime cleanup and independent absence checks passed. The 503 cause remains unclassified. Reader-lifecycle parity, native, recovery and rollback remain unverified.

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
absence checks passed at 2026-10-10 01:20 JST. The renewed temporary token and
GitHub environment must be retired by 2026-10-10 02:45 JST; the experiment's
longer research expiry does not extend that authorization.

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

A separate GitHub environment and a dedicated scoped token isolate this check
from production credentials. The normal CI and production release never deploy
this experiment. The manual verification job requires explicit selection.

## Stop condition

After the reviewed hosted test, remove only its temporary application, Worker,
namespace and image tag, verify their absence and retire the temporary credential.
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
