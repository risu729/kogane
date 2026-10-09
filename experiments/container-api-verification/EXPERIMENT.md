# Experiment: direct Container API verification

- Owner: risu729
- Started: 2026-10-05
- Expires: 2026-10-12
- Status: SDK stream-error gate failed in run 37895813457; bounded diagnostic follow-up in progress. Reader-lifecycle parity, native and rollback remain unverified.

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
Run 37895813457 stopped at the earlier public stream-error check. A local
real-TCP reproduction raised the expected reader error, so that observation
alone cannot locate the hosted failure. A local workerd comparison observed
reader errors inside the Worker but clean EOF over its public HTTP response
for both direct and SDK-shaped transformed streams. Hosted Container behavior
remains unverified. The follow-up compares SDK and raw-port
stream errors inside the same DO under a diagnostic-only activity lease, while
preserving the original gate result. No diagnostic may promote failed or
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
