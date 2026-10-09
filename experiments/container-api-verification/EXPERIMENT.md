# Experiment: direct Container API verification

- Owner: risu729
- Started: 2026-10-05
- Expires: 2026-10-12
- Status: Run 37915871908 reproduced public clean EOF while SDK/raw readers inside the DO both raised the expected error. Revised stream-error boundary awaits hosted verification; reader-lifecycle parity, native and rollback remain unverified.

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
