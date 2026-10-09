# ADR 0060: Resume verification of an exact published Container

- Status: accepted (merged 2026-10-09 in #602)
- Date: 2026-10-09

## Context

Default-scheduling Container convergence can outlast the existing 180-second
postcheck. Republishing the same Worker and image on a failed-job rerun starts
another rollout. A control-plane snapshot observed later does not establish that
it belongs to the original publication, even when the image content is identical.

The serial GlobalPass, SBI Shinsei and St.George guards must continue to stop
later publication when a Container has not been verified. The normal release
still selects all seventeen Workers. Schema compatibility, exact source checkout,
trusted-workflow compatibility adapters and explicit rollback subsets remain
part of the release contract.

## Options considered

1. Increase or weaken the rollout deadline: changes the verification contract.
2. Publish everything before a separate verification job: moves later Workers
   ahead of existing Container guards.
3. Split every serial boundary into jobs: requires transfer of prepared build
   output and Docker images at each boundary, plus a lock and stale checks for
   every continuation.
4. Preserve the serial job and restore an immutable publication checkpoint on
   a rerun of that same run: separates publication from verification at each
   existing boundary without reordering downstream work.

## Decision

Adopt option 4. The called release job directly holds the non-cancellable
`production-deploy` concurrency group on every attempt. Forward and rollback
callers do not also hold the group, avoiding self-deadlock and ensuring selected
inner-job reruns acquire the same production interlock.

Before opening the deployment, save the original stamped configurations,
bundles, cf output, release manifest, plan, previous schema record, Container/DO
baselines and Docker image archives. The immutable deployment payload binds the
prepared artifact's exact ID and SHA-256 digest, run ID, original attempt, target
source SHA and trusted workflow SHA. The Container manifest and baseline hashes
are also bound. The archive contains no deployment record, avoiding a circular
artifact/record digest.

Immediately after each successful Container publication, capture a receipt:

- The native Action's returned Worker version UUID must equal the live single
  100% version. The admitted legacy Action has no version output; its explicit
  legacy path requires a single live version different from the original
  baseline under the same production lock.
- Read application versions and require exactly one new version beyond the
  original baseline. Its image must belong to the controlled namespace and app
  repository and its immutable registry manifest must resolve to the original
  Docker image-config digest. Missing or ambiguous targets are refused.
- Bind the exact application version/image and unchanged namespace identities
  to the receipt, together with original deployment ID, canonical payload hash,
  run/attempt identities and publication step outcomes.

The Action does not return a Container application version. Selection of the
unique new matching version therefore establishes provenance within the managed
release workflow and its production lock, rather than an atomic cross-resource
Cloudflare response. A privileged manual Container-only mutation between Action
completion and receipt capture could retain the same expected image and Worker
UUID while replacing that unique version; this timing race cannot be excluded.
The lock serializes managed releases, not privileged manual API actors. Prefer
an intended application version returned by the publication API if it becomes
available; never infer a target by adding one to the baseline version. Once
captured, the receipt rejects later Worker/application/image drift.

Upload the immutable receipt before waiting for convergence. Append a dedicated
`in_progress` deployment status containing its exact artifact ID/digest. A
checkpoint is an audit association with the original immutable payload, not a
successful release and not a new release-record type. Discovery reads only
those closed checkpoint descriptions on `in_progress` statuses, newest status
ID first. It refuses a completed release and any newer genuine release record,
including a newer failed or pending publication.

On a same-run rerun, download artifacts by exact ID. Metadata must match the
same run, unexpired state and bound digest. Recompute the downloaded ZIP's digest
and fail on mismatch before extraction; a warning is insufficient. The trusted
helper is fetched at the original workflow SHA before target checkout, including
its complete local import graph. Archive paths and descriptor-based regular-file
packing prevent uncontrolled extraction paths, symlink inputs and source path
swaps. Artifact and deployment IDs are positive safe numeric values at the
network boundary. Capture and postchecks re-read the authenticated registry
namespace and require equality to the original baseline before registry access.

Restore the original prepared bytes without rebuilding, pushing or redeploying
receipt-bound Containers. Loading saved Docker images onto a new runner first
requires matching original image IDs and input hashes. Record the restored
daemon identity only after those checks; the existing prepublication guard
then re-inspects image tags, inputs, cf output and that daemon. The ordinary
release manifest is recomputed against restored bytes before downstream upload.

Only receipt-bound Containers may skip publication. Ordinary Workers still
publish from the original prepared output in the original order, and schema
comparison/idempotent migration steps follow their original path. Saved ordinary
step successes do not prove current live version identity. Reporting merges
prior Container publication successes only; a current failed Container guard
always records that Container as failed.

Before any resumed migration or publication, re-read all originally selected
Container baselines. Bound ones must retain their receipt target; still-unpublished
ones must retain their original Worker/app version, immutable image and namespaces.
Verify the packed original DO identity/lifecycle snapshot too. Never recapture a
changed baseline as acceptable.

Every Container postcheck remains mandatory on resume. Every poll checks the
exact Worker UUID and rejects a newer application version or desired image
replacement. Success additionally requires the bound application version/image
to be the desired target, exactly 100% allocation, every other version at 0%,
no active rollout, unchanged app/namespace/default/APAC/basic/max-instance
settings and the original registry image-config digest. The polling deadline
remains 180 seconds. Health postchecks, DO lifecycle checks and schedule alarm
reconciliation still follow the final publication.

## Consequences

The operation remains nontransactional. A publication that fails before an
immutable checkpoint is bound cannot be adopted by guessing; a same-run rerun
refuses it. Runs created before this feature also have no checkpoint. Expired
artifacts, unknown API shapes, unchanged/no new application versions, ambiguous
versions and superseded releases require a new explicit normal release decision.
The feature does not manufacture a receipt for historical failed releases.

Prepared archives add CI storage and download/load time. Artifact retention is
the repository's normal retention policy. Reusing an artifact is a verified
transfer of the earlier credential-free build/validation result; production
credentials are never stored in artifacts. No collector is invoked to verify a
release. Hosted/live recovery remains separate from offline synthetic checks.

## Verification

Synthetic tests cover immutable binding/checksum failures, run/source/attempt
substitution, expired artifacts, all newer ledger states, exact Worker and
application supersession, ambiguity, old-version false success, the unchanged
180-second window, serial guard ordering, Container-only publication skips and
failure-safe progress merging. The ordinary release, rollback schema, registry,
DO and deployment-order guard suites remain applicable. Hosted CI exercises real
Docker builds; a controlled same-run recovery is required before claiming live
recovery verified.

## Amendment: bounded archive restoration (2026-10-09)

- Status: accepted (merged 2026-10-09 in #614)

Node's hash backend rejects a single update larger than INT_MAX. Whole-buffer
ZIP hashing therefore cannot verify a prepared archive above 2 GiB, independent
of available memory. Keeping the ZIP, extracted tar and two copies of the Docker
archive also unnecessarily multiplies runner disk usage.

Download into a uniquely created private directory, with a mode-0600 quarantine
file and at most 64 KiB per hash/write operation. Backpressure limits retained
bytes; an unexpected incoming chunk above 64 MiB is refused. Recompute the same
whole-ZIP SHA-256, then promote the closed file exclusively to `artifact.zip`.
No extraction or prepared-byte use is permitted before that comparison. Digest
failure or stream interruption removes this invocation's quarantine. A process
kill can leave private partial bytes, but cannot promote an incomplete ZIP.
Existing files and symlinks cannot be overwritten by promotion.

After successful ZIP extraction, delete the ZIP. After validated tar listing and
successful extraction, delete the tar. Move the extracted Docker archive within
RUNNER_TEMP before copying the remaining small prepared files, with no fallback
copy across filesystems. Delete that archive only after Docker load and the
original exact image ID and input-digest checks succeed. This leaves at most two
large archive representations during either extraction boundary. Identity,
ledger, immutable-artifact, baseline and 180-second convergence checks retain
their original contract.

Unexpected restore errors report only closed stage codes; signed URLs, tokens,
raw filesystem errors and command stderr are not printed. CI adds a mandatory
native Node check that writes and hashes 2 GiB plus 64 KiB through the same
streaming path, checks an independently calculated SHA-256 and file size, and
requires peak RSS below 256 MiB. It has its own two-minute timeout and runs before
resource-heavy repository checks; existing test deadlines are unchanged. Small
synthetic tests cover quarantine lifecycle, interruption, tamper, exclusive
promotion, staging reuse, oversized chunks, native/legacy restoration and the
unchanged image proof. This does not establish live recovery success.
