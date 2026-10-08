# Experiment: direct Container API verification

- Owner: risu729
- Started: 2026-10-05
- Expires: 2026-10-12
- Status: hosted SDK baseline attempts in progress; native and rollback gates pending.

## Question

Can the production Container controller replace SDK 0.3.7 while preserving
30-second idle shutdown, long responses, restart behavior and the same Durable
Object storage through exact-version rollback?

## Scope

Use only the fixed temporary Worker `kogane-container-api-verification`, its
`VerificationContainer` class and one default/basic/APAC Container. Both source
variants deny outbound Internet access. The synthetic image has no bank code,
credentials or VPC binding. Every endpoint authenticates before DO lookup.
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
