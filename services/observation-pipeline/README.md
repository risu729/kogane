# Production observations

This private Worker turns sealed, successful financial Layer A artifacts into
versioned Layer B observations in the existing `kogane-raw-evidence` D1 database.
It imports the deterministic parser registry directly; it never imports the
PoC SQLite store. All 12 existing collector sources retain their source-specific
parser contracts, duplicate identities and provider evidence locators.

Apply additive raw-evidence migration `0017_observation_pipeline.sql` before
deployment. The Worker has no public workers.dev endpoint or route. The protected
evidence browser reads the projection views and retains the existing complete
snapshot and pagination queries, including empty successful snapshots.

Every five minutes, the Worker scans at most 200 artifact IDs and processes 12
ready jobs. A persisted cursor wraps after reaching the current catalogue end,
so runs sealed late and new parser versions are eventually discovered. Jobs are
unique per artifact/parser/version. Failed attempts remain in `parse_runs`.
Transient errors retry with exponential delay up to five attempts; deterministic
parser rejections fail immediately and remain visible for operator inspection.
New parser versions create new jobs; obsolete pending versions are retired.
A ten-minute lease
guards concurrent runs; interrupted pending attempts are marked error on reclaim.

Raw objects must match both size and SHA-256. Reads are capped at 16 MiB; parsed
observations at 2 MiB per artifact, and each insertion chunk at 500 KB. Larger
artifacts fail with explicit bounded-resource codes rather than publishing a
partial financial snapshot. Current production raw artifacts are much smaller;
raising limits requires reassessing D1's invocation query budget.

Observation inserts remain hidden under a pending parse run. A final atomic D1
batch publishes success, supersedes the older parser version and completes the
job. A parser failure never supersedes existing observations. Metadata and all
observation rows are append-only; original raw artifacts remain authoritative.
Publication compares numeric major/minor/patch versions: a late older parse is
retained as superseded, never made current over a newer successful parse. Parser
versions must be three safe nonnegative integers, with no prerelease suffix.
MyJCB statement state and period come from the verified central manifest, whose
artifact ID is retained as metadata provenance.

## Operations

From this package, with the usual authorized Cloudflare environment:

```sh
node scripts/ops.ts status
node scripts/ops.ts catchup 100
node scripts/status.ts
```

Use the project's pinned Node runtime: Bun's remote proxy stalled in the local
rollout environment. `status.ts` emits only aggregate coverage/job counters.
The catchup command makes the requested bounded number of private service-binding
calls, at most 40 jobs per call. It does not deploy an ops Worker or expose a
local server. Inspect grouped job status after catchup; zero new jobs in one scan
page does not prove all history was scanned. Failed jobs require inspecting their
safe error code and artifact/parser/version, repairing the cause, then explicitly
resetting that exact job or deploying a corrected parser version.

Validation: `bun test`, `bun run typecheck`, and `bun run cf:check`. Runtime tests
use Miniflare D1/R2 with successful, empty, failed, missing/checksum, concurrent,
supersession, interrupted-attempt, and MyJCB metadata cases.
